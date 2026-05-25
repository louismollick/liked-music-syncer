from __future__ import annotations

import re

LYRICS_TIMESTAMP_RE = re.compile(r"^\[\d{2}:\d{2}(?:\.\d{2})?\]", flags=re.MULTILINE)
_LRC_LINE_RE = re.compile(r"^\[(?P<minutes>\d+):(?P<seconds>\d{2})(?:[.:](?P<fraction>\d{1,3}))?\]")
_LRC_METADATA_RE = re.compile(r"^\[[A-Za-z]{2,3}:[^\]]*\]$")


def classify_lyrics_text(value: str | None) -> str:
    if not value or not value.strip():
        return "missing"
    return "synced" if LYRICS_TIMESTAMP_RE.search(value) else "plain"


def lyrics_sidecar_text(lyrics_text: str | None, lyrics_status: str | None) -> str | None:
    if lyrics_status != "synced":
        return None
    if not lyrics_text or not lyrics_text.strip():
        return None
    return lyrics_text


def parse_lrc_timestamp_seconds(token: str) -> float | None:
    match = _LRC_LINE_RE.match(token.strip())
    if match is None:
        return None
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    fraction_raw = match.group("fraction") or ""
    if len(fraction_raw) == 1:
        fraction = int(fraction_raw) / 10
    elif len(fraction_raw) == 2:
        fraction = int(fraction_raw) / 100
    elif len(fraction_raw) == 3:
        fraction = int(fraction_raw) / 1000
    else:
        fraction = 0.0
    return (minutes * 60) + seconds + fraction


def iter_lrc_line_timestamps(text: str) -> list[float]:
    timestamps: list[float] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        while line.startswith("["):
            closing = line.find("]")
            if closing < 0:
                break
            token = line[: closing + 1]
            seconds = parse_lrc_timestamp_seconds(token)
            if seconds is None:
                break
            timestamps.append(seconds)
            line = line[closing + 1 :]
    return timestamps


def is_zero_timestamp_only_lrc(text: str | None) -> bool:
    if not text or not text.strip():
        return False
    timestamps = iter_lrc_line_timestamps(text)
    return bool(timestamps) and all(seconds == 0 for seconds in timestamps)


def strip_lrc_to_plain_text(text: str | None) -> str | None:
    if not text:
        return None
    plain_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            plain_lines.append("")
            continue
        if _LRC_METADATA_RE.fullmatch(line):
            continue
        while line.startswith("["):
            closing = line.find("]")
            if closing < 0:
                break
            token = line[: closing + 1]
            if parse_lrc_timestamp_seconds(token) is None:
                break
            line = line[closing + 1 :].lstrip()
        plain_lines.append(line)
    stripped = "\n".join(plain_lines).strip()
    return f"{stripped}\n" if stripped else None
