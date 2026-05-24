from __future__ import annotations

UNKNOWN_ALBUM_NAME = "Unknown Album"
LEGACY_UNKNOWN_ALBUM_NAME = "_Singles"


def is_unknown_album_value(value: str | None) -> bool:
    if value is None:
        return True
    trimmed = value.strip()
    return trimmed in {"", LEGACY_UNKNOWN_ALBUM_NAME, UNKNOWN_ALBUM_NAME}


def canonical_album_name(value: str | None) -> str:
    if is_unknown_album_value(value):
        return UNKNOWN_ALBUM_NAME
    assert value is not None
    return value.strip()
