from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from ytmusicapi import YTMusic

from .album_identity import canonical_album_name
from .cover_art import make_square_cover
from .lyrics_language import detect_primary_lyrics_language
from .media_tags import (
    LMS_TAG_SCHEMA_VERSION,
    apply_managed_musicbrainz_policy,
    write_media_tags,
)
from .models import SyncConfig, SyncItemState, normalize_artist_credits
from .json_io import emit_event
from .lyrics import classify_lyrics_text, lyrics_sidecar_text
from .sync_engine import (
    _build_ytmusic_client,
    _download_audio,
    _download_bytes,
    _musicbrainz_enrich,
    _normalize_audio,
    _resolve_best_lyrics,
    _resolve_exact_catalog,
    _resolve_fallback_metadata,
    _should_run_musicbrainz,
    _sync_release_item_metadata,
)
from .templating import OutputLayout


def _config_from_payload(payload: dict[str, Any]) -> SyncConfig:
    return SyncConfig.from_payload(
        {
            "job_id": str(payload.get("job_id", "reprocess")),
            "output_directory": payload["output_directory"],
            "remote_copy_enabled": payload.get("remote_copy_enabled", False),
            "rclone_remote": payload.get("rclone_remote", ""),
            "remote_music_root": payload.get("remote_music_root", ""),
            "ytmusic_browser_auth": payload.get("ytmusic_browser_auth", ""),
            "yt_dlp_cookies_browser": payload.get("yt_dlp_cookies_browser", "firefox"),
            "folder_template": payload["folder_template"],
            "file_template": payload["file_template"],
            "embed_unsynced_lyrics": payload.get("embed_unsynced_lyrics", True),
            "write_lrc_sidecar": payload.get("write_lrc_sidecar", True),
            "lyrics_api_base_url": payload.get("lyrics_api_base_url", ""),
            "spotify_match_enabled": payload.get("spotify_match_enabled", False),
            "ffmpeg_path": payload["ffmpeg_path"],
            "yt_dlp_plugin_dir": payload.get("yt_dlp_plugin_dir", ""),
            "yt_dlp_po_token_base_url": payload.get("yt_dlp_po_token_base_url", ""),
            "force_reprocess": True,
            "existing_local_youtube_music_track_ids": [],
            "existing_local_resolved_youtube_music_track_ids": [],
            "existing_local_track_signatures": [],
            "existing_local_release_signatures": [],
            "artist_filter_channel_ids": [],
            "artist_filter_names_normalized": [],
            "favorite_artist_catalogs": [],
        }
    )


def _candidate_to_item(candidate: dict[str, Any]) -> SyncItemState:
    item = SyncItemState(
        id=str(candidate["track_work_id"]),
        source_video_id=str(
            candidate.get("youtube_music_track_id")
            or candidate.get("resolved_youtube_music_track_id")
            or candidate.get("source_video_id")
            or candidate["track_work_id"]
        ),
        youtube_music_track_id=str(
            candidate.get("youtube_music_track_id")
            or candidate.get("resolved_youtube_music_track_id")
            or candidate.get("source_video_id")
            or candidate["track_work_id"]
        ),
        spotify_track_id=_string_or_none(candidate.get("spotify_track_id")),
        soundcloud_track_id=_string_or_none(candidate.get("soundcloud_track_id")),
        resolved_youtube_music_track_id=_string_or_none(
            candidate.get("resolved_youtube_music_track_id")
        ),
        source_origin=_string_or_none(candidate.get("source_origin")),
        catalog_release_browse_id=_string_or_none(
            candidate.get("catalog_release_browse_id")
        ),
        catalog_release_title=_string_or_none(candidate.get("catalog_release_title")),
        catalog_release_kind=_string_or_none(candidate.get("catalog_release_kind")),
        title=str(candidate.get("title") or "Unknown Title"),
        artist=str(candidate.get("artist") or "Unknown Artist"),
        album=canonical_album_name(str(candidate.get("album") or "")),
        album_artist=str(
            candidate.get("album_artist") or candidate.get("artist") or "Unknown Artist"
        ),
        source_url=str(
            candidate.get("source_url")
            or f"https://music.youtube.com/watch?v={candidate.get('youtube_music_track_id') or ''}"
        ),
        cover_art_url=None,
        artist_credits=normalize_artist_credits(candidate.get("artist_credits")),
        track_number=_int_or_none(candidate.get("track_number")),
        track_total=_int_or_none(candidate.get("track_total")),
        disc_number=_int_or_none(candidate.get("disc_number")),
        disc_total=_int_or_none(candidate.get("disc_total")),
        year=_int_or_none(candidate.get("year")),
        date=_string_or_none(candidate.get("date")),
        genre=_string_or_none(candidate.get("genre")),
        language=_string_or_none(candidate.get("language")),
        isrc=_string_or_none(candidate.get("isrc")),
        mb_track_id=_string_or_none(candidate.get("mb_track_id")),
        mb_album_id=_string_or_none(candidate.get("mb_album_id")),
        mb_releasegroup_id=_string_or_none(candidate.get("mb_releasegroup_id")),
        lyrics_status=str(candidate.get("lyrics_status") or "missing"),
        source_kind="reprocess",
    )
    return item


def _item_from_payload(item_payload: dict[str, Any]) -> SyncItemState:
    item = _candidate_to_item(
        {
            "track_work_id": item_payload["id"],
            "youtube_music_track_id": item_payload.get("youtube_music_track_id"),
            "resolved_youtube_music_track_id": item_payload.get(
                "resolved_youtube_music_track_id"
            ),
            "spotify_track_id": item_payload.get("spotify_track_id"),
            "soundcloud_track_id": item_payload.get("soundcloud_track_id"),
            "source_origin": item_payload.get("source_origin"),
            "catalog_release_browse_id": item_payload.get("catalog_release_browse_id"),
            "catalog_release_title": item_payload.get("catalog_release_title"),
            "catalog_release_kind": item_payload.get("catalog_release_kind"),
            "title": item_payload.get("title"),
            "artist": item_payload.get("artist"),
            "album": item_payload.get("album"),
            "album_artist": item_payload.get("album_artist"),
            "track_number": item_payload.get("track_number"),
            "track_total": item_payload.get("track_total"),
            "disc_number": item_payload.get("disc_number"),
            "disc_total": item_payload.get("disc_total"),
            "year": item_payload.get("year"),
            "date": item_payload.get("date"),
            "genre": item_payload.get("genre"),
            "language": item_payload.get("language"),
            "isrc": item_payload.get("isrc"),
            "mb_track_id": item_payload.get("mb_track_id"),
            "mb_album_id": item_payload.get("mb_album_id"),
            "mb_releasegroup_id": item_payload.get("mb_releasegroup_id"),
            "lyrics_status": item_payload.get("lyrics_status"),
            "source_url": item_payload.get("source_url"),
            "artist_credits": item_payload.get("artist_credits"),
        }
    )
    item.cover_art_url = _string_or_none(item_payload.get("cover_art_url"))
    item.selected_source_url = _string_or_none(item_payload.get("selected_source_url"))
    return item


def _string_or_none(value: Any) -> str | None:
    return str(value) if isinstance(value, str) and value else None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _target_paths(
    config: SyncConfig, item: SyncItemState, track_index: int
) -> tuple[Path, Path | None]:
    layout = OutputLayout(
        folder_template=config.folder_template,
        file_template=config.file_template,
    )
    context = {
      "albumartist": item.album_artist,
      "album": item.album,
      "track": item.track_number or track_index,
      "title": item.title,
      "artist": item.artist,
    }
    output_path = layout.build_path(config.output_directory, context)
    lrc_path = output_path.with_suffix(".lrc") if config.write_lrc_sidecar else None
    return output_path, lrc_path


def _preview_one(
    config: SyncConfig,
    ytmusic: YTMusic,
    candidate: dict[str, Any],
    track_index: int,
) -> dict[str, Any]:
    item = _candidate_to_item(candidate)
    current_resolved = _string_or_none(candidate.get("resolved_youtube_music_track_id"))
    current_output_path = str(candidate.get("current_output_path") or "")
    current_lrc_path = _string_or_none(candidate.get("current_lrc_path"))

    try:
        lyrics_browse_id = _resolve_exact_catalog(ytmusic, item)
    except Exception:
        _resolve_fallback_metadata(config, item)
        lyrics_browse_id = None

    if _should_run_musicbrainz(item):
        try:
            _musicbrainz_enrich(item)
        except Exception:
            pass
    apply_managed_musicbrainz_policy(item)

    try:
        lyrics_text, lyrics_source = _resolve_best_lyrics(
            config, ytmusic, item, lyrics_browse_id
        )
    except Exception:
        lyrics_text, lyrics_source = None, None
    item.lyrics_source = lyrics_source
    item.lyrics_matched = bool(lyrics_text)
    item.lyrics_status = classify_lyrics_text(lyrics_text)
    item.language = detect_primary_lyrics_language(lyrics_text)

    output_path, default_lrc_path = _target_paths(config, item, track_index)
    sidecar_text = lyrics_sidecar_text(lyrics_text, item.lyrics_status)
    target_lrc_path = str(default_lrc_path) if sidecar_text and default_lrc_path else None
    same_video = bool(
        current_resolved
        and item.resolved_youtube_music_track_id
        and current_resolved == item.resolved_youtube_music_track_id
    )

    before = {
        "artistCredits": normalize_artist_credits(candidate.get("artist_credits")),
        "tagSchemaVersion": _int_or_none(candidate.get("tag_schema_version")),
        "title": candidate.get("title"),
        "artist": candidate.get("artist"),
        "album": candidate.get("album"),
        "albumArtist": candidate.get("album_artist"),
        "trackNumber": candidate.get("track_number"),
        "trackTotal": candidate.get("track_total"),
        "discNumber": candidate.get("disc_number"),
        "discTotal": candidate.get("disc_total"),
        "year": candidate.get("year"),
        "date": candidate.get("date"),
        "genre": candidate.get("genre"),
        "language": candidate.get("language"),
        "isrc": candidate.get("isrc"),
        "mbTrackId": candidate.get("mb_track_id"),
        "mbAlbumId": candidate.get("mb_album_id"),
        "mbReleaseGroupId": candidate.get("mb_releasegroup_id"),
        "spotifyTrackId": candidate.get("spotify_track_id"),
        "soundcloudTrackId": candidate.get("soundcloud_track_id"),
        "youtubeMusicTrackId": candidate.get("youtube_music_track_id"),
        "resolvedYoutubeMusicTrackId": current_resolved,
        "sourceOrigin": candidate.get("source_origin"),
        "catalogReleaseBrowseId": candidate.get("catalog_release_browse_id"),
        "catalogReleaseTitle": candidate.get("catalog_release_title"),
        "catalogReleaseKind": candidate.get("catalog_release_kind"),
        "lyricsStatus": candidate.get("lyrics_status"),
        "outputPath": current_output_path or None,
        "lrcPath": current_lrc_path,
        "coverArtPresent": bool(candidate.get("cover_art_present")),
    }
    after = {
        "artistCredits": normalize_artist_credits(item.artist_credits),
        "tagSchemaVersion": LMS_TAG_SCHEMA_VERSION,
        "title": item.title,
        "artist": item.artist,
        "album": item.album,
        "albumArtist": item.album_artist,
        "trackNumber": item.track_number,
        "trackTotal": item.track_total,
        "discNumber": item.disc_number,
        "discTotal": item.disc_total,
        "year": item.year,
        "date": item.date,
        "genre": item.genre,
        "language": item.language,
        "isrc": item.isrc,
        "mbTrackId": item.mb_track_id,
        "mbAlbumId": item.mb_album_id,
        "mbReleaseGroupId": item.mb_releasegroup_id,
        "spotifyTrackId": item.spotify_track_id,
        "soundcloudTrackId": item.soundcloud_track_id,
        "youtubeMusicTrackId": item.youtube_music_track_id,
        "resolvedYoutubeMusicTrackId": item.resolved_youtube_music_track_id,
        "sourceOrigin": item.source_origin,
        "catalogReleaseBrowseId": item.catalog_release_browse_id,
        "catalogReleaseTitle": item.catalog_release_title,
        "catalogReleaseKind": item.catalog_release_kind,
        "lyricsStatus": item.lyrics_status,
        "outputPath": str(output_path),
        "lrcPath": target_lrc_path,
        "coverArtPresent": bool(item.cover_art_url),
    }
    diff: dict[str, dict[str, Any]] = {}
    for key in after:
        if before.get(key) != after.get(key):
            diff[key] = {"before": before.get(key), "after": after.get(key)}

    action_kind = "noop"
    if same_video and diff:
        action_kind = "update"
    if not same_video:
        action_kind = "replace"

    return {
        "track_work_id": str(candidate["track_work_id"]),
        "library_track_id": candidate.get("library_track_id"),
        "same_video": same_video,
        "action_kind": action_kind,
        "diff": diff,
        "before": before,
        "after": after,
        "album_art_diff": {
            "beforePresent": bool(candidate.get("cover_art_present")),
            "afterPresent": bool(item.cover_art_url),
            "afterUrl": item.cover_art_url,
        }
        if bool(candidate.get("cover_art_present")) != bool(item.cover_art_url)
        else None,
        "payload": {
            "item": item.as_event_payload(),
            "lyrics_text": lyrics_text,
            "current_output_path": current_output_path or None,
            "current_lrc_path": current_lrc_path,
            "target_output_path": str(output_path),
            "target_lrc_path": target_lrc_path,
            "same_video": same_video,
            "action_kind": action_kind,
        },
    }


def preview_reprocess(payload: dict[str, Any]) -> dict[str, Any]:
    config = _config_from_payload(payload)
    ytmusic = _build_ytmusic_client(config.ytmusic_browser_auth)
    items = payload.get("items")
    if not isinstance(items, list):
        return {"items": []}
    previews = [
        _preview_one(config, ytmusic, candidate, index)
        for index, candidate in enumerate(items, start=1)
        if isinstance(candidate, dict)
    ]
    return {"items": previews}


def preview_reprocess_stream(payload: dict[str, Any]) -> None:
    config = _config_from_payload(payload)
    ytmusic = _build_ytmusic_client(config.ytmusic_browser_auth)
    raw_items = payload.get("items")
    batch_size = max(1, int(payload.get("batch_size", 25)))
    progress_every = max(1, int(payload.get("progress_every", batch_size)))
    items = (
        [candidate for candidate in raw_items if isinstance(candidate, dict)]
        if isinstance(raw_items, list)
        else []
    )
    total_count = len(items)
    processed_count = 0
    changed_count = 0
    batch: list[dict[str, Any]] = []

    emit_event(
        {
            "type": "reprocess_preview",
            "event": "started",
            "job_id": config.job_id,
            "total_count": total_count,
            "processed_count": 0,
            "changed_count": 0,
            "noop_count": 0,
            "message": "Reprocess preview started.",
        }
    )

    for index, candidate in enumerate(items, start=1):
        preview = _preview_one(config, ytmusic, candidate, index)
        processed_count += 1
        if preview["action_kind"] != "noop" and preview["diff"]:
            batch.append(preview)
            changed_count += 1

        if batch and len(batch) >= batch_size:
            emit_event(
                {
                    "type": "reprocess_preview",
                    "event": "batch",
                    "job_id": config.job_id,
                    "total_count": total_count,
                    "processed_count": processed_count,
                    "changed_count": changed_count,
                    "noop_count": processed_count - changed_count,
                    "items": batch,
                }
            )
            batch = []

        if processed_count == total_count or processed_count % progress_every == 0:
            emit_event(
                {
                    "type": "reprocess_preview",
                    "event": "progress",
                    "job_id": config.job_id,
                    "total_count": total_count,
                    "processed_count": processed_count,
                    "changed_count": changed_count,
                    "noop_count": processed_count - changed_count,
                    "message": "Reprocess preview progress.",
                }
            )

    if batch:
        emit_event(
            {
                "type": "reprocess_preview",
                "event": "batch",
                "job_id": config.job_id,
                "total_count": total_count,
                "processed_count": processed_count,
                "changed_count": changed_count,
                "noop_count": processed_count - changed_count,
                "items": batch,
            }
        )

    emit_event(
        {
            "type": "reprocess_preview",
            "event": "completed",
            "job_id": config.job_id,
            "total_count": total_count,
            "processed_count": processed_count,
            "changed_count": changed_count,
            "noop_count": processed_count - changed_count,
            "message": "Reprocess preview complete.",
        }
    )


def _path_state(path: Path | None) -> str:
    if path is None:
        return "none"
    return f"{path} (exists={path.exists()})"


def _same_filesystem_entry(left: Path | None, right: Path | None) -> bool:
    if left is None or right is None:
        return False
    if left == right:
        return True
    try:
        return left.samefile(right)
    except OSError:
        return False


def _wrap_file_operation_error(
    exc: OSError,
    *,
    action: str,
    current_output_path: Path | None,
    target_output_path: Path,
    current_lrc_path: Path | None,
    target_lrc_path: Path | None,
    same_video: bool,
) -> RuntimeError:
    return RuntimeError(
        f"{action} failed: {exc}. "
        f"same_video={same_video}; "
        f"current_output={_path_state(current_output_path)}; "
        f"target_output={_path_state(target_output_path)}; "
        f"current_lrc={_path_state(current_lrc_path)}; "
        f"target_lrc={_path_state(target_lrc_path)}; "
        "Likely stale local path or file changed during reprocess."
    )


def _wrap_rclone_error(
    exc: subprocess.CalledProcessError,
    *,
    action: str,
    local_path: Path | None,
    remote_path: str,
) -> RuntimeError:
    stdout = exc.stdout.decode("utf-8", errors="replace").strip() if isinstance(exc.stdout, bytes) else str(exc.stdout or "").strip()
    stderr = exc.stderr.decode("utf-8", errors="replace").strip() if isinstance(exc.stderr, bytes) else str(exc.stderr or "").strip()
    local_exists = local_path.exists() if local_path else None
    local_size = local_path.stat().st_size if local_path and local_path.exists() else None
    return RuntimeError(
        f"{action} failed: returncode={exc.returncode}; "
        f"local_path={local_path}; local_exists={local_exists}; local_size={local_size}; "
        f"remote_path={remote_path}; "
        f"stderr={stderr or '<empty>'}; stdout={stdout or '<empty>'}"
    )


def _copy_remote_file(config: SyncConfig, local_path: Path, remote_path: str) -> None:
    try:
        subprocess.run(
            ["rclone", "copyto", str(local_path), remote_path],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        raise _wrap_rclone_error(
            exc,
            action="rclone copyto",
            local_path=local_path,
            remote_path=remote_path,
        ) from exc


def _delete_remote_file(remote_path: str) -> None:
    try:
        subprocess.run(["rclone", "deletefile", remote_path], check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        # rclone uses exit status 4 for "file/path not found" style conditions.
        # Deleting stale artifacts should be best-effort and not fail reprocess.
        if exc.returncode == 4:
            return
        raise _wrap_rclone_error(
            exc,
            action="rclone deletefile",
            local_path=None,
            remote_path=remote_path,
        ) from exc


def _remote_target(config: SyncConfig, local_path: Path) -> str:
    relative = local_path.relative_to(config.output_directory).as_posix()
    return f"{config.rclone_remote}:{config.remote_music_root.rstrip('/')}/{relative}"


def _sync_remote_artifacts(
    config: SyncConfig,
    target_output_path: Path,
    target_lrc_path: Path | None,
    old_output_path: Path | None,
    old_lrc_path: Path | None,
) -> None:
    if not config.remote_copy_enabled or not config.rclone_remote or not config.remote_music_root:
        return
    _copy_remote_file(config, target_output_path, _remote_target(config, target_output_path))
    if target_lrc_path and target_lrc_path.exists():
        _copy_remote_file(config, target_lrc_path, _remote_target(config, target_lrc_path))
    if old_output_path and old_output_path != target_output_path:
        _delete_remote_file(_remote_target(config, old_output_path))
    if old_lrc_path and (not target_lrc_path or old_lrc_path != target_lrc_path):
        _delete_remote_file(_remote_target(config, old_lrc_path))


def _parse_apply_payload(apply_payload: dict[str, Any]) -> tuple[
    SyncItemState,
    str | None,
    str | None,
    str | None,
    Path,
    Path | None,
    bool,
]:
    item_payload = apply_payload.get("item")
    if not isinstance(item_payload, dict):
        raise ValueError("Missing item payload")
    item = _item_from_payload(item_payload)
    lyrics_text = _string_or_none(apply_payload.get("lyrics_text"))
    current_output_path = _string_or_none(apply_payload.get("current_output_path"))
    current_lrc_path = _string_or_none(apply_payload.get("current_lrc_path"))
    target_output_path = Path(str(apply_payload["target_output_path"]))
    target_lrc_path = (
        Path(str(apply_payload["target_lrc_path"]))
        if apply_payload.get("target_lrc_path")
        else None
    )
    same_video = bool(apply_payload.get("same_video"))
    return (
        item,
        lyrics_text,
        current_output_path,
        current_lrc_path,
        target_output_path,
        target_lrc_path,
        same_video,
    )


def _apply_reprocess_payload(config: SyncConfig, apply_payload: dict[str, Any]) -> dict[str, Any]:
    item, lyrics_text, current_output_path, current_lrc_path, target_output_path, target_lrc_path, same_video = (
        _parse_apply_payload(apply_payload)
    )
    cover_bytes: bytes | None = None
    if item.cover_art_url:
        cover_bytes = make_square_cover(_download_bytes(item.cover_art_url))
    embedded_lyrics = (
        lyrics_text
        if lyrics_text
        and (item.lyrics_status == "synced" or config.embed_unsynced_lyrics)
        else None
    )
    sidecar_text = lyrics_sidecar_text(lyrics_text, item.lyrics_status)

    old_output = Path(current_output_path) if current_output_path else None
    old_lrc = Path(current_lrc_path) if current_lrc_path else None

    if same_video:
        if not old_output or not old_output.exists():
            raise RuntimeError(
                "Current local file missing for same-video update. "
                f"current_output={_path_state(old_output)}; "
                f"target_output={_path_state(target_output_path)}; "
                f"current_lrc={_path_state(old_lrc)}; "
                f"target_lrc={_path_state(target_lrc_path)}; "
                "Likely stale local path before apply."
            )
        try:
            target_output_path.parent.mkdir(parents=True, exist_ok=True)
            if not _same_filesystem_entry(old_output, target_output_path):
                if target_output_path.exists():
                    target_output_path.unlink()
                shutil.move(str(old_output), str(target_output_path))
            write_media_tags(target_output_path, item, cover_bytes, embedded_lyrics)
            if target_lrc_path and sidecar_text:
                target_lrc_path.write_text(sidecar_text, encoding="utf-8")
            if (
                old_lrc
                and old_lrc.exists()
                and (
                    target_lrc_path is None
                    or not _same_filesystem_entry(old_lrc, target_lrc_path)
                )
            ):
                old_lrc.unlink()
            if target_lrc_path is None:
                stale_lrc = target_output_path.with_suffix(".lrc")
                if stale_lrc.exists():
                    stale_lrc.unlink()
        except OSError as exc:
            raise _wrap_file_operation_error(
                exc,
                action="same-video local apply",
                current_output_path=old_output,
                target_output_path=target_output_path,
                current_lrc_path=old_lrc,
                target_lrc_path=target_lrc_path,
                same_video=True,
            ) from exc
        _sync_remote_artifacts(config, target_output_path, target_lrc_path, old_output, old_lrc)
        return {
            "ok": True,
            "output_path": str(target_output_path),
            "lrc_path": str(target_lrc_path) if target_lrc_path and target_lrc_path.exists() else None,
            "replaced": False,
        }

    with tempfile.TemporaryDirectory(prefix="lmsync_reprocess_") as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        downloaded_path, info = _download_audio(config, item, temp_dir)
        codec = info.get("acodec")
        item.audio_codec = str(codec) if isinstance(codec, str) else item.audio_codec
        try:
            _normalize_audio(downloaded_path, target_output_path, config.ffmpeg_path, item.audio_codec)
            write_media_tags(target_output_path, item, cover_bytes, embedded_lyrics)
            if target_lrc_path and sidecar_text:
                target_lrc_path.write_text(sidecar_text, encoding="utf-8")
            elif target_output_path.with_suffix(".lrc").exists():
                target_output_path.with_suffix(".lrc").unlink()
        except OSError as exc:
            raise _wrap_file_operation_error(
                exc,
                action="replace local apply",
                current_output_path=old_output,
                target_output_path=target_output_path,
                current_lrc_path=old_lrc,
                target_lrc_path=target_lrc_path,
                same_video=False,
            ) from exc

    if (
        old_output
        and old_output.exists()
        and not _same_filesystem_entry(old_output, target_output_path)
    ):
        old_output.unlink()
    if (
        old_lrc
        and old_lrc.exists()
        and (
            target_lrc_path is None
            or not _same_filesystem_entry(old_lrc, target_lrc_path)
        )
    ):
        old_lrc.unlink()
    _sync_remote_artifacts(config, target_output_path, target_lrc_path, old_output, old_lrc)
    return {
        "ok": True,
        "output_path": str(target_output_path),
        "lrc_path": str(target_lrc_path) if target_lrc_path and target_lrc_path.exists() else None,
        "replaced": True,
    }


def apply_reprocess(payload: dict[str, Any]) -> dict[str, Any]:
    config = _config_from_payload(payload)
    apply_payload = payload.get("payload")
    if not isinstance(apply_payload, dict):
        raise ValueError("Missing apply payload")
    return _apply_reprocess_payload(config, apply_payload)


def _emit_reprocess_job_event(
    job_id: str,
    event: str,
    total_count: int,
    message: str,
) -> None:
    emit_event(
        {
            "type": "job",
            "event": event,
            "job_id": job_id,
            "stage": "finalize" if event == "completed" else "source_resolve",
            "message": message,
            "total_count": total_count,
        }
    )


def _emit_reprocess_track(job_id: str, item: SyncItemState) -> None:
    emit_event(
        {
            "type": "track",
            "event": "upsert",
            "job_id": job_id,
            "item": item.as_event_payload(),
        }
    )


def _emit_reprocess_log(
    job_id: str,
    item: SyncItemState,
    level: str,
    event: str,
    message: str,
) -> None:
    emit_event(
        {
            "type": "log",
            "job_id": job_id,
            "item_id": item.id,
            "youtube_music_track_id": item.youtube_music_track_id,
            "timestamp": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "level": level,
            "stage": item.stage,
            "event": event,
            "message": message,
            "context": {},
        }
    )


def run_reprocess_stream(payload: dict[str, Any]) -> None:
    config = _config_from_payload(payload)
    ytmusic = _build_ytmusic_client(config.ytmusic_browser_auth)
    raw_items = payload.get("items")
    items = (
        [candidate for candidate in raw_items if isinstance(candidate, dict)]
        if isinstance(raw_items, list)
        else []
    )
    total_count = len(items)
    _emit_reprocess_job_event(config.job_id, "started", total_count, "Reprocess started.")

    try:
        for index, candidate in enumerate(items, start=1):
            item = _candidate_to_item(candidate)
            item.status = "processing"
            item.stage = "source_resolve"
            _emit_reprocess_track(config.job_id, item)

            try:
                preview = _preview_one(config, ytmusic, candidate, index)
                apply_payload = preview["payload"]
                if not isinstance(apply_payload, dict):
                    raise ValueError("Missing preview apply payload")

                item_payload = apply_payload.get("item")
                if not isinstance(item_payload, dict):
                    raise ValueError("Missing preview item payload")

                item = _item_from_payload(item_payload)
            except Exception as exc:
                item.status = "failed_terminal"
                item.stage = "finalize"
                item.reason_code = "reprocess_preview_failed"
                item.reason_detail = str(exc)
                _emit_reprocess_log(
                    config.job_id,
                    item,
                    "error",
                    "reprocess-preview-failed",
                    str(exc),
                )
                _emit_reprocess_track(config.job_id, item)
                continue

            if preview["action_kind"] == "noop" or not preview["diff"]:
                item.status = "completed"
                item.stage = "finalize"
                item.reason_code = "reprocess_no_changes"
                item.reason_detail = "No changes found during reprocess."
                item.output_path = _string_or_none(apply_payload.get("current_output_path")) or _string_or_none(
                    apply_payload.get("target_output_path")
                )
                item.lrc_path = _string_or_none(apply_payload.get("current_lrc_path"))
                _emit_reprocess_track(config.job_id, item)
                continue

            try:
                result = _apply_reprocess_payload(config, apply_payload)
                item.status = "completed"
                item.stage = "finalize"
                item.reason_code = (
                    "reprocess_updated" if not result["replaced"] else "reprocess_replaced"
                )
                item.reason_detail = (
                    "Reprocess applied without redownloading audio."
                    if not result["replaced"]
                    else "Reprocess replaced the local audio file."
                )
                item.output_path = str(result["output_path"])
                item.lrc_path = _string_or_none(result.get("lrc_path"))
                _emit_reprocess_track(config.job_id, item)
            except Exception as exc:
                item.status = "failed_terminal"
                item.stage = "finalize"
                item.reason_code = "reprocess_apply_failed"
                item.reason_detail = str(exc)
                _emit_reprocess_log(config.job_id, item, "error", "reprocess-apply-failed", str(exc))
                _emit_reprocess_track(config.job_id, item)

        _emit_reprocess_job_event(
            config.job_id, "completed", total_count, "Reprocess complete."
        )
    except Exception as exc:
        emit_event(
            {
                "type": "job",
                "event": "failed",
                "job_id": config.job_id,
                "stage": "finalize",
                "message": str(exc),
                "total_count": total_count,
            }
        )
        raise
