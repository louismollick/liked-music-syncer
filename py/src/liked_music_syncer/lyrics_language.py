from __future__ import annotations

import re

from lingua import LanguageDetectorBuilder

_LYRICS_LANGUAGE_DETECTOR = (
    LanguageDetectorBuilder.from_all_spoken_languages().build()
)
_LRC_TIMESTAMP_RE = re.compile(r"\[\d{2}:\d{2}(?:\.\d{1,3})?\]")
_LRC_METADATA_LINE_RE = re.compile(
    r"^\[(?:ar|ti|al|by|offset|length):[^\]]*\]$",
    flags=re.IGNORECASE,
)


def normalize_lyrics_for_detection(text: str | None) -> str | None:
    if text is None or not text.strip():
        return None

    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        line = _LRC_TIMESTAMP_RE.sub("", raw_line).strip()
        if not line or _LRC_METADATA_LINE_RE.fullmatch(line):
            continue
        cleaned_lines.append(line)

    normalized = " ".join(cleaned_lines).strip()
    return normalized or None


def detect_primary_lyrics_language(text: str | None) -> str | None:
    normalized = normalize_lyrics_for_detection(text)
    if not normalized:
        return None

    language = _LYRICS_LANGUAGE_DETECTOR.detect_language_of(normalized)
    if language is None:
        return None

    iso_code = getattr(language, "iso_code_639_1", None)
    iso_name = getattr(iso_code, "name", None)
    if not isinstance(iso_name, str) or not iso_name:
        return None
    return iso_name.lower()
