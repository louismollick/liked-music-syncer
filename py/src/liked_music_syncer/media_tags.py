from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from mediafile import Image, MP4StorageStyle, MediaField, MediaFile

from .models import SyncItemState

LMS_TAG_SCHEMA_VERSION = 4
LMS_CUSTOM_FIELDS: dict[str, MediaField] = {
    "lms_tag_schema_version": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_TAG_SCHEMA_VERSION")
    ),
    "lms_youtube_music_track_id": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_YOUTUBE_MUSIC_TRACK_ID")
    ),
    "lms_spotify_track_id": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_SPOTIFY_TRACK_ID")
    ),
    "lms_soundcloud_track_id": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_SOUNDCLOUD_TRACK_ID")
    ),
    "lms_resolved_youtube_music_track_id": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID")
    ),
    "lms_source_origin": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_SOURCE_ORIGIN")
    ),
    "lms_resolution_method": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_RESOLUTION_METHOD")
    ),
    "lms_catalog_release_browse_id": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_CATALOG_RELEASE_BROWSE_ID")
    ),
    "lms_catalog_release_title": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_CATALOG_RELEASE_TITLE")
    ),
    "lms_catalog_release_kind": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_CATALOG_RELEASE_KIND")
    ),
    "lms_artist_credits": MediaField(
        MP4StorageStyle("----:com.apple.iTunes:LMS_ARTIST_CREDITS")
    ),
}

_MEDIAFILE_FIELDS_REGISTERED = False
_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,}$")


def register_lms_mediafile_fields() -> None:
    global _MEDIAFILE_FIELDS_REGISTERED
    if _MEDIAFILE_FIELDS_REGISTERED:
        return

    for name, descriptor in LMS_CUSTOM_FIELDS.items():
        if name in MediaFile.__dict__:
            continue
        MediaFile.add_field(name, descriptor)

    _MEDIAFILE_FIELDS_REGISTERED = True


def parse_youtube_track_id_from_url(value: str | None) -> str | None:
    if not value:
        return None

    parsed = urlparse(value.strip())
    candidate: str | None = None
    if parsed.query:
        candidate = parse_qs(parsed.query).get("v", [None])[0]
    if not candidate and parsed.netloc.endswith("youtu.be"):
        candidate = parsed.path.strip("/").split("/")[0] if parsed.path.strip("/") else None
    if not candidate and parsed.path:
        last_segment = parsed.path.strip("/").split("/")[-1]
        candidate = last_segment or None

    if isinstance(candidate, str) and _YOUTUBE_ID_RE.fullmatch(candidate):
        return candidate
    return None


def read_legacy_youtube_track_id(path: Path) -> str | None:
    register_lms_mediafile_fields()
    media = MediaFile(str(path))
    comments = getattr(media, "comments", None)
    if isinstance(comments, str):
        return parse_youtube_track_id_from_url(comments)
    return None


def write_media_tags(
    output_path: Path,
    item: SyncItemState,
    cover_bytes: bytes | None,
    lyrics_text: str | None,
) -> None:
    register_lms_mediafile_fields()
    media = MediaFile(str(output_path))

    media.title = item.title
    media.artist = item.artist
    media.album = item.album
    media.albumartist = item.album_artist
    media.track = item.track_number
    media.tracktotal = item.track_total
    media.disc = item.disc_number
    media.disctotal = item.disc_total
    media.date = _parse_release_date(item.date)
    media.year = item.year
    media.genre = item.genre
    media.language = item.language
    media.isrc = item.isrc
    media.mb_trackid = item.mb_track_id
    media.mb_albumid = item.mb_album_id
    media.mb_releasegroupid = item.mb_releasegroup_id
    media.lyrics = lyrics_text
    media.images = [Image(data=cover_bytes)] if cover_bytes else []

    source_id: str | None = item.youtube_music_track_id
    if not source_id and output_path.exists():
        source_id = read_legacy_youtube_track_id(output_path)
    resolved_id = item.resolved_youtube_music_track_id or source_id

    media.lms_tag_schema_version = str(LMS_TAG_SCHEMA_VERSION)
    media.lms_youtube_music_track_id = source_id
    media.lms_spotify_track_id = item.spotify_track_id or ""
    media.lms_soundcloud_track_id = item.soundcloud_track_id or ""
    media.lms_resolved_youtube_music_track_id = resolved_id or ""
    media.lms_source_origin = item.source_origin or ""
    media.lms_resolution_method = item.resolution_method or "unresolved"
    media.lms_catalog_release_browse_id = item.catalog_release_browse_id or ""
    media.lms_catalog_release_title = item.catalog_release_title or ""
    media.lms_catalog_release_kind = item.catalog_release_kind or ""
    media.lms_artist_credits = json.dumps(
        item.artist_credits, ensure_ascii=False, separators=(",", ":")
    )
    media.comments = None
    media.save()


def _parse_release_date(value: str | None) -> date | None:
    if not value:
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
