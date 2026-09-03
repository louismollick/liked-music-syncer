from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .exiftool_scan import scan_directory, scan_file
from .lyrics import classify_lyrics_text
from .release_track_identity import youtube_music_release_track_identity


@dataclass(slots=True)
class RootScanConfig:
    transport: str
    uri: str
    kind: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "RootScanConfig":
        return cls(
            transport=str(payload["transport"]),
            uri=str(payload["uri"]),
            kind=str(payload["kind"]),
        )


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    normalized = re.sub(r"[\s\-_]+", " ", normalized)
    normalized = re.sub(r"^[^\w]+|[^\w]+$", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def _classify_lyrics_text(value: str | None) -> str:
    return classify_lyrics_text(value)


def _best_lyrics_status(*values: str) -> str:
    if "synced" in values:
        return "synced"
    if "plain" in values:
        return "plain"
    return "missing"


def _missing_fields(metadata: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for field in (
        "title",
        "artist",
        "album",
        "album_artist",
        "track_number",
        "track_total",
        "disc_number",
        "disc_total",
        "year",
        "genre",
        "isrc",
    ):
        value = metadata.get(field)
        if value in (None, "", 0):
            missing.append(field)
    if metadata.get("lyrics_status") in {"plain", "synced"} and metadata.get("language") in (
        None,
        "",
        0,
    ):
        missing.append("language")
    if not metadata.get("cover_art_present"):
        missing.append("cover_art")
    if metadata.get("lyrics_status") == "missing":
        missing.append("lyrics")
    return missing


def _heuristic_identity(metadata: dict[str, Any]) -> str | None:
    title = metadata.get("title")
    artist = metadata.get("artist")
    album = metadata.get("album")
    track_number = metadata.get("track_number")
    disc_number = metadata.get("disc_number")
    if not isinstance(title, str) or not isinstance(artist, str) or not isinstance(album, str):
        return None
    pieces = [
        _normalize_text(artist),
        _normalize_text(title),
        _normalize_text(album),
        str(track_number or 0),
        str(disc_number or 0),
    ]
    if not pieces[0] or not pieces[1] or not pieces[2]:
        return None
    return "|".join(pieces)


def _identity_for(metadata: dict[str, Any], relative_path: str, root_uri: str) -> tuple[str, str, str]:
    release_track_identity = youtube_music_release_track_identity(metadata)
    if release_track_identity:
        return "ytm_release_track", release_track_identity, "lms_tags"

    for platform, field_name in (
        ("youtube_music", "youtube_music_track_id"),
        ("spotify", "spotify_track_id"),
        ("soundcloud", "soundcloud_track_id"),
    ):
        value = metadata.get(field_name)
        if isinstance(value, str) and value:
            return "lms_source", f"{platform}:{value}", "lms_tags"

    mb_track_id = metadata.get("mb_track_id")
    if isinstance(mb_track_id, str) and mb_track_id:
        return "mb_track", mb_track_id, "mb_track"

    isrc = metadata.get("isrc")
    if isinstance(isrc, str) and isrc:
        return "isrc", isrc, "isrc"

    heuristic = _heuristic_identity(metadata)
    if heuristic:
        return "heuristic", heuristic, "heuristic"

    return "path", f"{root_uri}:{relative_path}", "path"


def _to_iso_timestamp(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()


def _complete_media_metadata(
    metadata: dict[str, Any], sidecar_text: str | None
) -> dict[str, Any]:
    metadata = dict(metadata)
    embedded_lyrics_status = str(metadata["embedded_lyrics_status"])
    sidecar_lyrics_status = _classify_lyrics_text(sidecar_text)
    metadata["lyrics_status"] = _best_lyrics_status(
        embedded_lyrics_status, sidecar_lyrics_status
    )
    metadata["has_embedded_lyrics"] = embedded_lyrics_status != "missing"
    metadata["has_sidecar_lyrics"] = sidecar_lyrics_status != "missing"
    metadata["sidecar_lyrics_status"] = sidecar_lyrics_status
    metadata["missing_fields"] = _missing_fields(metadata)
    return metadata


def _read_media_metadata(path: Path, sidecar_text: str | None) -> dict[str, Any]:
    return _complete_media_metadata(scan_file(path), sidecar_text)


def _read_sidecar_text(path: Path | None) -> str | None:
    if not path or not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def _sidecar_modified_at(path: Path | None) -> str | None:
    if not path or not path.is_file():
        return None
    return _to_iso_timestamp(path.stat().st_mtime)


def _scan_local_file(
    root_path: Path,
    file_path: Path,
    scanned_at: str,
    scanned_metadata: dict[str, Any],
) -> dict[str, Any]:
    relative_path = file_path.relative_to(root_path).as_posix()
    lrc_path = file_path.with_suffix(".lrc")
    sidecar_text = _read_sidecar_text(lrc_path if lrc_path.is_file() else None)
    metadata = _complete_media_metadata(scanned_metadata, sidecar_text)
    identity_kind, identity_value, discovered_via = _identity_for(
        metadata, relative_path, str(root_path)
    )
    stat = file_path.stat()
    return {
        "relative_path": relative_path,
        "absolute_path_snapshot": str(file_path),
        "lrc_path": str(lrc_path) if lrc_path.is_file() else None,
        "size_bytes": stat.st_size,
        "modified_at": _to_iso_timestamp(stat.st_mtime),
        "sidecar_modified_at": _sidecar_modified_at(lrc_path if lrc_path.is_file() else None),
        "sidecar_sha256": hashlib.sha256(sidecar_text.encode("utf-8")).hexdigest()
        if sidecar_text is not None
        else None,
        "audio_sha256": None,
        "last_scanned_at": scanned_at,
        "identity_kind": identity_kind,
        "identity_value": identity_value,
        "discovered_via": discovered_via,
        **metadata,
    }


def _rclone_lsjson(root_uri: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        ["rclone", "lsjson", root_uri, "--recursive", "--files-only"],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    return payload if isinstance(payload, list) else []


def _rclone_cat_text(remote_path: str) -> str | None:
    result = subprocess.run(
        ["rclone", "cat", remote_path],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def _scan_remote_file(
    root_uri: str,
    relative_path: str,
    listing: dict[str, Any],
    sidecar_text: str | None,
    scanned_at: str,
) -> dict[str, Any]:
    remote_path = f"{root_uri.rstrip('/')}/{relative_path}"
    with tempfile.TemporaryDirectory(prefix="lms_scan_") as temp_dir_raw:
        temp_path = Path(temp_dir_raw) / Path(relative_path).name
        subprocess.run(
            ["rclone", "copyto", remote_path, str(temp_path)],
            capture_output=True,
            check=True,
        )
        metadata = _read_media_metadata(temp_path, sidecar_text)

    identity_kind, identity_value, discovered_via = _identity_for(
        metadata, relative_path, root_uri
    )
    modified = listing.get("ModTime")
    return {
        "relative_path": relative_path,
        "absolute_path_snapshot": remote_path,
        "lrc_path": f"{root_uri.rstrip('/')}/{Path(relative_path).with_suffix('.lrc').as_posix()}"
        if sidecar_text is not None
        else None,
        "size_bytes": int(listing["Size"]) if isinstance(listing.get("Size"), int | float) else None,
        "modified_at": str(modified) if isinstance(modified, str) and modified else None,
        "sidecar_modified_at": None,
        "sidecar_sha256": hashlib.sha256(sidecar_text.encode("utf-8")).hexdigest()
        if sidecar_text is not None
        else None,
        "audio_sha256": None,
        "last_scanned_at": scanned_at,
        "identity_kind": identity_kind,
        "identity_value": identity_value,
        "discovered_via": discovered_via,
        **metadata,
    }


def scan_root(payload: dict[str, Any]) -> dict[str, Any]:
    config = RootScanConfig.from_payload(payload)
    scanned_at = _now_iso()

    if config.transport == "filesystem":
        root_path = Path(config.uri).expanduser()
        if not root_path.is_dir():
            raise FileNotFoundError(f"Library root not found: {root_path}")
        scanned_files = scan_directory(root_path)
        local_files = []
        for scanned_file in scanned_files:
            source_file = Path(str(scanned_file["source_file"]))
            metadata = {
                key: value
                for key, value in scanned_file.items()
                if key not in {"relative_path", "source_file", "sidecar_sha256"}
            }
            local_files.append(
                _scan_local_file(
                    root_path,
                    source_file,
                    scanned_at,
                    metadata,
                )
            )
        return {"scanned_at": scanned_at, "files": local_files}

    if config.transport == "rclone":
        listings = _rclone_lsjson(config.uri)
        listing_by_path = {
            str(item.get("Path")): item for item in listings if isinstance(item.get("Path"), str)
        }
        remote_files: list[dict[str, Any]] = []
        for relative_path, listing in sorted(listing_by_path.items()):
            if not relative_path.lower().endswith(".m4a"):
                continue
            sidecar_text = _rclone_cat_text(
                f"{config.uri.rstrip('/')}/{Path(relative_path).with_suffix('.lrc').as_posix()}"
            )
            remote_files.append(
                _scan_remote_file(
                    config.uri,
                    relative_path,
                    listing,
                    sidecar_text,
                    scanned_at,
                )
            )
        return {"scanned_at": scanned_at, "files": remote_files}

    raise ValueError(f"Unsupported root transport: {config.transport}")
