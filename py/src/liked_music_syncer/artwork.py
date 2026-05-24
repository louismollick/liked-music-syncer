from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from mediafile import MediaFile
from mediafile.exceptions import FileTypeError

from .cover_art import make_square_cover
from .media_tags import register_lms_mediafile_fields


def extract_embedded_cover_thumbnail(payload: dict[str, Any]) -> dict[str, Any]:
    file_path = Path(str(payload.get("file_path", ""))).expanduser()
    size = int(payload.get("size", 256))
    if not file_path.is_file():
        return {
            "ok": False,
            "message": "Audio file not found.",
            "jpeg_base64": None,
    }

    register_lms_mediafile_fields()
    try:
        media = MediaFile(str(file_path))
    except FileTypeError:
        return {
            "ok": True,
            "message": "No embedded cover art.",
            "jpeg_base64": None,
        }
    images = media.images or []
    if not images:
        return {
            "ok": True,
            "message": "No embedded cover art.",
            "jpeg_base64": None,
        }

    cover_bytes = images[0].data
    if not isinstance(cover_bytes, (bytes, bytearray)) or len(cover_bytes) == 0:
        return {
            "ok": True,
            "message": "Embedded cover art was empty.",
            "jpeg_base64": None,
        }

    thumbnail = make_square_cover(bytes(cover_bytes), size=size)
    return {
        "ok": True,
        "message": "Cover thumbnail generated.",
        "jpeg_base64": base64.b64encode(thumbnail).decode("ascii"),
    }
