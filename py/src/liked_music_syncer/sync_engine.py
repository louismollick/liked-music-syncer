from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import traceback
import unicodedata
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


def _normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    normalized = re.sub(r"[\s\-_]+", " ", normalized)
    normalized = re.sub(r"^[^\w]+|[^\w]+$", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def _strip_title_adornments(value: str) -> str:
    cleaned = value.strip()
    while True:
        updated = re.sub(
            r"\s*[\(\[\{（【][^)\]\}）】]*(?:official|music video|official video|official mv|mv|audio|visualizer|lyrics?)[^)\]\}）】]*[\)\]\}）】]\s*$",
            "",
            cleaned,
            flags=re.IGNORECASE,
        ).strip()
        updated = re.sub(
            r"\s*(?:-|:|\||/)?\s*(?:official(?:\s+music)?\s+video|official\s+mv|music\s+video|mv|lyrics?|audio|visualizer)\s*$",
            "",
            updated,
            flags=re.IGNORECASE,
        ).strip()
        if updated == cleaned:
            return updated
        cleaned = updated


def _canonicalize_track_title(value: str, artist_names: list[str]) -> str:
    cleaned = _strip_title_adornments(value)
    for artist_name in artist_names:
        artist_name = artist_name.strip()
        if not artist_name:
            continue
        updated = re.sub(
            rf"^\s*{re.escape(artist_name)}\s*(?:-|:|\||/)\s*",
            "",
            cleaned,
            count=1,
            flags=re.IGNORECASE,
        ).strip()
        if updated != cleaned:
            cleaned = updated
            break
    return cleaned or value.strip()


def _title_variants(value: str, artist_names: list[str]) -> set[str]:
    cleaned = _canonicalize_track_title(value, artist_names)
    variants = {_normalize_text(cleaned)}
    for part in re.split(r"\s*(?:-|:|\||/)\s*", cleaned):
        normalized = _normalize_text(part)
        if normalized:
            variants.add(normalized)
    variants.discard("")
    return variants


def _parse_duration_seconds(value: Any) -> int | None:
    if isinstance(value, int):
        return value if value >= 0 else None
    if not isinstance(value, str):
        return None

    parts = value.strip().split(":")
    if not parts or len(parts) > 3:
        return None

    try:
        numbers = [int(part) for part in parts]
    except ValueError:
        return None

    total = 0
    for number in numbers:
        total = (total * 60) + number
    return total


def _album_info(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _album_id_for_track(track: dict[str, Any]) -> str | None:
    album_id = _album_info(track.get("album")).get("id")
    return str(album_id) if isinstance(album_id, str) and album_id else None


def _artist_ids(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        if isinstance(value, dict):
            artist_id = value.get("id")
            if isinstance(artist_id, str) and artist_id:
                result.append(artist_id)
    return result


def _first_artist_name(values: Any) -> str | None:
    names = _string_list_names(values)
    return names[0] if names else None


def _preferred_source_url(item: SyncItemState) -> str:
    return item.selected_source_url or item.source_url


def _is_omv(video_type: str | None) -> bool:
    return video_type == "MUSIC_VIDEO_TYPE_OMV"


def _apply_watch_metadata(item: SyncItemState, track: dict[str, Any]) -> None:
    item.metadata_matched = True
    item.title = str(track.get("title") or item.title)
    artists = _string_list_names(track.get("artists"))
    if artists:
        item.artist = ", ".join(artists)
        item.album_artist = item.artist
    item.video_type = str(track.get("videoType")) if track.get("videoType") else item.video_type
    item.cover_art_url = _pick_thumbnail(track.get("thumbnails") or track.get("thumbnail")) or item.cover_art_url


def _apply_album_metadata(
    ytmusic: YTMusic,
    item: SyncItemState,
    album_id: str,
    preferred_video_ids: list[str],
    fallback_title: str,
) -> bool:
    album = ytmusic.get_album(album_id)
    if not isinstance(album, dict):
        return False

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
    normalized_fallback_title = _normalize_text(fallback_title)

    for preferred_video_id in preferred_video_ids:
        for track_index, track in enumerate(album_tracks, start=1):
            if str(track.get("videoId")) != preferred_video_id:
                continue
            item.track_number = track_index
            track_title = track.get("title")
            if isinstance(track_title, str) and track_title:
                item.title = track_title
            return True

    if len(album_tracks) == 1:
        only_track = album_tracks[0]
        track_title = only_track.get("title")
        if isinstance(track_title, str) and _normalize_text(track_title) == normalized_fallback_title:
            item.track_number = 1
            if track_title:
                item.title = track_title

    return True


def _search_song_candidate(
    ytmusic: YTMusic,
    item: SyncItemState,
    primary: dict[str, Any],
    *,
    run_id: str | None = None,
) -> dict[str, Any] | None:
    original_artist_names = _string_list_names(primary.get("artists"))
    original_artist_ids = _artist_ids(primary.get("artists"))
    original_artist_name = _first_artist_name(primary.get("artists")) or item.artist.split(",")[0].strip()
    search_title = _canonicalize_track_title(item.title, original_artist_names or [original_artist_name])
    target_title_variants = _title_variants(item.title, original_artist_names or [original_artist_name])
    original_duration = _parse_duration_seconds(primary.get("length"))
    query = f"{search_title} {original_artist_name}".strip()
    duration_tolerance = 15 if _is_omv(item.video_type) else 10

    if run_id:
        _log(
            run_id,
            item,
            item.stage,
            "info",
            "search-catalog-start",
            "Searching for catalog song candidate.",
            {
                "query": query,
                "search_title": search_title,
                "video_type": item.video_type,
                "title": item.title,
                "artist": original_artist_name,
            },
        )

    results = ytmusic.search(query, filter="songs", limit=5, ignore_spelling=False)
    best_candidate: dict[str, Any] | None = None
    best_key: tuple[int, int, int] | None = None
    candidate_logs: list[dict[str, Any]] = []

    for result in results:
        if not isinstance(result, dict):
            continue

        candidate_video_id = result.get("videoId")
        candidate_title = result.get("title")
        candidate_album_id = _album_info(result.get("album")).get("id")
        candidate_artist_name = _first_artist_name(result.get("artists"))
        candidate_artist_ids = _artist_ids(result.get("artists"))
        candidate_artist_names = _string_list_names(result.get("artists"))
        candidate_duration = _parse_duration_seconds(result.get("duration"))
        duration_diff = (
            abs(candidate_duration - original_duration)
            if candidate_duration is not None and original_duration is not None
            else 0
        )
        candidate_title_variants = (
            _title_variants(candidate_title, candidate_artist_names) if isinstance(candidate_title, str) else set()
        )
        title_matches = bool(target_title_variants and candidate_title_variants and target_title_variants & candidate_title_variants)
        artist_id_matches = bool(
            original_artist_ids and candidate_artist_ids and set(original_artist_ids) & set(candidate_artist_ids)
        )
        artist_name_matches = bool(
            not artist_id_matches
            and candidate_artist_name
            and _normalize_text(candidate_artist_name) == _normalize_text(original_artist_name)
        )
        artist_matches = artist_id_matches or artist_name_matches
        duration_matches = original_duration is None or candidate_duration is None or duration_diff <= duration_tolerance
        video_type = str(result.get("videoType")) if result.get("videoType") else None
        accepted = bool(
            isinstance(candidate_video_id, str)
            and candidate_video_id != item.source_video_id
            and isinstance(candidate_album_id, str)
            and candidate_album_id
            and title_matches
            and artist_matches
            and duration_matches
        )

        if run_id:
            candidate_logs.append(
                {
                    "video_id": candidate_video_id,
                    "title": candidate_title,
                    "album_id": candidate_album_id,
                    "video_type": video_type,
                    "duration_diff": duration_diff if original_duration is not None and candidate_duration is not None else None,
                    "accepted": accepted,
                    "title_match": title_matches,
                    "artist_match": "id" if artist_id_matches else ("name" if artist_name_matches else "none"),
                }
            )

        if not accepted:
            continue

        sort_key = (
            0 if video_type == "MUSIC_VIDEO_TYPE_ATV" else 1,
            duration_diff,
            0 if artist_id_matches else 1,
        )
        if best_key is None or sort_key < best_key:
            best_key = sort_key
            best_candidate = result

    if run_id:
        _log(
            run_id,
            item,
            item.stage,
            "info",
            "search-catalog-candidates",
            "Catalog search candidates evaluated.",
            {"candidates": candidate_logs},
        )

    return best_candidate


def _resolve_exact_catalog(
    ytmusic: YTMusic,
    item: SyncItemState,
    *,
    run_id: str | None = None,
) -> str | None:
    watch = ytmusic.get_watch_playlist(videoId=item.source_video_id, limit=1)
    if not isinstance(watch, dict):
        return None

    watch_tracks = _extract_tracks(watch)
    primary = watch_tracks[0] if watch_tracks else {}
    _apply_watch_metadata(item, primary)
    album_id = _album_id_for_track(primary)

    lyrics_id = watch.get("lyrics")
    lyrics_browse_id = lyrics_id if isinstance(lyrics_id, str) else None

    if album_id and _apply_album_metadata(
        ytmusic,
        item,
        album_id,
        [item.source_video_id],
        item.title,
    ):
        item.resolution_method = "album_exact"
        return lyrics_browse_id

    if not _is_omv(item.video_type):
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate = _search_song_candidate(ytmusic, item, primary, run_id=run_id)
    if not candidate:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate_video_id = candidate.get("videoId")
    if not isinstance(candidate_video_id, str) or not candidate_video_id:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate_watch = ytmusic.get_watch_playlist(videoId=candidate_video_id, limit=1)
    if not isinstance(candidate_watch, dict):
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate_tracks = _extract_tracks(candidate_watch)
    candidate_primary = candidate_tracks[0] if candidate_tracks else candidate
    candidate_album_id = _album_id_for_track(candidate_primary) or str(_album_info(candidate.get("album")).get("id") or "")
    if not candidate_album_id:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    item.selected_source_url = f"https://music.youtube.com/watch?v={candidate_video_id}"
    _apply_watch_metadata(item, candidate_primary)

    candidate_lyrics_id = candidate_watch.get("lyrics")
    candidate_lyrics_browse_id = candidate_lyrics_id if isinstance(candidate_lyrics_id, str) else None

    if not _apply_album_metadata(
        ytmusic,
        item,
        candidate_album_id,
        [candidate_video_id, item.source_video_id],
        item.title,
    ):
        item.selected_source_url = None
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    item.resolution_method = "search_song_exact"
    if run_id:
        _log(
            run_id,
            item,
            item.stage,
            "info",
            "search-catalog-selected",
            "Selected alternate catalog source.",
            {
                "original_video_id": item.source_video_id,
                "selected_video_id": candidate_video_id,
                "selected_source_url": item.selected_source_url,
            },
        )
    return candidate_lyrics_browse_id

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
        "logtostderr": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": skip_download,
        "remote_components": ["ejs:github"],
        "extractor_args": {
            "youtube": {
                "player_client": ["mweb", "default"],
            },
        },
    }
    if config.yt_dlp_cookies_browser.strip():
        options["cookiesfrombrowser"] = (config.yt_dlp_cookies_browser.strip().lower(),)
    if config.yt_dlp_po_token_base_url.strip():
        options["extractor_args"]["youtubepot-bgutilhttp"] = {
            "base_url": [config.yt_dlp_po_token_base_url.strip()],
        }
    return options


def _resolve_fallback_metadata(config: SyncConfig, item: SyncItemState) -> None:
    options = _build_yt_dlp_options(config, skip_download=True)
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(_preferred_source_url(item), download=False)

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
    try:
        payload = ytmusic.get_lyrics(lyrics_browse_id, timestamps=True)
    except Exception:
        payload = ytmusic.get_lyrics(lyrics_browse_id, timestamps=False)
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
        info = ydl.extract_info(_preferred_source_url(item), download=True)
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
    media.comments = _preferred_source_url(item)
    if lyrics_text:
        media.lyrics = lyrics_text
    if cover_bytes:
        media.images = [Image(data=cover_bytes)]
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
                stage = item.stage
                lyrics_browse_id = _resolve_exact_catalog(ytmusic, item, run_id=config.run_id)
                _emit_item(config.run_id, item)
                _log(config.run_id, item, item.stage, "info", "resolve", f"Resolution method: {item.resolution_method}.")
            except Exception as exc:  # noqa: BLE001
                _log(config.run_id, item, "source_resolve", "warn", "resolve-fallback", str(exc))
                _resolve_fallback_metadata(config, item)
                _emit_item(config.run_id, item)
                lyrics_browse_id = None

            try:
                item.stage = "musicbrainz_enrich"
                stage = item.stage
                _musicbrainz_enrich(item)
                _emit_item(config.run_id, item)
            except Exception as exc:  # noqa: BLE001
                _log(config.run_id, item, item.stage, "warn", "musicbrainz", str(exc))

            item.stage = "lyrics_resolve"
            stage = item.stage
            try:
                lyrics_text, lyrics_source = _resolve_lyrics(ytmusic, lyrics_browse_id)
            except Exception as exc:  # noqa: BLE001
                _log(config.run_id, item, item.stage, "warn", "lyrics", str(exc))
                lyrics_text, lyrics_source = None, None
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
                    stage = item.stage
                    _emit_item(config.run_id, item)
                    downloaded_path, info = _download_audio(config, item, temp_dir)
                    codec = info.get("acodec")
                    item.audio_codec = str(codec) if isinstance(codec, str) else item.audio_codec

                    item.stage = "fixup"
                    stage = item.stage
                    _emit_item(config.run_id, item)
                    _normalize_audio(downloaded_path, output_path, config.ffmpeg_path, item.audio_codec)

                    cover_bytes: bytes | None = None
                    if item.cover_art_url:
                        try:
                            cover_bytes = make_square_cover(_download_bytes(item.cover_art_url))
                        except Exception as exc:  # noqa: BLE001
                            _log(config.run_id, item, "tagging", "warn", "cover", str(exc))

                    item.stage = "tagging"
                    stage = item.stage
                    _emit_item(config.run_id, item)
                    embedded_lyrics = lyrics_text if config.embed_unsynced_lyrics or item.lyrics_source else None
                    _write_media_tags(output_path, item, cover_bytes, embedded_lyrics)

                    if config.write_lrc_sidecar and lyrics_text:
                        item.lrc_path = str(output_path.with_suffix(".lrc"))
                        Path(item.lrc_path).write_text(lyrics_text, encoding="utf-8")

                    item.stage = "remote_copy"
                    stage = item.stage
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
