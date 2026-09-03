from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


EXIFTOOL_FIELDS = (
    "LMS_TAG_SCHEMA_VERSION",
    "LMS_YOUTUBE_MUSIC_TRACK_ID",
    "LMS_SPOTIFY_TRACK_ID",
    "LMS_SOUNDCLOUD_TRACK_ID",
    "LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID",
    "LMS_SOURCE_ORIGIN",
    "LMS_RESOLUTION_METHOD",
    "LMS_CATALOG_RELEASE_BROWSE_ID",
    "LMS_CATALOG_RELEASE_TITLE",
    "LMS_CATALOG_RELEASE_KIND",
    "LMS_ARTIST_CREDITS",
    "Title",
    "Artist",
    "Album",
    "AlbumArtist",
    "TrackNumber",
    "TrackTotal",
    "DiscNumber",
    "DiscTotal",
    "DiskNumber",
    "DiskTotal",
    "Year",
    "ContentCreateDate",
    "Genre",
    "Language",
    "ISRC",
    "MusicBrainzTrackId",
    "MusicBrainzAlbumId",
    "MusicBrainzReleaseGroupId",
    "Lyrics",
    "CoverArt",
    "Comment",
    "FileType",
    "Duration",
    "AvgBitrate",
)

FINGERPRINT_FIELDS = (
    "tag_schema_version",
    "youtube_music_track_id",
    "spotify_track_id",
    "soundcloud_track_id",
    "resolved_youtube_music_track_id",
    "source_origin",
    "resolution_method",
    "catalog_release_browse_id",
    "catalog_release_title",
    "catalog_release_kind",
    "artist_credits",
    "title",
    "artist",
    "album",
    "album_artist",
    "track_number",
    "track_total",
    "disc_number",
    "disc_total",
    "year",
    "date",
    "genre",
    "language",
    "isrc",
    "mb_track_id",
    "mb_album_id",
    "mb_releasegroup_id",
    "embedded_lyrics_status",
    "embedded_lyrics_sha256",
    "artwork_sha256",
)


def _value(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        current = row.get(name)
        if current not in (None, ""):
            return current
    return None


def _text(row: dict[str, Any], *names: str) -> str | None:
    current = _value(row, *names)
    return str(current) if current is not None else None


def _integer(row: dict[str, Any], *names: str) -> int | None:
    current = _value(row, *names)
    if current is None:
        return None
    match = re.match(r"^\s*(\d+)", str(current))
    parsed = int(match.group(1)) if match else None
    return parsed if parsed else None


def _integer_total(
    row: dict[str, Any], total_name: str, combined_name: str
) -> int | None:
    explicit = _integer(row, total_name)
    if explicit is not None:
        return explicit
    combined = _value(row, combined_name)
    if combined is None:
        return None
    match = re.search(
        r"(?:\s+of\s+|\s*/\s*)(\d+)\s*$", str(combined), re.IGNORECASE
    )
    parsed = int(match.group(1)) if match else None
    return parsed if parsed else None


def _normalize_date(current: str | None) -> str | None:
    if not current:
        return None
    rendered = current[:10].replace(":", "-")
    return rendered


def _json_array(row: dict[str, Any], *names: str) -> list[dict[str, str | None]]:
    current = _text(row, *names)
    if not current:
        return []
    try:
        parsed = json.loads(current)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    result: list[dict[str, str | None]] = []
    for value in parsed:
        if not isinstance(value, dict) or not value.get("name"):
            continue
        channel_id = value.get("channel_id")
        result.append(
            {
                "name": str(value["name"]),
                "channel_id": str(channel_id) if channel_id else None,
            }
        )
    return result


def _binary_hash(current: Any) -> str | None:
    if not isinstance(current, str):
        return None
    raw = (
        base64.b64decode(current[7:])
        if current.startswith("base64:")
        else current.encode("utf-8")
    )
    return hashlib.sha256(raw).hexdigest()


def _lyrics_status(current: str | None) -> str:
    if not current:
        return "missing"
    if re.search(r"(?m)^\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]", current):
        return "synced"
    return "plain"


def _legacy_youtube_id(comment: str | None) -> str | None:
    if not comment:
        return None
    match = re.search(r"(?:youtube\.com/watch\?v=|youtu\.be/)([\w-]{6,})", comment)
    return match.group(1) if match else None


def _number(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        match = re.match(r"^\s*([\d.]+)", value)
        return float(match.group(1)) if match else None
    return None


def tag_fingerprint(metadata: dict[str, Any]) -> str:
    canonical = {key: metadata.get(key) for key in FINGERPRINT_FIELDS}
    encoded = json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def canonicalize_exiftool_row(row: dict[str, Any]) -> dict[str, Any]:
    lyrics = _text(row, "Lyrics")
    embedded_lyrics_status = _lyrics_status(lyrics)
    youtube_music_track_id = _text(row, "LMS_YOUTUBE_MUSIC_TRACK_ID")
    if not youtube_music_track_id:
        youtube_music_track_id = _legacy_youtube_id(_text(row, "Comment"))
    resolved_id = _text(row, "LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID")
    resolved_id = resolved_id or youtube_music_track_id
    date_value = _normalize_date(_text(row, "ContentCreateDate"))
    year = _integer(row, "Year")
    if year is None and date_value and re.match(r"^\d{4}", date_value):
        year = int(date_value[:4])
    duration = _number(_value(row, "Duration"))
    bitrate = _number(_value(row, "AvgBitrate"))
    metadata: dict[str, Any] = {
        "managed_by_app": _integer(row, "LMS_TAG_SCHEMA_VERSION") is not None,
        "tag_schema_version": _integer(row, "LMS_TAG_SCHEMA_VERSION"),
        "youtube_music_track_id": youtube_music_track_id,
        "spotify_track_id": _text(row, "LMS_SPOTIFY_TRACK_ID"),
        "soundcloud_track_id": _text(row, "LMS_SOUNDCLOUD_TRACK_ID"),
        "resolved_youtube_music_track_id": resolved_id,
        "source_origin": _text(row, "LMS_SOURCE_ORIGIN"),
        "resolution_method": _text(row, "LMS_RESOLUTION_METHOD"),
        "catalog_release_browse_id": _text(row, "LMS_CATALOG_RELEASE_BROWSE_ID"),
        "catalog_release_title": _text(row, "LMS_CATALOG_RELEASE_TITLE"),
        "catalog_release_kind": _text(row, "LMS_CATALOG_RELEASE_KIND"),
        "artist_credits": _json_array(row, "LMS_ARTIST_CREDITS"),
        "title": _text(row, "Title"),
        "artist": _text(row, "Artist"),
        "album": _text(row, "Album"),
        "album_artist": _text(row, "AlbumArtist"),
        "track_number": _integer(row, "TrackNumber"),
        "track_total": _integer_total(row, "TrackTotal", "TrackNumber"),
        "disc_number": _integer(row, "DiscNumber", "DiskNumber"),
        "disc_total": _integer_total(row, "DiscTotal", "DiscNumber")
        or _integer_total(row, "DiskTotal", "DiskNumber"),
        "year": year,
        "date": date_value,
        "genre": _text(row, "Genre"),
        "language": _text(row, "Language", "LANGUAGE"),
        "isrc": _text(row, "ISRC"),
        "mb_track_id": _text(row, "MusicBrainzTrackId"),
        "mb_album_id": _text(row, "MusicBrainzAlbumId"),
        "mb_releasegroup_id": _text(row, "MusicBrainzReleaseGroupId"),
        "embedded_lyrics_status": embedded_lyrics_status,
        "embedded_lyrics_sha256": hashlib.sha256(lyrics.encode()).hexdigest()
        if lyrics is not None
        else None,
        "artwork_sha256": _binary_hash(row.get("CoverArt")),
        "cover_art_present": row.get("CoverArt") is not None,
        "format": _text(row, "FileType") or "unknown",
        "duration_seconds": duration,
        "bitrate": int(bitrate * 1000) if bitrate is not None and bitrate < 10000 else int(bitrate)
        if bitrate is not None
        else None,
    }
    metadata["tag_fingerprint"] = tag_fingerprint(metadata)
    return metadata


def _run_exiftool(paths: list[Path], exiftool_path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index in range(0, len(paths), 100):
        batch = paths[index : index + 100]
        result = subprocess.run(
            [
                exiftool_path,
                "-json",
                "-b",
                "-n",
                "-charset",
                "filename=UTF8",
                *(f"-{field}" for field in EXIFTOOL_FIELDS),
                *(str(path) for path in batch),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        try:
            parsed = json.loads(result.stdout or "[]")
        except json.JSONDecodeError:
            result.check_returncode()
            raise
        if result.returncode != 0 and not parsed:
            result.check_returncode()
        if isinstance(parsed, list):
            rows.extend(row for row in parsed if isinstance(row, dict))
    return rows


def resolve_exiftool_path() -> str:
    configured = os.environ.get("LMS_EXIFTOOL_PATH")
    if configured:
        return configured
    bundled = Path(__file__).resolve().parents[3] / "resources" / "bin" / "exiftool"
    return str(bundled) if bundled.is_file() else "exiftool"


def scan_directory(
    root: Path, exiftool_path: str | None = None
) -> list[dict[str, Any]]:
    exiftool_path = exiftool_path or resolve_exiftool_path()
    paths = sorted(path for path in root.rglob("*") if path.suffix.lower() == ".m4a")
    rows = _run_exiftool(paths, exiftool_path)
    results: list[dict[str, Any]] = []
    for row in rows:
        source = Path(str(row.get("SourceFile") or ""))
        relative_path = source.relative_to(root).as_posix()
        lrc_path = source.with_suffix(".lrc")
        sidecar_bytes = lrc_path.read_bytes() if lrc_path.is_file() else None
        results.append(
            {
                "relative_path": relative_path,
                "source_file": str(source),
                "sidecar_sha256": hashlib.sha256(sidecar_bytes).hexdigest()
                if sidecar_bytes is not None
                else None,
                **canonicalize_exiftool_row(row),
            }
        )
    return results


def scan_file(path: Path, exiftool_path: str | None = None) -> dict[str, Any]:
    exiftool_path = exiftool_path or resolve_exiftool_path()
    rows = _run_exiftool([path], exiftool_path)
    if len(rows) != 1:
        raise ValueError(f"ExifTool returned {len(rows)} rows for {path}")
    return canonicalize_exiftool_row(rows[0])


def remote_identities(root: Path, exiftool_path: str = "exiftool") -> dict[str, Any]:
    identities = scan_directory(root, exiftool_path)
    return {
        "filesScanned": len(identities),
        "identities": [
            {
                "relativePath": value["relative_path"],
                "youtubeMusicTrackId": value["youtube_music_track_id"],
                "resolvedYoutubeMusicTrackId": value[
                    "resolved_youtube_music_track_id"
                ],
                "tagFingerprint": value["tag_fingerprint"],
                "sidecarSha256": value["sidecar_sha256"],
            }
            for value in identities
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--exiftool", default="exiftool")
    parser.add_argument("--remote-identities", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    result: Any = (
        remote_identities(root, args.exiftool)
        if args.remote_identities
        else scan_directory(root, args.exiftool)
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
