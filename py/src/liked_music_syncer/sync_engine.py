from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import shutil
import subprocess
import tempfile
import time
import traceback
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from yt_dlp import YoutubeDL
from yt_dlp.globals import all_plugins_loaded, plugin_dirs
from yt_dlp.plugins import load_all_plugins
from ytmusicapi import YTMusic
from ytmusicapi.parsers.watch import parse_watch_playlist

from .album_identity import UNKNOWN_ALBUM_NAME, canonical_album_name, is_unknown_album_value
from .auth import build_browser_auth_client, resolve_yt_dlp_cookie_source
from .cover_art import make_square_cover
from .json_io import emit_event
from .lyrics import classify_lyrics_text, is_zero_timestamp_only_lrc, lyrics_sidecar_text
from .lyrics_language import detect_primary_lyrics_language
from .media_tags import apply_managed_musicbrainz_policy, write_media_tags
from .models import SyncConfig, SyncItemState, normalize_artist_credits
from .templating import OutputLayout

JOB_LOG_ITEM_ID = "__job__"
JOB_LOG_SOURCE_VIDEO_ID = "__job__"
SPOTIFY_WEB_BASE_URL = "https://open.spotify.com"
SPOTIFY_SECRETS_URL = (
    "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json"
)
SPOTIFY_PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query"
SPOTIFY_SEARCH_QUERY_HASH = "d9f785900f0710b31c07818d617f4f7600c1e21217e80f5b043d1e78d74e6026"
SPOTIFY_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
)
SPOTIFY_SECRET_CACHE_TTL_MS = 60 * 60 * 1000
_SPOTIFY_CACHE: dict[str, Any] = {
    "access_token": None,
    "access_token_expires_at": 0,
    "client_version": None,
    "secret_version": None,
    "secret_bytes": None,
    "secrets_fetched_at": 0,
}
MUSICBRAINZ_GENRE_LIMIT = 3
MUSICBRAINZ_REQUEST_INTERVAL_SECONDS = 1.0
_MUSICBRAINZ_GENRE_CACHE: dict[tuple[str, str], tuple[str, ...]] = {}
_MUSICBRAINZ_LAST_REQUEST_AT = 0.0
CATALOG_SEARCH_RESULT_LIMIT = 20
CATALOG_SEARCH_QUERY_LIMIT = 6
CATALOG_MV_DURATION_TOLERANCE_SECONDS = 60
CATALOG_DEFAULT_DURATION_TOLERANCE_SECONDS = 45
CATALOG_ORIGINAL_TITLE_LOOKUP_LIMIT = 3
YOUTUBE_OEMBED_URL = "https://www.youtube.com/oembed"
_VERSION_MARKER_PATTERNS: dict[str, re.Pattern[str]] = {
    "cover": re.compile(r"\bcover\b|カバー|弾いてみた|歌ってみた", re.IGNORECASE),
    "live": re.compile(r"\blive\b|ライブ", re.IGNORECASE),
    "remix": re.compile(r"\bremix\b|リミックス", re.IGNORECASE),
    "edit": re.compile(r"\bedit\b", re.IGNORECASE),
    "acoustic": re.compile(r"\bacoustic\b|アコースティック", re.IGNORECASE),
    "instrumental": re.compile(r"\binstrumental\b|インスト(?:ゥルメンタル)?", re.IGNORECASE),
    "demo": re.compile(r"\bdemo\b|デモ", re.IGNORECASE),
    "karaoke": re.compile(r"\bkaraoke\b|カラオケ", re.IGNORECASE),
    "short": re.compile(r"\bshort\s*(?:ver(?:sion)?\.?)?\b|ショート", re.IGNORECASE),
    "sped_up": re.compile(r"\bsped\s*up\b", re.IGNORECASE),
    "slowed": re.compile(r"\bslowed\b", re.IGNORECASE),
}


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(tz=UTC).isoformat()


def _slug(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def _log(
    job_id: str,
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
            "job_id": job_id,
            "item_id": item.id,
            "youtube_music_track_id": item.youtube_music_track_id,
            "timestamp": _now_iso(),
            "level": level,
            "stage": stage,
            "event": event,
            "message": message,
            "context": context or {},
        }
    )


def _run_log(
    job_id: str,
    stage: str,
    level: str,
    event: str,
    message: str,
    context: dict[str, Any] | None = None,
) -> None:
    emit_event(
        {
            "type": "log",
            "job_id": job_id,
            "item_id": JOB_LOG_ITEM_ID,
            "youtube_music_track_id": JOB_LOG_SOURCE_VIDEO_ID,
            "timestamp": _now_iso(),
            "level": level,
            "stage": stage,
            "event": event,
            "message": message,
            "context": context or {},
        }
    )


def _emit_job_event(
    job_id: str,
    event: str,
    stage: str,
    message: str,
    total_count: int | None = None,
    context: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "type": "job",
        "event": event,
        "job_id": job_id,
        "stage": stage,
        "message": message,
    }
    if total_count is not None:
        payload["total_count"] = total_count
    if context:
        payload["context"] = context
    emit_event(payload)


def _emit_item(job_id: str, item: SyncItemState) -> None:
    emit_event(
        {
            "type": "track",
            "event": "upsert",
            "job_id": job_id,
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
    album = canonical_album_name(str(album_info.get("name") or ""))
    item = SyncItemState(
        id=str(track.get("trackWorkId") or _slug("item")),
        source_video_id=video_id,
        youtube_music_track_id=video_id,
        spotify_track_id=_signature_str(track.get("spotifyTrackId")),
        soundcloud_track_id=_signature_str(track.get("soundcloudTrackId")),
        resolved_youtube_music_track_id=_signature_str(
            track.get("resolvedYoutubeMusicTrackId")
        )
        or video_id,
        source_origin=str(track.get("sourceOrigin")) if track.get("sourceOrigin") else None,
        catalog_release_browse_id=str(track.get("catalogReleaseBrowseId"))
        if track.get("catalogReleaseBrowseId")
        else None,
        catalog_release_title=str(track.get("catalogReleaseTitle"))
        if track.get("catalogReleaseTitle")
        else None,
        catalog_release_kind=str(track.get("catalogReleaseKind"))
        if track.get("catalogReleaseKind")
        else None,
        title=title,
        artist=artist,
        album=album,
        album_artist=str(track.get("albumArtist") or artist),
        source_url=str(
            track.get("sourceUrl")
            or f"https://music.youtube.com/watch?v={video_id}"
        ),
        cover_art_url=_pick_thumbnail(track.get("thumbnails")),
        artist_credits=normalize_artist_credits(track.get("artistCredits") or track.get("artists")),
        source_kind=str(track.get("sourceKind") or track.get("likeStatus") or "liked_song"),
        video_type=str(track.get("videoType")) if track.get("videoType") else None,
        track_number=_signature_int(track.get("trackNumber")),
        track_total=_signature_int(track.get("trackTotal")),
        disc_number=_signature_int(track.get("discNumber")),
        disc_total=_signature_int(track.get("discTotal")),
        year=_parse_year(track.get("year")),
        date=_signature_str(track.get("date")),
        genre=_signature_str(track.get("genre")),
        language=_signature_str(track.get("language")),
        isrc=_signature_str(track.get("isrc")),
        mb_track_id=_signature_str(track.get("mbTrackId")),
        mb_album_id=_signature_str(track.get("mbAlbumId")),
        mb_releasegroup_id=_signature_str(track.get("mbReleaseGroupId")),
        selected_source_url=_signature_str(track.get("selectedSourceUrl")),
    )
    if item.catalog_release_title and is_unknown_album_value(item.album):
        item.album = item.catalog_release_title
    _refresh_normalized_fields(item)
    return item


def _build_ytmusic_client(browser_auth_input: str) -> YTMusic:
    return build_browser_auth_client(browser_auth_input)


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


def _normalized_primary_artist(value: str) -> str:
    return _normalize_text(value.split(",")[0].strip()) if value else ""


def _refresh_normalized_fields(item: SyncItemState) -> None:
    item.normalized_primary_artist = _normalized_primary_artist(item.artist)
    item.normalized_title = _normalize_text(_canonicalize_track_title(item.title, [item.artist]))


def _release_identity(item: SyncItemState) -> str | None:
    if item.catalog_release_browse_id:
        return item.catalog_release_browse_id
    if item.mb_album_id:
        return item.mb_album_id
    return None


def _signature_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _signature_int(value: Any) -> int | None:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _signature_normalized_artist(signature: dict[str, Any]) -> str:
    return _normalized_primary_artist(str(signature.get("artist") or ""))


def _signature_normalized_title(signature: dict[str, Any]) -> str:
    return _normalize_text(str(signature.get("title") or ""))


def _strip_title_adornments(value: str) -> str:
    cleaned = value.strip()
    while True:
        updated = re.sub(
            r"[\(\[\{（【][^)\]\}）】]*"
            r"(?:official|music\s*video|official\s*mv|mv|pv|lyrics?|audio|"
            r"visualizer|visualiser|hd|hq|4k|sub(?:bed|titles?)?)"
            r"[^)\]\}）】]*[\)\]\}）】]",
            " ",
            cleaned,
            flags=re.IGNORECASE,
        ).strip()
        updated = re.sub(
            r"\s*[\(\[\{（【][^)\]\}）】]*(?:official|music video|official video|official mv|mv|audio|visualizer|lyrics?)[^)\]\}）】]*[\)\]\}）】]\s*$",
            "",
            updated,
            flags=re.IGNORECASE,
        ).strip()
        updated = re.sub(
            r"\s*(?:-|:|\||/)?\s*(?:official(?:\s+music)?\s+video|official\s+mv|music\s+video|mv|lyrics?|audio|visualizer)\s*$",
            "",
            updated,
            flags=re.IGNORECASE,
        ).strip()
        updated = re.sub(
            r"\s*(?:official(?:\s+music)?\s+video|official\s+mv|music\s+video|mv|lyrics?|audio|visualizer)\s*$",
            "",
            updated,
            flags=re.IGNORECASE,
        ).strip()
        if updated == cleaned:
            return re.sub(r"\s+", " ", updated).strip()
        cleaned = re.sub(r"\s+", " ", updated).strip()


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
        if updated == cleaned:
            updated = re.sub(
                rf"^\s*{re.escape(artist_name)}(?=\s|[\"'“”‘’「『〈《])\s*",
                "",
                cleaned,
                count=1,
                flags=re.IGNORECASE,
            ).strip()
        if updated != cleaned:
            cleaned = updated
            break
    quoted = re.fullmatch(r"[\"'“”‘’「『〈《](.+?)[\"'“”‘’」』〉》]\s*", cleaned)
    if quoted and quoted.group(1).strip():
        cleaned = quoted.group(1).strip()
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


def _clean_channel_artist(value: str) -> str:
    cleaned = re.sub(
        r"\s*(?:official(?:\s+youtube)?(?:\s+channel)?|topic|vevo)\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    ).strip()
    return cleaned or value.strip()


def _artist_title_identities(
    item: SyncItemState,
    primary: dict[str, Any],
) -> list[tuple[str, str, str]]:
    watch_artists = _string_list_names(primary.get("artists"))
    known_artists = [*watch_artists, item.artist]
    identities: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(title: str, artist: str, method: str) -> None:
        cleaned_title = title.strip(" \t-_—–:|/『』「」\"'“”")
        cleaned_artist = _clean_channel_artist(artist)
        key = (_normalize_text(cleaned_title), _normalize_text(cleaned_artist))
        if not key[0] or not key[1] or key in seen:
            return
        seen.add(key)
        identities.append((cleaned_title, cleaned_artist, method))

    for artist in known_artists:
        if artist:
            add(_canonicalize_track_title(item.title, [artist]), artist, "source")

    for title in (item.title,):
        split = re.split(
            r"\s+(?:[-–—|／/]|_{1,2})\s+|\s*[-–—|／/]\s*(?=[『「【])",
            title,
            maxsplit=1,
        )
        if len(split) == 2:
            parsed_artist = split[0].strip()
            parsed_title = _canonicalize_track_title(split[1], [parsed_artist])
            add(parsed_title, parsed_artist, "parsed_separator")

        quoted = re.match(r"^(.+?)[『「](.+?)[』」]", title)
        if quoted:
            add(quoted.group(2), quoted.group(1), "parsed_quote")

        for quoted_title in re.findall(r"[\"“”『「](.+?)[\"“”』」]", title):
            for artist in known_artists:
                if artist:
                    add(quoted_title, artist, "quoted_title")

    return identities


def _text_similarity(left: str | None, right: str | None) -> float:
    normalized_left = _normalize_text(left or "")
    normalized_right = _normalize_text(right or "")
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left == normalized_right:
        return 1.0
    if normalized_left in normalized_right or normalized_right in normalized_left:
        length_ratio = min(len(normalized_left), len(normalized_right)) / max(
            len(normalized_left), len(normalized_right)
        )
        return 0.9 + (0.1 * length_ratio)
    return SequenceMatcher(None, normalized_left, normalized_right).ratio()


def _identity_scores_match(title_score: float, artist_score: float) -> bool:
    return (title_score >= 0.96 and artist_score >= 0.88) or (
        title_score >= 0.88 and artist_score >= 0.82
    )


def _youtube_original_title(video_id: str) -> str | None:
    try:
        response = httpx.get(
            YOUTUBE_OEMBED_URL,
            params={
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "format": "json",
            },
            timeout=5.0,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError, TypeError):
        return None

    if not isinstance(payload, dict):
        return None
    title = payload.get("title")
    return title.strip() if isinstance(title, str) and title.strip() else None


def _version_markers(value: str | None) -> set[str]:
    if not value:
        return set()
    return {
        marker
        for marker, pattern in _VERSION_MARKER_PATTERNS.items()
        if pattern.search(value)
    }


def _version_compatible(
    source_title: str,
    source_artist: str,
    candidate: dict[str, Any],
) -> bool:
    source_markers = _version_markers(source_title)
    if not source_markers:
        return True

    candidate_artists = _string_list_names(candidate.get("artists"))
    candidate_text = " ".join(
        [
            str(candidate.get("title") or ""),
            str(_album_info(candidate.get("album")).get("name") or ""),
        ]
    )
    candidate_markers = _version_markers(candidate_text)
    missing = source_markers - candidate_markers
    if not missing:
        return True

    artist_matches = any(
        _text_similarity(candidate_artist, source_artist) >= 0.88
        for candidate_artist in candidate_artists
    )
    # Catalog releases by the same cover/remix performer often omit the version
    # word from the title. Other version mismatches must remain unresolved.
    return missing <= {"cover"} and artist_matches


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


def _walk_dicts(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(_walk_dicts(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_walk_dicts(child))
    return found


def _raw_watch_playlist(ytmusic: YTMusic, video_id: str) -> dict[str, Any]:
    body = {
        "enablePersistentPlaylistPanel": True,
        "isAudioOnly": True,
        "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
        "videoId": video_id,
        "playlistId": f"RDAMVM{video_id}",
        "watchEndpointMusicSupportedConfigs": {
            "watchEndpointMusicConfig": {
                "hasPersistentPlaylistPanel": True,
                "musicVideoType": "MUSIC_VIDEO_TYPE_ATV",
            }
        },
    }
    response = ytmusic._send_request("next", body)
    playlist_panel = next(
        (
            node["playlistPanelRenderer"]
            for node in _walk_dicts(response)
            if isinstance(node.get("playlistPanelRenderer"), dict)
        ),
        None,
    )
    contents = playlist_panel.get("contents", []) if playlist_panel else []
    tracks = parse_watch_playlist(contents) if isinstance(contents, list) else []
    lyrics = next(
        (
            browse_id
            for node in _walk_dicts(response)
            if isinstance(
                browse_id := node.get("browseEndpoint", {}).get("browseId")
                if isinstance(node.get("browseEndpoint"), dict)
                else None,
                str,
            )
            and browse_id.startswith("MPLYt_")
        ),
        None,
    )
    return {"tracks": tracks, "lyrics": lyrics}


def _song_metadata_track(ytmusic: YTMusic, video_id: str) -> dict[str, Any]:
    payload = ytmusic.get_song(video_id)
    details = payload.get("videoDetails") if isinstance(payload, dict) else None
    if not isinstance(details, dict):
        return {}
    author = details.get("author")
    thumbnails = details.get("thumbnail", {}).get("thumbnails")
    return {
        "videoId": details.get("videoId") or video_id,
        "title": details.get("title"),
        "length": details.get("lengthSeconds"),
        "videoType": details.get("musicVideoType"),
        "artists": [{"name": author, "id": details.get("channelId")}]
        if isinstance(author, str) and author
        else [],
        "thumbnails": thumbnails if isinstance(thumbnails, list) else [],
    }


def _get_watch_playlist_resilient(
    ytmusic: YTMusic,
    video_id: str,
) -> dict[str, Any]:
    try:
        watch = ytmusic.get_watch_playlist(videoId=video_id, limit=1)
        if isinstance(watch, dict) and _extract_tracks(watch):
            return watch
    except (KeyError, IndexError, TypeError):
        # ytmusicapi <=1.12 assumes every watch tab has a browse endpoint.
        # Current responses may include Comments or Related tabs without one.
        pass

    try:
        watch = _raw_watch_playlist(ytmusic, video_id)
        if _extract_tracks(watch):
            return watch
    except Exception:  # noqa: BLE001
        pass

    track = _song_metadata_track(ytmusic, video_id)
    return {"tracks": [track] if track else [], "lyrics": None}


def _apply_watch_metadata(item: SyncItemState, track: dict[str, Any]) -> None:
    item.metadata_matched = True
    item.title = str(track.get("title") or item.title)
    artists = _string_list_names(track.get("artists"))
    if artists:
        item.artist = ", ".join(artists)
        item.album_artist = item.artist
    credits = normalize_artist_credits(track.get("artists"))
    if credits:
        item.artist_credits = credits
    item.video_type = str(track.get("videoType")) if track.get("videoType") else item.video_type
    item.cover_art_url = _pick_thumbnail(track.get("thumbnails") or track.get("thumbnail")) or item.cover_art_url
    isrc = track.get("isrc")
    if isinstance(isrc, str) and isrc:
        item.isrc = isrc
    _refresh_normalized_fields(item)


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

    album_tracks = _extract_tracks(album)
    normalized_fallback_title = _normalize_text(fallback_title)
    matched_track: dict[str, Any] | None = None
    matched_track_number: int | None = None

    for preferred_video_id in preferred_video_ids:
        for track_index, track in enumerate(album_tracks, start=1):
            if str(track.get("videoId")) != preferred_video_id:
                continue
            matched_track = track
            matched_track_number = track_index
            break
        if matched_track is not None:
            break

    if matched_track is None and len(album_tracks) == 1:
        only_track = album_tracks[0]
        track_title = only_track.get("title")
        if (
            isinstance(track_title, str)
            and _text_similarity(track_title, normalized_fallback_title) >= 0.96
        ):
            matched_track = only_track
            matched_track_number = 1

    if matched_track is None:
        return False

    item.album = str(album.get("title") or item.album)
    item.catalog_release_browse_id = album_id
    item.catalog_release_title = item.album
    album_artists = _string_list_names(album.get("artists"))
    if album_artists:
        item.album_artist = ", ".join(album_artists)

    year = _parse_year(album.get("year"))
    if year is not None:
        item.year = year

    item.track_total = len(album_tracks) or None
    item.track_number = matched_track_number
    track_title = matched_track.get("title")
    if isinstance(track_title, str) and track_title:
        item.title = track_title
    _refresh_normalized_fields(item)
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
    identities = _artist_title_identities(item, primary)
    if not identities:
        identities = [(item.title, item.artist.split(",")[0].strip(), "fallback")]
    original_duration = _parse_duration_seconds(primary.get("length"))
    duration_tolerance = (
        CATALOG_MV_DURATION_TOLERANCE_SECONDS
        if _is_omv(item.video_type)
        else CATALOG_DEFAULT_DURATION_TOLERANCE_SECONDS
    )
    queries: list[str] = []
    seen_queries: set[str] = set()
    for title, artist, _ in identities:
        query = f"{title} {artist}".strip()
        normalized_query = _normalize_text(query)
        if normalized_query and normalized_query not in seen_queries:
            seen_queries.add(normalized_query)
            queries.append(query)
        if len(queries) >= CATALOG_SEARCH_QUERY_LIMIT:
            break

    if run_id:
        _log(
            run_id,
            item,
            item.stage,
            "info",
            "search-catalog-start",
            "Searching for catalog song candidate.",
            {
                "queries": queries,
                "identities": [
                    {"title": title, "artist": artist, "method": method}
                    for title, artist, method in identities
                ],
                "video_type": item.video_type,
                "title": item.title,
                "artist": item.artist,
            },
        )

    results_by_video_id: dict[str, dict[str, Any]] = {}
    for query in queries:
        results = ytmusic.search(
            query,
            filter="songs",
            limit=CATALOG_SEARCH_RESULT_LIMIT,
            ignore_spelling=False,
        )
        for result in results:
            if not isinstance(result, dict):
                continue
            video_id = result.get("videoId")
            if isinstance(video_id, str) and video_id:
                results_by_video_id[video_id] = result

    ranked_candidates: list[tuple[tuple[float, ...], dict[str, Any]]] = []
    candidate_logs: list[dict[str, Any]] = []
    original_title_lookups = 0

    for result in results_by_video_id.values():
        candidate_video_id = result.get("videoId")
        candidate_title = result.get("title")
        candidate_album_id = _album_info(result.get("album")).get("id")
        candidate_artist_ids = _artist_ids(result.get("artists"))
        candidate_artist_names = _string_list_names(result.get("artists"))
        candidate_duration = _parse_duration_seconds(result.get("duration"))
        duration_diff = (
            abs(candidate_duration - original_duration)
            if candidate_duration is not None and original_duration is not None
            else 0
        )
        artist_id_matches = bool(
            original_artist_ids and candidate_artist_ids and set(original_artist_ids) & set(candidate_artist_ids)
        )
        best_identity: tuple[str, str, str] | None = None
        best_identity_score: tuple[float, float, float] = (0.0, 0.0, 0.0)
        for target_title, target_artist, method in identities:
            title_score = _text_similarity(
                str(candidate_title) if isinstance(candidate_title, str) else None,
                target_title,
            )
            artist_score = max(
                (
                    _text_similarity(candidate_artist, target_artist)
                    for candidate_artist in candidate_artist_names
                ),
                default=0.0,
            )
            identity_score = (title_score + artist_score, title_score, artist_score)
            if identity_score > best_identity_score:
                best_identity_score = identity_score
                best_identity = (target_title, target_artist, method)

        _, title_score, artist_score = best_identity_score
        if artist_id_matches:
            artist_score = 1.0
        duration_matches = original_duration is None or candidate_duration is None or duration_diff <= duration_tolerance
        video_type = str(result.get("videoType")) if result.get("videoType") else None
        same_source_video = isinstance(candidate_video_id, str) and candidate_video_id == item.source_video_id
        missing_album_id = not (isinstance(candidate_album_id, str) and candidate_album_id)
        version_matches = _version_compatible(item.title, item.artist, result)
        identity_matches = _identity_scores_match(title_score, artist_score)
        original_youtube_title: str | None = None
        if (
            not identity_matches
            and isinstance(candidate_video_id, str)
            and candidate_video_id
            and not missing_album_id
            and artist_score >= 0.88
            and duration_matches
            and version_matches
            and original_title_lookups < CATALOG_ORIGINAL_TITLE_LOOKUP_LIMIT
        ):
            original_title_lookups += 1
            original_youtube_title = _youtube_original_title(candidate_video_id)
            for target_title, target_artist, method in identities:
                alternate_title_score = _text_similarity(original_youtube_title, target_title)
                alternate_artist_score = max(
                    (
                        _text_similarity(candidate_artist, target_artist)
                        for candidate_artist in candidate_artist_names
                    ),
                    default=0.0,
                )
                alternate_identity_score = (
                    alternate_title_score + alternate_artist_score,
                    alternate_title_score,
                    alternate_artist_score,
                )
                if alternate_identity_score > best_identity_score:
                    best_identity_score = alternate_identity_score
                    best_identity = (target_title, target_artist, f"{method}_youtube_title")

        _, title_score, artist_score = best_identity_score
        if artist_id_matches:
            artist_score = 1.0
        target_title, target_artist, match_method = best_identity or (
            item.title,
            item.artist,
            "fallback",
        )
        identity_matches = _identity_scores_match(title_score, artist_score)
        accepted = bool(
            isinstance(candidate_video_id, str)
            and not missing_album_id
            and identity_matches
            and duration_matches
            and version_matches
        )

        if run_id:
            rejection_reasons = {
                "title_score": title_score,
                "artist_score": artist_score,
                "duration_match": duration_matches,
                "duration_diff": duration_diff if original_duration is not None and candidate_duration is not None else None,
                "same_source_video": same_source_video,
                "missing_album_id": missing_album_id,
                "version_match": version_matches,
            }
            candidate_logs.append(
                {
                    "video_id": candidate_video_id,
                    "title": candidate_title,
                    "original_youtube_title": original_youtube_title,
                    "album_id": candidate_album_id,
                    "video_type": video_type,
                    "accepted": accepted,
                    "match_method": match_method,
                    "target_title": target_title,
                    "target_artist": target_artist,
                    "artist_match_mode": "id" if artist_id_matches else "name_score",
                    "rejection": rejection_reasons,
                }
            )

        if not accepted:
            continue

        score = (
            1.0 if title_score >= 0.96 else 0.0,
            1.0 if artist_id_matches else artist_score,
            title_score,
            1.0 if video_type == "MUSIC_VIDEO_TYPE_ATV" else 0.0,
            -float(duration_diff),
            0.0 if same_source_video else 1.0,
        )
        ranked_candidates.append((score, result))

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

    if not ranked_candidates:
        return None
    ranked_candidates.sort(key=lambda entry: entry[0], reverse=True)
    best_score, best_candidate = ranked_candidates[0]
    if len(ranked_candidates) > 1:
        runner_up_score = ranked_candidates[1][0]
        # Reject genuinely ambiguous fuzzy matches. Exact title matches remain
        # deterministic and are ranked by artist identity, type, and duration.
        if best_score[0] == 0.0 and best_score[:3] == runner_up_score[:3]:
            return None
    return best_candidate


def _resolve_exact_catalog(
    ytmusic: YTMusic,
    item: SyncItemState,
    *,
    run_id: str | None = None,
) -> str | None:
    watch = _get_watch_playlist_resilient(ytmusic, item.source_video_id)
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

    candidate = _search_song_candidate(ytmusic, item, primary, run_id=run_id)
    if not candidate:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate_video_id = candidate.get("videoId")
    if not isinstance(candidate_video_id, str) or not candidate_video_id:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    try:
        candidate_watch = _get_watch_playlist_resilient(ytmusic, candidate_video_id)
    except Exception:  # noqa: BLE001
        candidate_watch = {"tracks": [], "lyrics": None}

    candidate_tracks = _extract_tracks(candidate_watch)
    candidate_primary = candidate_tracks[0] if candidate_tracks else candidate
    candidate_album_id = _album_id_for_track(candidate_primary) or str(_album_info(candidate.get("album")).get("id") or "")
    if not candidate_album_id:
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    candidate_lyrics_id = candidate_watch.get("lyrics")
    candidate_lyrics_browse_id = candidate_lyrics_id if isinstance(candidate_lyrics_id, str) else None

    if not _apply_album_metadata(
        ytmusic,
        item,
        candidate_album_id,
        [candidate_video_id, item.source_video_id],
        item.title,
    ):
        item.resolution_method = "watch_playlist"
        return lyrics_browse_id

    item.selected_source_url = (
        f"https://music.youtube.com/watch?v={candidate_video_id}"
        if candidate_video_id != item.source_video_id
        else None
    )
    item.resolved_youtube_music_track_id = candidate_video_id
    _apply_watch_metadata(item, candidate_primary)
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


def _album_section_results(ytmusic: YTMusic, section: Any) -> list[dict[str, Any]]:
    if not isinstance(section, dict):
        return []

    results = [item for item in section.get("results", []) if isinstance(item, dict)] if isinstance(section.get("results"), list) else []
    browse_id = section.get("browseId")
    params = section.get("params")
    if isinstance(browse_id, str) and browse_id and isinstance(params, str) and params:
        expanded = ytmusic.get_artist_albums(browse_id, params, limit=None)
        if isinstance(expanded, list):
            results = [item for item in expanded if isinstance(item, dict)]
    return results


def _catalog_track_key(track: dict[str, Any]) -> tuple[str, str]:
    release_browse_id = track.get("catalogReleaseBrowseId")
    if isinstance(release_browse_id, str) and release_browse_id:
        video_id = track.get("videoId")
        track_index = _signature_int(track.get("trackNumber"))
        if isinstance(video_id, str) and video_id:
            return ("release", f"{release_browse_id}|{track_index or 0}|{video_id}")
    video_id = track.get("videoId")
    if isinstance(video_id, str) and video_id:
        return ("video", video_id)
    artists = ", ".join(_string_list_names(track.get("artists")))
    album = _album_info(track.get("album")).get("name") or track.get("album")
    fallback = "|".join(
        [
            _normalize_text(str(artists)),
            _normalize_text(str(track.get("title") or "")),
            _normalize_text(str(album or "")),
        ]
    )
    return ("fallback", fallback)


def _track_rank(track: dict[str, Any]) -> int:
    return 0 if track.get("catalogSource") in {"album", "single"} else 1


def _dedupe_tracks(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for track in tracks:
        key = _catalog_track_key(track)
        if key[1] == "":
            continue
        existing = selected.get(key)
        if existing is None or _track_rank(track) < _track_rank(existing):
            selected[key] = track
    return list(selected.values())


def _album_tracks(
    ytmusic: YTMusic,
    album_result: dict[str, Any],
    *,
    catalog_source: str,
) -> list[dict[str, Any]]:
    browse_id = album_result.get("browseId") or album_result.get("id")
    if not isinstance(browse_id, str) or not browse_id:
        return []

    album = ytmusic.get_album(browse_id)
    if not isinstance(album, dict):
        return []

    album_title = canonical_album_name(str(album.get("title") or album_result.get("title") or ""))
    album_artists = album.get("artists") or album_result.get("artists")
    year = _parse_year(album.get("year"))
    album_tracks = _extract_tracks(album)
    tracks = []
    for track_index, track in enumerate(album_tracks, start=1):
        enriched = dict(track)
        enriched["sourceKind"] = "favorite_artist_catalog"
        enriched["catalogSource"] = catalog_source
        enriched["sourceOrigin"] = "favorite_artist_release"
        enriched["catalogReleaseBrowseId"] = browse_id
        enriched["catalogReleaseTitle"] = album_title
        enriched["catalogReleaseKind"] = catalog_source
        enriched["catalogTrackVideoId"] = track.get("videoId")
        enriched["catalogTrackIndex"] = track_index
        enriched["trackNumber"] = track_index
        enriched["trackTotal"] = len(album_tracks)
        enriched["discNumber"] = _signature_int(track.get("discNumber")) or 1
        enriched["discTotal"] = _signature_int(track.get("discTotal")) or 1
        if year is not None:
            enriched["year"] = year
        enriched.setdefault("album", {"name": album_title, "id": browse_id})
        if not enriched.get("artists") and album_artists:
            enriched["artists"] = album_artists
        if not enriched.get("thumbnails") and album.get("thumbnails"):
            enriched["thumbnails"] = album.get("thumbnails")
        tracks.append(enriched)
    return tracks


def _discover_artist_catalog_tracks(
    ytmusic: YTMusic,
    artist: dict[str, str | None],
) -> list[dict[str, Any]]:
    channel_id = artist.get("channel_id")
    if not channel_id:
        return []

    payload = ytmusic.get_artist(channel_id)
    if not isinstance(payload, dict):
        return []

    tracks: list[dict[str, Any]] = []
    for section_name, catalog_source in (("albums", "album"), ("singles", "single")):
        for album_result in _album_section_results(ytmusic, payload.get(section_name)):
            tracks.extend(_album_tracks(ytmusic, album_result, catalog_source=catalog_source))

    return _dedupe_tracks(tracks)

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
        "js_runtimes": {"node": {}},
        "remote_components": ["ejs:github"],
        "extractor_args": {
            "youtube": {
                "player_client": ["mweb", "default"],
            },
        },
    }
    if config.yt_dlp_cookies_browser.strip():
        options["cookiesfrombrowser"] = resolve_yt_dlp_cookie_source(
            config.yt_dlp_cookies_browser
        )
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
    _refresh_normalized_fields(item)


def _ordered_title_search_queries(value: str, artist_names: list[str]) -> list[str]:
    queries: list[str] = []
    seen: set[str] = set()

    def _add(candidate: str) -> None:
        cleaned = candidate.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            queries.append(cleaned)

    raw_title = value.strip()
    _add(raw_title)

    canonical_title = _canonicalize_track_title(value, artist_names)
    _add(canonical_title)

    for part in re.split(r"\s*(?:-|:|\||/)\s*", canonical_title):
        _add(part)

    return queries


def _musicbrainz_release_sort_key(item: SyncItemState, release: dict[str, Any]) -> tuple[int, int, int, int, str]:
    target_album = _normalize_text(item.album) if item.album else ""
    release_title = release.get("title")
    normalized_release_title = _normalize_text(release_title) if isinstance(release_title, str) and release_title else ""
    title_match_rank = 0 if target_album and normalized_release_title == target_album else 1

    release_date = release.get("date")
    full_date_rank = 0 if isinstance(release_date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", release_date) else 1

    year_match_rank = 1
    if item.year is not None and isinstance(release_date, str) and release_date.startswith(str(item.year)):
        year_match_rank = 0

    country = release.get("country")
    if isinstance(country, str) and country and country != "XW":
        country_rank = 0
    elif country == "XW":
        country_rank = 1
    else:
        country_rank = 2

    release_id = str(release.get("id") or "")
    return (title_match_rank, full_date_rank, year_match_rank, country_rank, release_id)


def _select_musicbrainz_release(item: SyncItemState, release_list: Any) -> dict[str, Any] | None:
    if not isinstance(release_list, list):
        return None

    releases = [release for release in release_list if isinstance(release, dict)]
    if not releases:
        return None

    return min(releases, key=lambda release: _musicbrainz_release_sort_key(item, release))


def _select_musicbrainz_recording(
    item: SyncItemState,
    recordings: Any,
    artist_names: list[str],
) -> dict[str, Any] | None:
    if not isinstance(recordings, list):
        return None

    target_title_variants = _title_variants(item.title, artist_names)
    canonical_title = _normalize_text(_canonicalize_track_title(item.title, artist_names))
    target_album = _normalize_text(item.album) if item.album else ""

    best_recording: dict[str, Any] | None = None
    best_key: tuple[int, int, int, str] | None = None

    for recording in recordings:
        if not isinstance(recording, dict):
            continue

        score = int(recording.get("score", 0) or 0)
        if score < 90:
            continue

        candidate_title = recording.get("title")
        if not isinstance(candidate_title, str) or not candidate_title:
            continue

        candidate_title_variants = _title_variants(candidate_title, artist_names)
        if not target_title_variants & candidate_title_variants:
            continue

        artist_credit = recording.get("artist-credit")
        candidate_artist_names = _string_list_names(artist_credit)
        if candidate_artist_names and not any(
            _normalize_text(candidate) == _normalize_text(target)
            for candidate in candidate_artist_names
            for target in artist_names
        ):
            continue

        candidate_isrcs = recording.get("isrcs")
        if item.isrc and isinstance(candidate_isrcs, list) and candidate_isrcs:
            normalized_isrc = item.isrc.replace("-", "").upper()
            if normalized_isrc not in {
                str(value).replace("-", "").upper() for value in candidate_isrcs
            }:
                continue

        selected_release = _select_musicbrainz_release(item, recording.get("releases"))
        selected_release_title = selected_release.get("title") if isinstance(selected_release, dict) else None
        album_match_rank = 1
        if target_album and isinstance(selected_release_title, str):
            album_match_rank = 0 if _normalize_text(selected_release_title) == target_album else 1

        exact_title_rank = 0 if _normalize_text(candidate_title) == canonical_title else 1
        recording_id = str(recording.get("id") or "")
        sort_key = (album_match_rank, exact_title_rank, -score, recording_id)

        if best_key is None or sort_key < best_key:
            best_key = sort_key
            best_recording = recording

    return best_recording


def _musicbrainz_genres(payload: Any) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("genres"), list):
        return []

    ranked: list[tuple[int, str]] = []
    seen: set[str] = set()
    for genre in payload["genres"]:
        if not isinstance(genre, dict):
            continue
        name = genre.get("name")
        count = genre.get("count")
        if not isinstance(name, str) or not name.strip():
            continue
        if isinstance(count, bool) or not isinstance(count, int | str):
            continue
        try:
            vote_count = int(count)
        except (TypeError, ValueError):
            continue
        normalized_name = name.strip().casefold()
        if vote_count <= 0 or normalized_name in seen:
            continue
        seen.add(normalized_name)
        ranked.append((vote_count, name.strip()))

    ranked.sort(key=lambda entry: (-entry[0], entry[1].casefold()))
    return [name for _, name in ranked[:MUSICBRAINZ_GENRE_LIMIT]]


def _musicbrainz_lookup_genres(entity_type: str, entity_id: str) -> list[str]:
    cache_key = (entity_type, entity_id)
    cached = _MUSICBRAINZ_GENRE_CACHE.get(cache_key)
    if cached is not None:
        return list(cached)

    response = _musicbrainz_get(
        f"https://musicbrainz.org/ws/2/{entity_type}/{entity_id}",
        params={"inc": "genres", "fmt": "json"},
        headers={"User-Agent": "liked-music-syncer/0.1.0"},
        timeout=10.0,
    )
    response.raise_for_status()
    genres = _musicbrainz_genres(response.json())
    _MUSICBRAINZ_GENRE_CACHE[cache_key] = tuple(genres)
    return genres


def _musicbrainz_get(
    url: str,
    *,
    params: dict[str, str],
    headers: dict[str, str],
    timeout: float,
) -> httpx.Response:
    global _MUSICBRAINZ_LAST_REQUEST_AT

    elapsed = time.monotonic() - _MUSICBRAINZ_LAST_REQUEST_AT
    remaining = MUSICBRAINZ_REQUEST_INTERVAL_SECONDS - elapsed
    if remaining > 0:
        time.sleep(remaining)
    _MUSICBRAINZ_LAST_REQUEST_AT = time.monotonic()
    return httpx.get(url, params=params, headers=headers, timeout=timeout)


def _musicbrainz_artist_id(
    recording: dict[str, Any], primary_artist: str
) -> str | None:
    artist_credit = recording.get("artist-credit")
    if not isinstance(artist_credit, list):
        return None
    for credit in artist_credit:
        if not isinstance(credit, dict):
            continue
        name = credit.get("name")
        artist = credit.get("artist")
        if (
            isinstance(name, str)
            and _normalize_text(name) == _normalize_text(primary_artist)
            and isinstance(artist, dict)
            and isinstance(artist.get("id"), str)
        ):
            return str(artist["id"])
    return None


def _musicbrainz_fill_genre(
    item: SyncItemState, artist_id: str | None = None
) -> None:
    if item.genre:
        return

    genres: list[str] = []
    if item.mb_releasegroup_id:
        genres = _musicbrainz_lookup_genres(
            "release-group", item.mb_releasegroup_id
        )
    if not genres and item.mb_track_id:
        genres = _musicbrainz_lookup_genres("recording", item.mb_track_id)
    if not genres and artist_id:
        genres = _musicbrainz_lookup_genres("artist", artist_id)
    if genres:
        item.genre = "; ".join(genres)


def _musicbrainz_enrich(item: SyncItemState) -> None:
    primary_artist = item.artist.split(",")[0].strip()
    recording: dict[str, Any] | None = None

    queries: list[str] = []
    if item.isrc:
        queries.append(f'isrc:"{item.isrc.replace("-", "")}"')
    queries.extend(
        f'recording:"{title_query}" AND artist:"{primary_artist}"'
        for title_query in _ordered_title_search_queries(item.title, [primary_artist])
    )

    for recording_query in queries:
        query = {
            "query": recording_query,
            "fmt": "json",
            "limit": "5",
        }
        response = _musicbrainz_get(
            "https://musicbrainz.org/ws/2/recording/",
            params=query,
            headers={"User-Agent": "liked-music-syncer/0.1.0"},
            timeout=10.0,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            continue

        recording = _select_musicbrainz_recording(
            item,
            payload.get("recordings"),
            [primary_artist],
        )
        if recording is not None:
            break

    if recording is None:
        return

    item.musicbrainz_matched = True
    artist_id = _musicbrainz_artist_id(recording, primary_artist)
    recording_id = recording.get("id")
    if isinstance(recording_id, str) and recording_id:
        item.mb_track_id = recording_id
        item.mb_album_id = None
        item.mb_releasegroup_id = None
    first_isrc = recording.get("isrcs")
    if isinstance(first_isrc, list) and first_isrc and isinstance(first_isrc[0], str) and first_isrc[0]:
        item.isrc = item.isrc or first_isrc[0]
    release = _select_musicbrainz_release(item, recording.get("releases"))
    if release is None:
        _musicbrainz_fill_genre(item, artist_id)
        return

    release_id = release.get("id")
    if isinstance(release_id, str) and release_id:
        item.mb_album_id = release_id
    release_group = release.get("release-group")
    if isinstance(release_group, dict):
        release_group_id = release_group.get("id")
        if isinstance(release_group_id, str) and release_group_id:
            item.mb_releasegroup_id = release_group_id
    date = release.get("date")
    if isinstance(date, str) and date and not item.date:
        item.date = date
        if item.year is None:
            item.year = _parse_year(date.split("-")[0])
    title = release.get("title")
    if isinstance(title, str) and title and is_unknown_album_value(item.album):
        item.album = title
    _musicbrainz_fill_genre(item, artist_id)
    _refresh_normalized_fields(item)


def _format_lrc_line(start_ms: int, text: str) -> str:
    minutes = start_ms // 60000
    seconds = (start_ms % 60000) / 1000
    return f"[{minutes:02d}:{seconds:05.2f}]{text}"


def _classify_lyrics_text(lyrics_text: str | None) -> str:
    return classify_lyrics_text(lyrics_text)


def _should_skip_existing(config: SyncConfig, item: SyncItemState) -> bool:
    if config.force_reprocess:
        return False
    source_id = item.youtube_music_track_id
    resolved_id = item.resolved_youtube_music_track_id or source_id
    return (
        bool(source_id and source_id in config.existing_local_youtube_music_track_ids)
        or bool(resolved_id and resolved_id in config.existing_local_resolved_youtube_music_track_ids)
    )


def _should_skip_existing_by_source_id(config: SyncConfig, item: SyncItemState) -> bool:
    if config.force_reprocess:
        return False
    source_id = item.youtube_music_track_id
    return bool(source_id and source_id in config.existing_local_youtube_music_track_ids)


def _normalize_artist_name(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]+", " ", value.lower())).strip()


def _track_matches_artist_filters(track: dict[str, Any], config: SyncConfig) -> bool:
    if not config.artist_filter_channel_ids and not config.artist_filter_names_normalized:
        return True

    channel_ids = set(config.artist_filter_channel_ids)
    names = set(config.artist_filter_names_normalized)
    artists = track.get("artists")
    if not isinstance(artists, list):
        return False
    for artist in artists:
        if not isinstance(artist, dict):
            continue
        artist_id = artist.get("id")
        if isinstance(artist_id, str) and artist_id and artist_id in channel_ids:
            return True
        if channel_ids:
            continue
        artist_name = artist.get("name")
        if isinstance(artist_name, str) and _normalize_artist_name(artist_name) in names:
            return True
    return False


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


def _lyrics_browse_id_for_track(ytmusic: YTMusic, video_id: str) -> str | None:
    watch = ytmusic.get_watch_playlist(videoId=video_id, limit=1)
    if not isinstance(watch, dict):
        return None
    lyrics_id = watch.get("lyrics")
    return lyrics_id if isinstance(lyrics_id, str) and lyrics_id else None


def _sync_release_item_metadata(item: SyncItemState, track: dict[str, Any]) -> None:
    item.source_origin = "favorite_artist_release"
    item.resolution_method = "favorite_artist_release_exact"
    item.metadata_matched = True
    if item.catalog_release_title and is_unknown_album_value(item.album):
        item.album = item.catalog_release_title
    artists = _string_list_names(track.get("artists"))
    if artists:
        item.artist = ", ".join(artists)
        item.album_artist = item.artist
    credits = normalize_artist_credits(track.get("artists"))
    if credits:
        item.artist_credits = credits
    album_info = _album_info(track.get("album"))
    album_name = album_info.get("name")
    if isinstance(album_name, str) and album_name:
        item.album = album_name
    if item.catalog_release_title and is_unknown_album_value(item.album):
        item.album = item.catalog_release_title
    item.track_number = _signature_int(track.get("trackNumber")) or item.track_number
    item.track_total = _signature_int(track.get("trackTotal")) or item.track_total
    item.disc_number = _signature_int(track.get("discNumber")) or item.disc_number
    item.disc_total = _signature_int(track.get("discTotal")) or item.disc_total
    year = _parse_year(track.get("year"))
    if year is not None:
        item.year = year
    date = _signature_str(track.get("date"))
    if date:
        item.date = date
    isrc = _signature_str(track.get("isrc"))
    if isrc:
        item.isrc = isrc
    _refresh_normalized_fields(item)


def _should_run_musicbrainz(item: SyncItemState) -> bool:
    return True


def _matches_release_signature(item: SyncItemState, signature: dict[str, Any]) -> bool:
    release_identity = _release_identity(item)
    if not release_identity:
        return False
    signature_release = _signature_str(signature.get("catalogReleaseBrowseId")) or _signature_str(
        signature.get("mbAlbumId")
    )
    if release_identity != signature_release:
        return False
    if (item.normalized_primary_artist or "") != _signature_normalized_artist(signature):
        return False
    if (item.normalized_title or "") != _signature_normalized_title(signature):
        return False
    signature_track_number = _signature_int(signature.get("trackNumber"))
    return item.track_number is None or signature_track_number is None or item.track_number == signature_track_number


def _matches_song_signature(item: SyncItemState, signature: dict[str, Any]) -> bool:
    return bool(
        (item.normalized_primary_artist or "")
        and (item.normalized_primary_artist or "") == _signature_normalized_artist(signature)
        and (item.normalized_title or "")
        and (item.normalized_title or "") == _signature_normalized_title(signature)
    )


def _skip_reason_for_existing_signature(
    config: SyncConfig,
    item: SyncItemState,
) -> tuple[str, str] | None:
    if config.force_reprocess:
        return None
    source_id = item.youtube_music_track_id
    resolved_id = item.resolved_youtube_music_track_id or source_id
    if source_id and source_id in config.existing_local_youtube_music_track_ids:
        return (
            "existing_library_identity",
            "Matching managed local library source identity already scanned.",
        )
    if resolved_id and resolved_id in config.existing_local_resolved_youtube_music_track_ids:
        return (
            "existing_library_identity",
            "Matching managed local library resolved identity already scanned.",
        )
    if item.source_origin == "favorite_artist_release":
        for signature in config.existing_local_release_signatures:
            if _matches_release_signature(item, signature):
                return (
                    "existing_release",
                    "Matching managed local release identity already scanned.",
                )
        return None
    for signature in config.existing_local_track_signatures:
        if _matches_song_signature(item, signature):
            return (
                "existing_song_equivalent",
                "Equivalent managed local song already scanned.",
            )
    return None


def _spotify_normalize_text(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value.lower()).strip()


def _spotify_tokenize(value: str) -> list[str]:
    normalized = _spotify_normalize_text(value)
    return [item for item in normalized.split() if item]


def _spotify_jaccard_similarity(left: str, right: str) -> float:
    left_set = set(_spotify_tokenize(left))
    right_set = set(_spotify_tokenize(right))
    if not left_set or not right_set:
        return 0.0
    overlap = len(left_set & right_set)
    return overlap / (len(left_set) + len(right_set) - overlap)


def _spotify_duration_score(source_duration_sec: int | None, track_duration_ms: int) -> float:
    if not source_duration_sec or track_duration_ms <= 0:
        return 0.5
    diff = abs((source_duration_sec * 1000) - track_duration_ms)
    return max(0.0, 1 - (diff / 15000))


def _spotify_candidate_score(
    source: dict[str, Any],
    candidate: dict[str, Any],
) -> float:
    title = _spotify_jaccard_similarity(str(source.get("title") or ""), str(candidate.get("name") or ""))
    artist = _spotify_jaccard_similarity(str(source.get("artist") or ""), " ".join(candidate.get("artists") or []))
    duration = _spotify_duration_score(_signature_int(source.get("duration_sec")), int(candidate.get("duration_ms") or 0))
    return round((title * 0.55) + (artist * 0.35) + (duration * 0.1), 4)


def _spotify_format_fetch_error(prefix: str, response: httpx.Response) -> str:
    body = response.text.strip()
    return f"{prefix}: {response.status_code} {body}" if body else f"{prefix}: {response.status_code}"


def _spotify_ensure_client_version(client: httpx.Client) -> str:
    client_version = _SPOTIFY_CACHE.get("client_version")
    if isinstance(client_version, str) and client_version:
        return client_version
    response = client.get(
        SPOTIFY_WEB_BASE_URL,
        headers={"User-Agent": SPOTIFY_USER_AGENT},
        timeout=10.0,
    )
    if not response.is_success:
        raise RuntimeError(_spotify_format_fetch_error("Spotify web bootstrap failed", response))
    match = re.search(r'<script id="appServerConfig" type="text/plain">([^<]+)</script>', response.text)
    if not match or not match.group(1):
        raise RuntimeError("Spotify web bootstrap is missing appServerConfig")
    payload = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("clientVersion"), str):
        raise RuntimeError("Spotify web bootstrap is missing clientVersion")
    _SPOTIFY_CACHE["client_version"] = payload["clientVersion"]
    return payload["clientVersion"]


def _spotify_latest_secret(client: httpx.Client) -> tuple[str, list[int]]:
    cached_version = _SPOTIFY_CACHE.get("secret_version")
    cached_bytes = _SPOTIFY_CACHE.get("secret_bytes")
    fetched_at = int(_SPOTIFY_CACHE.get("secrets_fetched_at") or 0)
    if (
        isinstance(cached_version, str)
        and isinstance(cached_bytes, list)
        and ((int(time.time() * 1000) - fetched_at) < SPOTIFY_SECRET_CACHE_TTL_MS)
    ):
        return cached_version, [int(value) for value in cached_bytes]
    response = client.get(
        SPOTIFY_SECRETS_URL,
        headers={"User-Agent": SPOTIFY_USER_AGENT},
        timeout=10.0,
    )
    if not response.is_success:
        raise RuntimeError(_spotify_format_fetch_error("Spotify secret fetch failed", response))
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Spotify secret response did not contain any versions")
    versions = sorted(
        [int(key) for key in payload.keys() if str(key).isdigit()],
        reverse=True,
    )
    if not versions:
        raise RuntimeError("Spotify secret response did not contain any versions")
    version = str(versions[0])
    secret_bytes = payload.get(version)
    if not isinstance(secret_bytes, list) or not secret_bytes:
        raise RuntimeError(f"Spotify secret version {version} did not contain any bytes")
    _SPOTIFY_CACHE["secret_version"] = version
    _SPOTIFY_CACHE["secret_bytes"] = [int(value) for value in secret_bytes]
    _SPOTIFY_CACHE["secrets_fetched_at"] = int(time.time() * 1000)
    return version, [int(value) for value in secret_bytes]


def _spotify_server_time(client: httpx.Client) -> int:
    response = client.get(
        f"{SPOTIFY_WEB_BASE_URL}/api/server-time",
        headers={
            "Origin": SPOTIFY_WEB_BASE_URL,
            "Referer": f"{SPOTIFY_WEB_BASE_URL}/",
            "User-Agent": SPOTIFY_USER_AGENT,
        },
        timeout=10.0,
    )
    if not response.is_success:
        raise RuntimeError(_spotify_format_fetch_error("Spotify server time request failed", response))
    payload = response.json()
    server_time_value = payload.get("serverTime") if isinstance(payload, dict) else None
    server_time = int(server_time_value) if isinstance(server_time_value, int | str) and str(server_time_value).isdigit() else None
    if server_time is None:
        raise RuntimeError("Spotify server time response did not include a numeric serverTime")
    return server_time


def _spotify_generate_totp(timestamp_seconds: int, secret_bytes: list[int]) -> str:
    transformed = [value ^ ((index % 33) + 9) for index, value in enumerate(secret_bytes)]
    secret = "".join(str(value) for value in transformed).encode("utf-8")
    counter = timestamp_seconds // 30
    counter_bytes = counter.to_bytes(8, byteorder="big")
    digest = hmac.new(secret, counter_bytes, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = int.from_bytes(digest[offset : offset + 4], byteorder="big") & 0x7FFFFFFF
    return str(code % 1_000_000).zfill(6)


def _spotify_access_token(client: httpx.Client) -> str:
    access_token = _SPOTIFY_CACHE.get("access_token")
    expires_at = int(_SPOTIFY_CACHE.get("access_token_expires_at") or 0)
    now_ms = int(time.time() * 1000)
    if isinstance(access_token, str) and access_token and (expires_at - now_ms) > 60000:
        return access_token
    version, secret_bytes = _spotify_latest_secret(client)
    server_time = _spotify_server_time(client)
    totp = _spotify_generate_totp(server_time, secret_bytes)
    response = client.get(
        f"{SPOTIFY_WEB_BASE_URL}/api/token",
        params={
            "reason": "init",
            "productType": "web-player",
            "totp": totp,
            "totpServer": totp,
            "totpVer": version,
        },
        headers={
            "Accept": "application/json",
            "Origin": SPOTIFY_WEB_BASE_URL,
            "Referer": f"{SPOTIFY_WEB_BASE_URL}/",
            "User-Agent": SPOTIFY_USER_AGENT,
        },
        timeout=10.0,
    )
    if not response.is_success:
        raise RuntimeError(_spotify_format_fetch_error("Spotify anonymous token request failed", response))
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("accessToken"), str):
        raise RuntimeError("Spotify anonymous token response is missing access token fields")
    expiration = payload.get("accessTokenExpirationTimestampMs")
    if not isinstance(expiration, int):
        raise RuntimeError("Spotify anonymous token response is missing access token fields")
    _SPOTIFY_CACHE["access_token"] = payload["accessToken"]
    _SPOTIFY_CACHE["access_token_expires_at"] = expiration
    return payload["accessToken"]


def _spotify_search_headers(client_version: str, access_token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Accept-Language": "en",
        "App-Platform": "WebPlayer",
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": SPOTIFY_WEB_BASE_URL,
        "Referer": f"{SPOTIFY_WEB_BASE_URL}/",
        "Spotify-App-Version": client_version,
        "User-Agent": SPOTIFY_USER_AGENT,
    }


def _spotify_match_track(item: SyncItemState) -> str | None:
    source = {
        "title": item.title,
        "artist": item.artist,
        "duration_sec": None,
    }
    with httpx.Client(timeout=10.0, follow_redirects=True) as client:
        client_version = _spotify_ensure_client_version(client)
        access_token = _spotify_access_token(client)
        query = " ".join(part for part in [item.title, item.artist] if part).strip()
        if not query:
            return None
        response = client.post(
            SPOTIFY_PATHFINDER_URL,
            headers=_spotify_search_headers(client_version, access_token),
            json={
                "operationName": "searchDesktop",
                "variables": {
                    "searchTerm": query,
                    "offset": 0,
                    "limit": 10,
                    "numberOfTopResults": 5,
                    "includeAudiobooks": False,
                    "includeArtistHasConcertsField": True,
                    "includePreReleases": True,
                    "includeLocalConcertsField": False,
                    "includeAuthors": True,
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": SPOTIFY_SEARCH_QUERY_HASH,
                    }
                },
            },
        )
        if response.status_code == 401:
            _SPOTIFY_CACHE["access_token"] = None
            _SPOTIFY_CACHE["access_token_expires_at"] = 0
            access_token = _spotify_access_token(client)
            response = client.post(
                SPOTIFY_PATHFINDER_URL,
                headers=_spotify_search_headers(client_version, access_token),
                json={
                    "operationName": "searchDesktop",
                    "variables": {
                        "searchTerm": query,
                        "offset": 0,
                        "limit": 10,
                        "numberOfTopResults": 5,
                        "includeAudiobooks": False,
                        "includeArtistHasConcertsField": True,
                        "includePreReleases": True,
                        "includeLocalConcertsField": False,
                        "includeAuthors": True,
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": SPOTIFY_SEARCH_QUERY_HASH,
                        }
                    },
                },
            )
        if not response.is_success:
            raise RuntimeError(_spotify_format_fetch_error("Spotify search failed", response))
        payload = response.json()
    items = (((payload or {}).get("data") or {}).get("searchV2") or {}).get("tracksV2", {}).get("items", [])
    best_track_id: str | None = None
    best_score = 0.0
    for item_payload in items if isinstance(items, list) else []:
        track = (((item_payload or {}).get("item") or {}).get("data") or {})
        uri = track.get("uri")
        if not isinstance(uri, str) or not uri.startswith("spotify:track:"):
            continue
        candidate = {
            "track_id": uri.split(":")[-1],
            "name": str(track.get("name") or ""),
            "artists": [
                str(artist.get("profile", {}).get("name"))
                for artist in (((track.get("artists") or {}).get("items")) or [])
                if isinstance(artist, dict) and isinstance(artist.get("profile", {}).get("name"), str)
            ],
            "duration_ms": _signature_int(((track.get("duration") or {}).get("totalMilliseconds"))) or 0,
        }
        if not candidate["track_id"] or not candidate["name"] or not candidate["artists"]:
            continue
        score = _spotify_candidate_score(source, candidate)
        if score > best_score:
            best_score = score
            best_track_id = str(candidate["track_id"])
    return best_track_id if best_score >= 0.6 else None


def _spotify_fetch_lyrics(spotify_track_id: str, lyrics_api_base_url: str) -> tuple[str | None, str]:
    response = httpx.get(
        lyrics_api_base_url,
        params={"trackid": spotify_track_id, "format": "lrc"},
        timeout=10.0,
    )
    response.raise_for_status()
    payload = response.json()
    lines = payload.get("lines") if isinstance(payload, dict) else None
    if not isinstance(lines, list):
        return None, "missing"
    rendered_synced: list[str] = []
    rendered_plain: list[str] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        words = line.get("words")
        if not isinstance(words, str) or not words.strip():
            continue
        rendered_plain.append(words.strip())
        time_tag = line.get("timeTag")
        if isinstance(time_tag, str) and time_tag.strip():
            rendered_synced.append(f"[{time_tag.strip().strip('[]')}]{words.strip()}")
            continue
        start_time = line.get("startTimeMs")
        if isinstance(start_time, str) and start_time.strip().isdigit():
            rendered_synced.append(_format_lrc_line(int(start_time.strip()), words.strip()))
    rendered_synced_text = "\n".join(rendered_synced) + "\n" if rendered_synced else None
    if rendered_synced_text and not is_zero_timestamp_only_lrc(rendered_synced_text):
        return rendered_synced_text, "synced"
    if rendered_plain:
        return "\n".join(rendered_plain) + "\n", "plain"
    return None, "missing"


def _resolve_best_lyrics(
    config: SyncConfig,
    ytmusic: YTMusic,
    item: SyncItemState,
    lyrics_browse_id: str | None,
) -> tuple[str | None, str | None]:
    yt_lyrics_text, yt_lyrics_source = _resolve_lyrics(ytmusic, lyrics_browse_id)
    yt_status = _classify_lyrics_text(yt_lyrics_text)
    if yt_status == "synced":
        return yt_lyrics_text, yt_lyrics_source
    if not config.spotify_match_enabled or not config.lyrics_api_base_url.strip():
        return yt_lyrics_text, yt_lyrics_source
    spotify_track_id = item.spotify_track_id
    if not spotify_track_id:
        spotify_track_id = _spotify_match_track(item)
        item.spotify_track_id = spotify_track_id
    if not spotify_track_id:
        return yt_lyrics_text, yt_lyrics_source
    spotify_lyrics_text, spotify_status = _spotify_fetch_lyrics(
        spotify_track_id,
        config.lyrics_api_base_url.strip(),
    )
    if spotify_status == "synced":
        return spotify_lyrics_text, "spotify"
    if yt_status == "plain":
        return yt_lyrics_text, yt_lyrics_source
    if spotify_status == "plain":
        return spotify_lyrics_text, "spotify"
    return yt_lyrics_text, yt_lyrics_source


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
            config.job_id,
            stage,
            "info",
            "auth-init",
            "Initializing YT Music client.",
            {
                "output_directory": str(config.output_directory),
                "remote_copy_enabled": config.remote_copy_enabled,
                "write_lrc_sidecar": config.write_lrc_sidecar,
                "embed_unsynced_lyrics": config.embed_unsynced_lyrics,
            },
        )
        ytmusic = _build_ytmusic_client(config.ytmusic_browser_auth)
        _run_log(config.job_id, stage, "info", "auth-ready", "YT Music client ready.")

        stage = "liked_songs_fetch"
        favorite_catalog_counts: dict[str, int] = {}
        if config.retry_items:
            tracks = config.retry_items
            raw_count = len(tracks)
            _run_log(
                config.job_id,
                stage,
                "info",
                "retry-items-ready",
                "Retry items loaded.",
                {"total_count": len(tracks)},
            )
        elif config.favorite_artist_catalogs:
            _run_log(
                config.job_id,
                stage,
                "info",
                "favorite-catalog-fetch-start",
                "Fetching favorite artist catalog tracks from YT Music.",
                {"artist_count": len(config.favorite_artist_catalogs)},
            )
            tracks = []
            for artist in config.favorite_artist_catalogs:
                artist_tracks = _discover_artist_catalog_tracks(ytmusic, artist)
                artist_id = str(artist.get("id") or "")
                if artist_id:
                    favorite_catalog_counts[artist_id] = len(artist_tracks)
                tracks.extend(artist_tracks)
            raw_count = len(tracks)
            tracks = _dedupe_tracks(tracks)
            _run_log(
                config.job_id,
                stage,
                "info",
                "favorite-catalog-fetch-complete",
                "Favorite artist catalog fetch complete.",
                {
                    "total_count": len(tracks),
                    "raw_total_count": raw_count,
                    "favorite_artist_catalog_counts": favorite_catalog_counts,
                },
            )
        else:
            _run_log(
                config.job_id,
                stage,
                "info",
                "liked-fetch-start",
                "Fetching liked songs from YT Music.",
                {"limit": 5000},
            )
            liked = ytmusic.get_liked_songs(limit=5000)
            tracks = _extract_tracks(liked if isinstance(liked, dict) else {})
            raw_count = len(tracks)
            tracks = [track for track in tracks if _track_matches_artist_filters(track, config)]
            _run_log(
                config.job_id,
                stage,
                "info",
                "liked-fetch-complete",
                "Liked songs fetch complete.",
                {"total_count": len(tracks), "raw_total_count": raw_count},
            )
        _emit_job_event(
            config.job_id,
            "started",
            stage,
            "Retry items ready."
            if config.retry_items
            else (
                "Favorite artist catalog fetch complete."
                if config.favorite_artist_catalogs
                else "Liked songs fetch complete."
            ),
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
            _emit_item(config.job_id, item)
            _log(config.job_id, item, item.stage, "info", "fetch", "Fetched liked item.")

            if _should_skip_existing_by_source_id(config, item):
                item.status = "skipped_existing"
                item.stage = "finalize"
                item.reason_code = "existing_library_identity"
                item.reason_detail = "Matching managed local library source identity already scanned."
                _emit_item(config.job_id, item)
                continue

            try:
                item.stage = "source_resolve"
                stage = item.stage
                if item.source_origin == "favorite_artist_release":
                    _sync_release_item_metadata(item, track)
                    lyrics_browse_id = _lyrics_browse_id_for_track(
                        ytmusic, item.youtube_music_track_id
                    )
                else:
                    lyrics_browse_id = _resolve_exact_catalog(ytmusic, item, run_id=config.job_id)
                _emit_item(config.job_id, item)
                _log(config.job_id, item, item.stage, "info", "resolve", f"Resolution method: {item.resolution_method}.")
            except Exception as exc:  # noqa: BLE001
                _log(config.job_id, item, "source_resolve", "warn", "resolve-fallback", str(exc))
                _resolve_fallback_metadata(config, item)
                _emit_item(config.job_id, item)
                lyrics_browse_id = None

            try:
                if _should_run_musicbrainz(item):
                    item.stage = "musicbrainz_enrich"
                    stage = item.stage
                    _musicbrainz_enrich(item)
                    apply_managed_musicbrainz_policy(item)
                    _emit_item(config.job_id, item)
            except Exception as exc:  # noqa: BLE001
                _log(config.job_id, item, item.stage, "warn", "musicbrainz", str(exc))

            context = {
                "albumartist": item.album_artist,
                "album": item.album,
                "track": item.track_number or index,
                "title": item.title,
                "artist": item.artist,
            }
            output_path = layout.build_path(config.output_directory, context)

            skip_reason = _skip_reason_for_existing_signature(config, item)
            if skip_reason is not None:
                item.status = "skipped_existing"
                item.stage = "finalize"
                item.output_path = str(output_path)
                item.reason_code, item.reason_detail = skip_reason
                _emit_item(config.job_id, item)
                continue

            if (not config.force_reprocess) and output_path.exists():
                item.status = "skipped_existing"
                item.stage = "finalize"
                item.output_path = str(output_path)
                item.reason_code = "existing_output"
                item.reason_detail = "Output path already exists."
                _emit_item(config.job_id, item)
                continue

            item.stage = "lyrics_resolve"
            stage = item.stage
            try:
                lyrics_text, lyrics_source = _resolve_best_lyrics(
                    config,
                    ytmusic,
                    item,
                    lyrics_browse_id,
                )
            except Exception as exc:  # noqa: BLE001
                _log(config.job_id, item, item.stage, "warn", "lyrics", str(exc))
                lyrics_text, lyrics_source = None, None
            item.lyrics_status = classify_lyrics_text(lyrics_text)
            item.language = detect_primary_lyrics_language(lyrics_text)
            if lyrics_text:
                item.lyrics_matched = True
                item.lyrics_source = lyrics_source
            _emit_item(config.job_id, item)

            try:
                with tempfile.TemporaryDirectory(prefix="lmsync_") as temp_dir_raw:
                    temp_dir = Path(temp_dir_raw)
                    item.stage = "download"
                    stage = item.stage
                    _emit_item(config.job_id, item)
                    downloaded_path, info = _download_audio(config, item, temp_dir)
                    codec = info.get("acodec")
                    item.audio_codec = str(codec) if isinstance(codec, str) else item.audio_codec

                    item.stage = "fixup"
                    stage = item.stage
                    _emit_item(config.job_id, item)
                    _normalize_audio(downloaded_path, output_path, config.ffmpeg_path, item.audio_codec)

                    cover_bytes: bytes | None = None
                    if item.cover_art_url:
                        try:
                            cover_bytes = make_square_cover(_download_bytes(item.cover_art_url))
                        except Exception as exc:  # noqa: BLE001
                            _log(config.job_id, item, "tagging", "warn", "cover", str(exc))

                    item.stage = "tagging"
                    stage = item.stage
                    _emit_item(config.job_id, item)
                    embedded_lyrics = lyrics_text if (lyrics_text and (item.lyrics_status == "synced" or config.embed_unsynced_lyrics)) else None
                    write_media_tags(output_path, item, cover_bytes, embedded_lyrics)

                    sidecar_text = lyrics_sidecar_text(lyrics_text, item.lyrics_status)
                    stale_lrc = output_path.with_suffix(".lrc")
                    if config.write_lrc_sidecar and sidecar_text:
                        item.lrc_path = str(stale_lrc)
                        stale_lrc.write_text(sidecar_text, encoding="utf-8")
                    else:
                        item.lrc_path = None
                        if stale_lrc.exists():
                            stale_lrc.unlink()

                    item.stage = "remote_copy"
                    stage = item.stage
                    _emit_item(config.job_id, item)
                    _copy_remote(config, output_path)

                item.status = "completed"
                item.stage = "finalize"
                item.output_path = str(output_path)
                _emit_item(config.job_id, item)
            except Exception as exc:  # noqa: BLE001
                item.status = "failed_terminal"
                item.stage = "finalize"
                item.reason_code = "sync_failed"
                item.reason_detail = str(exc)
                _log(config.job_id, item, item.stage, "error", "item-failed", str(exc))
                _emit_item(config.job_id, item)

        _emit_job_event(
            config.job_id,
            "completed",
            "finalize",
            "Sync run complete.",
            context={"favorite_artist_catalog_counts": favorite_catalog_counts}
            if config.favorite_artist_catalogs
            else None,
        )
    except Exception as exc:  # noqa: BLE001
        _run_log(
            config.job_id,
            stage,
            "error",
            "job-failed",
            str(exc),
            {
                "error_type": type(exc).__name__,
                "traceback": traceback.format_exc(),
            },
        )
        _emit_job_event(
            config.job_id,
            "failed",
            stage,
            f"Job failed during {stage}: {exc}",
            context={"error_type": type(exc).__name__},
        )
        raise
