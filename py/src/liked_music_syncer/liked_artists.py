from __future__ import annotations

from collections import defaultdict
import re
import time
from typing import Any

from .auth import build_browser_auth_client


def _normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]+", " ", value.lower())).strip()


_ARTIST_THUMB_MIN_EDGE = 200
_ARTIST_THUMB_UPGRADE_EDGE = 544
_ARTIST_IMAGE_RETRY_DELAYS = (0.5, 1.5)
_ARTIST_IMAGE_ERROR_MESSAGE_LIMIT = 500


def _upgrade_thumbnail_url(url: str) -> str:
    """Ask CDNs for a larger rendition when API payloads default to small thumbs."""
    upgraded = url
    upgraded = re.sub(r"=s\d+(-)", rf"=s{_ARTIST_THUMB_UPGRADE_EDGE}\1", upgraded)
    upgraded = re.sub(r"=s\d+$", f"=s{_ARTIST_THUMB_UPGRADE_EDGE}", upgraded)
    upgraded = re.sub(
        r"=w\d+-h\d+",
        f"=w{_ARTIST_THUMB_UPGRADE_EDGE}-h{_ARTIST_THUMB_UPGRADE_EDGE}",
        upgraded,
    )
    upgraded = re.sub(r"/s\d+/", f"/s{_ARTIST_THUMB_UPGRADE_EDGE}/", upgraded)
    return upgraded


def _best_thumbnail_url(value: Any) -> str | None:
    if not isinstance(value, list):
        return None
    best_url: str | None = None
    best_edge = -1
    for item in value:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        width = int(item.get("width", 0) or 0)
        height = int(item.get("height", 0) or 0)
        if width <= 0 or height <= 0:
            edge = max(width, height)
        else:
            edge = min(width, height)
        if edge < _ARTIST_THUMB_MIN_EDGE:
            continue
        if edge >= best_edge:
            best_edge = edge
            best_url = url

    if best_url is None:
        for item in value:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url:
                continue
            width = int(item.get("width", 0) or 0)
            height = int(item.get("height", 0) or 0)
            edge = min(width, height) if width > 0 and height > 0 else max(width, height)
            if edge >= best_edge:
                best_edge = edge
                best_url = url

    if best_url is None:
        return None
    return _upgrade_thumbnail_url(best_url)


def fetch_liked_artists(browser_auth_input: str) -> dict[str, list[dict[str, Any]]]:
    ytmusic = build_browser_auth_client(browser_auth_input)
    liked = ytmusic.get_liked_songs(limit=5000)
    tracks = liked.get("tracks") if isinstance(liked, dict) else []
    artist_rows: dict[str, dict[str, Any]] = {}
    rep_thumbs: dict[str, str | None] = {}
    name_to_id_keys: dict[str, list[str]] = defaultdict(list)

    if not isinstance(tracks, list):
        tracks = []

    for track in tracks:
        if not isinstance(track, dict):
            continue
        track_thumb = _best_thumbnail_url(track.get("thumbnails"))
        artists = track.get("artists")
        if not isinstance(artists, list):
            continue
        for artist in artists:
            if not isinstance(artist, dict):
                continue
            name = artist.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            normalized = _normalize_name(name)
            if not normalized:
                continue
            channel_id_raw = artist.get("id")
            channel_id = channel_id_raw if isinstance(channel_id_raw, str) and channel_id_raw else None
            key = f"artist_channel_{channel_id}" if channel_id else f"artist_name_{normalized}"
            if key not in artist_rows:
                artist_rows[key] = {
                    "id": key,
                    "channel_id": channel_id,
                    "name": name.strip(),
                    "normalized_name": normalized,
                    "photo_url": None,
                    "liked_track_count": 0,
                }
            artist_rows[key]["liked_track_count"] += 1
            if track_thumb and key not in rep_thumbs:
                rep_thumbs[key] = track_thumb
            if channel_id:
                name_to_id_keys[normalized].append(key)

    for key, row in list(artist_rows.items()):
        if row["channel_id"] is not None:
            continue
        id_backed = name_to_id_keys.get(row["normalized_name"], [])
        if not id_backed:
            continue
        target_key = id_backed[0]
        artist_rows[target_key]["liked_track_count"] += row["liked_track_count"]
        if rep_thumbs.get(key) and not rep_thumbs.get(target_key):
            rep_thumbs[target_key] = rep_thumbs[key]
        del artist_rows[key]

    for row in artist_rows.values():
        channel_id = row["channel_id"]
        photo = None
        if isinstance(channel_id, str) and channel_id:
            try:
                artist_payload = ytmusic.get_artist(channel_id)
                photo = _best_thumbnail_url(
                    artist_payload.get("thumbnails")
                    if isinstance(artist_payload, dict)
                    else None
                )
            except Exception:
                photo = None
        if not photo:
            photo = rep_thumbs.get(row["id"])
        row["photo_url"] = photo

    artists = sorted(
        artist_rows.values(),
        key=lambda item: (-int(item["liked_track_count"]), str(item["name"]).lower()),
    )
    return {"artists": artists}


def _lookup_artist_image_row(
    ytmusic: Any, artist: dict[str, Any]
) -> dict[str, Any] | None:
    artist_id = artist.get("id")
    channel_id = artist.get("channel_id")
    if (
        not isinstance(artist_id, str)
        or not isinstance(channel_id, str)
        or not channel_id
    ):
        return None

    artist_payload = ytmusic.get_artist(channel_id)

    photo_url = _best_thumbnail_url(
        artist_payload.get("thumbnails")
        if isinstance(artist_payload, dict)
        else None
    )

    if not photo_url:
        return None

    return {
        "id": artist_id,
        "channel_id": channel_id,
        "photo_url": photo_url,
    }


def _sanitized_error_message(error: Exception) -> str:
    message = re.sub(r"\s+", " ", str(error)).strip()
    return message[:_ARTIST_IMAGE_ERROR_MESSAGE_LIMIT]


def fetch_artist_image(payload: dict[str, Any]) -> dict[str, Any]:
    browser_auth_input = str(payload.get("ytmusic_browser_auth", ""))
    artist = payload.get("artist")
    if not isinstance(artist, dict):
        return {"ok": False, "message": "Missing artist payload.", "artist": None}

    artist_id = artist.get("id")
    channel_id = artist.get("channel_id")
    if (
        not isinstance(artist_id, str)
        or not isinstance(channel_id, str)
        or not channel_id
    ):
        return {
            "ok": True,
            "message": "No trusted artist image available.",
            "artist": None,
        }

    ytmusic = build_browser_auth_client(browser_auth_input)
    attempts = len(_ARTIST_IMAGE_RETRY_DELAYS) + 1
    for attempt in range(1, attempts + 1):
        try:
            row = _lookup_artist_image_row(ytmusic, artist)
        except Exception as error:
            if attempt < attempts:
                time.sleep(_ARTIST_IMAGE_RETRY_DELAYS[attempt - 1])
                continue
            return {
                "ok": False,
                "message": f"Artist image lookup failed after {attempts} attempts.",
                "artist": None,
                "error_type": type(error).__name__,
                "error_message": _sanitized_error_message(error),
                "attempts": attempts,
            }

        if row is None:
            return {
                "ok": True,
                "message": "Artist page returned no usable image.",
                "artist": None,
            }
        return {"ok": True, "message": "Artist image resolved.", "artist": row}

    raise AssertionError("artist image retry loop did not return")


def fetch_artist_images(
    browser_auth_input: str, artists: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    ytmusic = build_browser_auth_client(browser_auth_input)
    rows: list[dict[str, Any]] = []

    for artist in artists:
        try:
            row = _lookup_artist_image_row(ytmusic, artist)
        except Exception:
            continue
        if row is not None:
            rows.append(row)

    return {"artists": rows}
