from __future__ import annotations

from typing import Any


def youtube_music_release_track_identity(
    metadata: dict[str, Any],
) -> str | None:
    release_id = metadata.get("catalog_release_browse_id")
    if not isinstance(release_id, str) or not release_id:
        return None

    disc_number = metadata.get("disc_number")
    track_number = metadata.get("track_number")
    if isinstance(disc_number, int) and isinstance(track_number, int):
        return f"{release_id}:{disc_number}:{track_number}"

    video_id = metadata.get("youtube_music_track_id") or metadata.get(
        "resolved_youtube_music_track_id"
    )
    if isinstance(video_id, str) and video_id:
        return f"{release_id}:video:{video_id}"
    return None
