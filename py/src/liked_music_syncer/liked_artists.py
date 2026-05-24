from __future__ import annotations

from collections import defaultdict
import re
from typing import Any

from .auth import build_browser_auth_client


def _normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]+", " ", value.lower())).strip()


def _best_thumbnail_url(value: Any) -> str | None:
    if not isinstance(value, list):
        return None
    best_url: str | None = None
    best_area = -1
    for item in value:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        width = int(item.get("width", 0) or 0)
        height = int(item.get("height", 0) or 0)
        area = width * height
        if area >= best_area:
            best_area = area
            best_url = url
    return best_url


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


def fetch_artist_images(
    browser_auth_input: str, artists: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    ytmusic = build_browser_auth_client(browser_auth_input)
    rows: list[dict[str, Any]] = []

    for artist in artists:
        artist_id = artist.get("id")
        name = artist.get("name")
        normalized_name = artist.get("normalized_name")
        if not isinstance(artist_id, str) or not isinstance(name, str) or not name.strip():
            continue

        try:
            results = ytmusic.search(name, filter="artists", limit=5)
        except Exception:
            results = []

        if not isinstance(results, list):
            results = []

        best: dict[str, Any] | None = None
        for result in results:
            if not isinstance(result, dict):
                continue
            result_name = result.get("artist") or result.get("name") or result.get("title")
            if (
                isinstance(normalized_name, str)
                and isinstance(result_name, str)
                and _normalize_name(result_name) == normalized_name
            ):
                best = result
                break
            if best is None:
                best = result

        if best is None:
            continue

        channel_id_raw = best.get("browseId") or best.get("id")
        channel_id = (
            channel_id_raw if isinstance(channel_id_raw, str) and channel_id_raw else None
        )
        photo_url = _best_thumbnail_url(best.get("thumbnails"))

        if channel_id and not photo_url:
            try:
                artist_payload = ytmusic.get_artist(channel_id)
                photo_url = _best_thumbnail_url(
                    artist_payload.get("thumbnails")
                    if isinstance(artist_payload, dict)
                    else None
                )
            except Exception:
                photo_url = None

        if not photo_url:
            continue

        rows.append(
            {
                "id": artist_id,
                "channel_id": channel_id,
                "photo_url": photo_url,
            }
        )

    return {"artists": rows}
