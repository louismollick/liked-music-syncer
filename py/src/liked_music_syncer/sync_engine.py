from __future__ import annotations

import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from mediafile import Image, MediaFile
from yt_dlp import YoutubeDL
from yt_dlp.globals import all_plugins_loaded, plugin_dirs
from yt_dlp.plugins import load_all_plugins
from ytmusicapi import YTMusic
from ytmusicapi.auth.oauth import OAuthCredentials

from .auth import build_browser_auth_client
from .cover_art import make_square_cover
from .json_io import emit_event
from .models import SyncConfig, SyncItemState
from .templating import OutputLayout

RUN_LOG_ITEM_ID = "__run__"
RUN_LOG_SOURCE_VIDEO_ID = "__run__"


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(tz=UTC).isoformat()


def _slug(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def _log(
    run_id: str,
    item: SyncItemState,
    stage: str,
    level: str,
    event: str,
    message: str,
    context: dict[str, Any] | None = None,
) -> None:
    emit_event(
        {
            "type": "log",
            "run_id": run_id,
            "item_id": item.id,
            "source_video_id": item.source_video_id,
            "timestamp": _now_iso(),
            "level": level,
            "stage": stage,
            "event": event,
            "message": message,
            "context": context or {},
        }
    )


def _run_log(
    run_id: str,
    stage: str,
    level: str,
    event: str,
    message: str,
    context: dict[str, Any] | None = None,
) -> None:
    emit_event(
        {
            "type": "log",
            "run_id": run_id,
            "item_id": RUN_LOG_ITEM_ID,
            "source_video_id": RUN_LOG_SOURCE_VIDEO_ID,
            "timestamp": _now_iso(),
            "level": level,
            "stage": stage,
            "event": event,
            "message": message,
            "context": context or {},
        }
    )


def _emit_run_event(
    run_id: str,
    event: str,
    stage: str,
    message: str,
    total_count: int | None = None,
    context: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "type": "run",
        "event": event,
        "run_id": run_id,
        "stage": stage,
        "message": message,
    }
    if total_count is not None:
        payload["total_count"] = total_count
    if context:
        payload["context"] = context
    emit_event(payload)


def _emit_item(run_id: str, item: SyncItemState) -> None:
    emit_event(
        {
            "type": "item",
            "event": "upsert",
            "run_id": run_id,
            "item": item.as_event_payload(),
        }
    )


def _extract_tracks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = payload.get("tracks")
    if isinstance(tracks, list):
        return [track for track in tracks if isinstance(track, dict)]
    return []


def _string_list_names(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    names: list[str] = []
    for value in values:
        if isinstance(value, dict):
            name = value.get("name")
            if isinstance(name, str) and name:
                names.append(name)
    return names


def _pick_thumbnail(value: Any) -> str | None:
    if not isinstance(value, list):
        return None
    best: str | None = None
    best_area = -1
    for thumb in value:
        if isinstance(thumb, dict):
            url = thumb.get("url")
            width = int(thumb.get("width", 0) or 0)
            height = int(thumb.get("height", 0) or 0)
            if isinstance(url, str) and width * height >= best_area:
                best = url
                best_area = width * height
    return best


def _build_item(track: dict[str, Any], index: int) -> SyncItemState:
    video_id = str(track.get("videoId") or track.get("setVideoId") or _slug("source"))
    artists = _string_list_names(track.get("artists"))
    title = str(track.get("title") or f"Untitled {index}")
    artist = ", ".join(artists) if artists else str(track.get("artist") or "Unknown Artist")
    album_value = track.get("album")
    album_info: dict[str, Any]
    if isinstance(album_value, dict):
        album_info = album_value
    else:
        album_info = {}
    album = str(album_info.get("name") or "_Singles")
    return SyncItemState(
        id=_slug("item"),
        source_video_id=video_id,
        title=title,
        artist=artist,
        album=album,
        album_artist=artist,
        source_url=f"https://music.youtube.com/watch?v={video_id}",
        cover_art_url=_pick_thumbnail(track.get("thumbnails")),
        source_kind=str(track.get("likeStatus") or "liked_song"),
        video_type=str(track.get("videoType")) if track.get("videoType") else None,
    )


def _build_ytmusic_client(
    auth_mode: str,
    client_id: str,
    client_secret: str,
    token_json: str,
    browser_auth_input: str,
) -> YTMusic:
    if auth_mode == "browser_headers":
        return build_browser_auth_client(browser_auth_input)

    credentials = OAuthCredentials(client_id=client_id, client_secret=client_secret)
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as handle:
        handle.write(token_json)
        token_path = Path(handle.name)

    try:
        return YTMusic(str(token_path), oauth_credentials=credentials)
    finally:
        token_path.unlink(missing_ok=True)


def _parse_year(value: Any) -> int | None:
    try:
        year = int(value)
        return year if year > 0 else None
    except (TypeError, ValueError):
        return None


def _resolve_exact_catalog(ytmusic: YTMusic, item: SyncItemState) -> str | None:
    watch = ytmusic.get_watch_playlist(videoId=item.source_video_id, limit=1)
    if not isinstance(watch, dict):
        return None

    watch_tracks = _extract_tracks(watch)
    primary = watch_tracks[0] if watch_tracks else {}
    album_value = primary.get("album")
    album_info: dict[str, Any]
    if isinstance(album_value, dict):
        album_info = album_value
    else:
        album_info = {}
    album_id = album_info.get("id")

    item.selected_source_url = item.source_url
    item.metadata_matched = True
    item.title = str(primary.get("title") or item.title)
    artists = _string_list_names(primary.get("artists"))
    if artists:
        item.artist = ", ".join(artists)
        item.album_artist = item.artist
    item.cover_art_url = _pick_thumbnail(primary.get("thumbnails")) or item.cover_art_url

    lyrics_id = watch.get("lyrics")
    lyrics_browse_id = lyrics_id if isinstance(lyrics_id, str) else None

    if not album_id:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    album = ytmusic.get_album(str(album_id))
    if not isinstance(album, dict):
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    item.album = str(album.get("title") or item.album)
    album_artists = _string_list_names(album.get("artists"))
    if album_artists:
        item.album_artist = ", ".join(album_artists)

    year = _parse_year(album.get("year"))
    if year is not None:
        item.year = year
        item.date = str(year)

    album_tracks = _extract_tracks(album)
    item.track_total = len(album_tracks) or None

    for track_index, track in enumerate(album_tracks, start=1):
        if str(track.get("videoId")) == item.source_video_id:
            item.track_number = track_index
            track_title = track.get("title")
            if isinstance(track_title, str) and track_title:
                item.title = track_title
            break

    item.resolution_method = "album_exact"
    return lyrics_browse_id

def _configure_yt_dlp_plugins(config: SyncConfig) -> None:
    plugin_dir = config.yt_dlp_plugin_dir.strip()
    if plugin_dir and not Path(plugin_dir).is_dir():
        raise FileNotFoundError(f"yt-dlp plugin directory not found: {plugin_dir}")
    configured_dirs = ["default", plugin_dir] if plugin_dir else ["default"]

    if plugin_dirs.value != configured_dirs:
        plugin_dirs.value = configured_dirs
        all_plugins_loaded.value = False

    if not all_plugins_loaded.value:
        load_all_plugins()


def _build_yt_dlp_options(config: SyncConfig, *, skip_download: bool) -> dict[str, Any]:
    _configure_yt_dlp_plugins(config)
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": skip_download,
        "extractor_args": {
            "youtube": {
                "player_client": ["mweb", "default"],
            },
        },
    }
    if config.yt_dlp_po_token_base_url.strip():
        options["extractor_args"]["youtubepot-bgutilhttp"] = {
            "base_url": [config.yt_dlp_po_token_base_url.strip()],
        }
    return options


def _resolve_fallback_metadata(config: SyncConfig, item: SyncItemState) -> None:
    options = _build_yt_dlp_options(config, skip_download=True)
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(item.source_url, download=False)

    if isinstance(info, dict):
        item.title = str(info.get("track") or info.get("title") or item.title)
        fallback_artist = info.get("artist") or info.get("uploader")
        if isinstance(fallback_artist, str) and fallback_artist:
            item.artist = fallback_artist
            item.album_artist = fallback_artist
        fallback_album = info.get("album")
        if isinstance(fallback_album, str) and fallback_album:
            item.album = fallback_album
        thumbnail = info.get("thumbnail")
        if isinstance(thumbnail, str) and thumbnail:
            item.cover_art_url = thumbnail
        item.audio_codec = str(info.get("acodec")) if info.get("acodec") else None
    item.resolution_method = "yt_dlp_fallback"


def _musicbrainz_enrich(item: SyncItemState) -> None:
    query = {
        "query": f'recording:"{item.title}" AND artist:"{item.artist.split(",")[0]}"',
        "fmt": "json",
        "limit": "1",
    }
    response = httpx.get(
        "https://musicbrainz.org/ws/2/recording/",
        params=query,
        headers={"User-Agent": "liked-music-syncer/0.1.0"},
        timeout=10.0,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return
    recordings = payload.get("recordings")
    if not isinstance(recordings, list) or not recordings:
        return
    recording = recordings[0]
    if not isinstance(recording, dict):
        return
    score = int(recording.get("score", 0) or 0)
    if score < 90:
        return
    item.musicbrainz_matched = True
    release_list = recording.get("releases")
    if isinstance(release_list, list) and release_list:
        release = release_list[0]
        if isinstance(release, dict):
            date = release.get("date")
            if isinstance(date, str) and date:
                item.date = date
                if item.year is None:
                    item.year = _parse_year(date.split("-")[0])
            title = release.get("title")
            if isinstance(title, str) and title:
                item.album = title


def _format_lrc_line(start_ms: int, text: str) -> str:
    minutes = start_ms // 60000
    seconds = (start_ms % 60000) / 1000
    return f"[{minutes:02d}:{seconds:05.2f}]{text}"


def _resolve_lyrics(ytmusic: YTMusic, lyrics_browse_id: str | None) -> tuple[str | None, str | None]:
    if not lyrics_browse_id:
        return None, None
    payload = ytmusic.get_lyrics(lyrics_browse_id, timestamps=True)
    if not isinstance(payload, dict):
        return None, None

    source = payload.get("source")
    source_label = str(source) if isinstance(source, str) else "ytmusic"

    if payload.get("hasTimestamps") and isinstance(payload.get("lyrics"), list):
        lines = payload["lyrics"]
        rendered: list[str] = []
        for line in lines:
            start_ms = getattr(line, "start_time", None)
            text = getattr(line, "text", None)
            if isinstance(start_ms, int) and isinstance(text, str):
                rendered.append(_format_lrc_line(start_ms, text))
        if rendered:
            return "\n".join(rendered) + "\n", source_label

    lyrics = payload.get("lyrics")
    if isinstance(lyrics, str) and lyrics.strip():
        return lyrics.strip() + "\n", source_label
    return None, None


def _download_bytes(url: str) -> bytes:
    response = httpx.get(url, timeout=20.0)
    response.raise_for_status()
    return response.content


def _download_audio(
    config: SyncConfig,
    item: SyncItemState,
    temp_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    options = _build_yt_dlp_options(config, skip_download=False)
    options.update(
        {
            "format": "bestaudio/best",
            "outtmpl": str(temp_dir / "%(id)s.%(ext)s"),
        }
    )

    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(item.source_url, download=True)
        if not isinstance(info, dict):
            raise RuntimeError("yt-dlp did not return structured metadata.")
        prepared = Path(ydl.prepare_filename(info))
    return prepared, info


def _normalize_audio(input_path: Path, output_path: Path, ffmpeg_path: str, codec: str | None) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if input_path.suffix.lower() == ".m4a" and codec in {None, "aac"}:
        shutil.move(str(input_path), str(output_path))
        return

    command = [
        ffmpeg_path or "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-c:a",
        "aac",
        str(output_path),
    ]
    subprocess.run(command, check=True, capture_output=True)


def _write_media_tags(
    output_path: Path,
    item: SyncItemState,
    cover_bytes: bytes | None,
    lyrics_text: str | None,
) -> None:
    media = MediaFile(str(output_path))
    media.title = item.title
    media.artist = item.artist
    media.album = item.album
    media.albumartist = item.album_artist
    media.track = item.track_number
    media.tracktotal = item.track_total
    media.year = item.year
    media.comments = item.source_url
    if lyrics_text:
        media.lyrics = lyrics_text
    if cover_bytes:
        media.images = [Image(data=cover_bytes, mime_type="image/jpeg")]
    media.save()


def _copy_remote(config: SyncConfig, output_path: Path) -> None:
    if not config.remote_copy_enabled or not config.rclone_remote or not config.remote_music_root:
        return
    relative = output_path.relative_to(config.output_directory).as_posix()
    remote_target = f"{config.rclone_remote}:{config.remote_music_root.rstrip('/')}/{relative}"
    subprocess.run(["rclone", "copyto", str(output_path), remote_target], check=True, capture_output=True)


def run_sync(config: SyncConfig) -> None:
    stage = "ytmusic_auth"
    try:
        _run_log(
            config.run_id,
            stage,
            "info",
            "auth-init",
            "Initializing YT Music client.",
            {
                "output_directory": str(config.output_directory),
                "dry_run": config.dry_run,
                "remote_copy_enabled": config.remote_copy_enabled,
                "ytmusic_auth_mode": config.ytmusic_auth_mode,
                "write_lrc_sidecar": config.write_lrc_sidecar,
                "embed_unsynced_lyrics": config.embed_unsynced_lyrics,
            },
        )
        ytmusic = _build_ytmusic_client(
            config.ytmusic_auth_mode,
            config.ytmusic_client_id,
            config.ytmusic_client_secret,
            config.ytmusic_oauth_token_json,
            config.ytmusic_browser_auth,
        )
        _run_log(config.run_id, stage, "info", "auth-ready", "YT Music client ready.")

        stage = "liked_songs_fetch"
        _run_log(
            config.run_id,
            stage,
            "info",
            "liked-fetch-start",
            "Fetching liked songs from YT Music.",
            {"limit": 5000},
        )
        liked = ytmusic.get_liked_songs(limit=5000)
        tracks = _extract_tracks(liked if isinstance(liked, dict) else {})
        _run_log(
            config.run_id,
            stage,
            "info",
            "liked-fetch-complete",
            "Liked songs fetch complete.",
            {"total_count": len(tracks)},
        )
        _emit_run_event(
            config.run_id,
            "started",
            stage,
            "Liked songs fetch complete.",
            total_count=len(tracks),
        )

        layout = OutputLayout(
            folder_template=config.folder_template,
            file_template=config.file_template,
        )

        for index, track in enumerate(tracks, start=1):
            item = _build_item(track, index)
            item.stage = "liked_songs_fetch"
            item.status = "processing"
            _emit_item(config.run_id, item)
            _log(config.run_id, item, item.stage, "info", "fetch", "Fetched liked item.")

            try:
                item.stage = "source_resolve"
                lyrics_browse_id = _resolve_exact_catalog(ytmusic, item)
                _emit_item(config.run_id, item)
                _log(config.run_id, item, item.stage, "info", "resolve", f"Resolution method: {item.resolution_method}.")
            except Exception as exc:  # noqa: BLE001
                _log(config.run_id, item, "source_resolve", "warn", "resolve-fallback", str(exc))
                _resolve_fallback_metadata(config, item)
                _emit_item(config.run_id, item)
                lyrics_browse_id = None

            try:
                item.stage = "musicbrainz_enrich"
                _musicbrainz_enrich(item)
                _emit_item(config.run_id, item)
            except Exception as exc:  # noqa: BLE001
                _log(config.run_id, item, item.stage, "warn", "musicbrainz", str(exc))

            item.stage = "lyrics_resolve"
            lyrics_text, lyrics_source = _resolve_lyrics(ytmusic, lyrics_browse_id)
            if lyrics_text:
                item.lyrics_matched = True
                item.lyrics_source = lyrics_source
            _emit_item(config.run_id, item)

            context = {
                "albumartist": item.album_artist,
                "album": item.album,
                "track": item.track_number or index,
                "title": item.title,
                "artist": item.artist,
            }
            output_path = layout.build_path(config.output_directory, context)

            if output_path.exists():
                item.status = "skipped_existing"
                item.stage = "finalize"
                item.output_path = str(output_path)
                item.reason_code = "existing_output"
                item.reason_detail = "Output path already exists."
                _emit_item(config.run_id, item)
                continue

            if config.dry_run:
                item.status = "completed_local_only"
                item.stage = "finalize"
                item.output_path = str(output_path)
                _emit_item(config.run_id, item)
                continue

            try:
                with tempfile.TemporaryDirectory(prefix="lmsync_") as temp_dir_raw:
                    temp_dir = Path(temp_dir_raw)
                    item.stage = "download"
                    _emit_item(config.run_id, item)
                    downloaded_path, info = _download_audio(config, item, temp_dir)
                    codec = info.get("acodec")
                    item.audio_codec = str(codec) if isinstance(codec, str) else item.audio_codec

                    item.stage = "fixup"
                    _emit_item(config.run_id, item)
                    _normalize_audio(downloaded_path, output_path, config.ffmpeg_path, item.audio_codec)

                    cover_bytes: bytes | None = None
                    if item.cover_art_url:
                        try:
                            cover_bytes = make_square_cover(_download_bytes(item.cover_art_url))
                        except Exception as exc:  # noqa: BLE001
                            _log(config.run_id, item, "tagging", "warn", "cover", str(exc))

                    item.stage = "tagging"
                    _emit_item(config.run_id, item)
                    embedded_lyrics = lyrics_text if config.embed_unsynced_lyrics or item.lyrics_source else None
                    _write_media_tags(output_path, item, cover_bytes, embedded_lyrics)

                    if config.write_lrc_sidecar and lyrics_text:
                        item.lrc_path = str(output_path.with_suffix(".lrc"))
                        Path(item.lrc_path).write_text(lyrics_text, encoding="utf-8")

                    item.stage = "remote_copy"
                    _emit_item(config.run_id, item)
                    _copy_remote(config, output_path)

                item.status = "completed"
                item.stage = "finalize"
                item.output_path = str(output_path)
                _emit_item(config.run_id, item)
            except Exception as exc:  # noqa: BLE001
                item.status = "failed_terminal"
                item.stage = "finalize"
                item.reason_code = "sync_failed"
                item.reason_detail = str(exc)
                _log(config.run_id, item, item.stage, "error", "item-failed", str(exc))
                _emit_item(config.run_id, item)

        _emit_run_event(
            config.run_id,
            "completed",
            "finalize",
            "Sync run complete.",
        )
    except Exception as exc:  # noqa: BLE001
        _run_log(
            config.run_id,
            stage,
            "error",
            "run-failed",
            str(exc),
            {
                "error_type": type(exc).__name__,
                "traceback": traceback.format_exc(),
            },
        )
        _emit_run_event(
            config.run_id,
            "failed",
            stage,
            f"Run failed during {stage}: {exc}",
            context={"error_type": type(exc).__name__},
        )
        raise
