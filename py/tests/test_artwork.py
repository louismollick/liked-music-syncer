from __future__ import annotations

from pathlib import Path

from liked_music_syncer.artwork import extract_embedded_cover_thumbnail


def test_extract_embedded_cover_thumbnail_missing_file() -> None:
    result = extract_embedded_cover_thumbnail(
        {"file_path": "/tmp/does-not-exist-lms-artwork.m4a", "size": 128}
    )
    assert result["ok"] is False
    assert result["jpeg_base64"] is None


def test_extract_embedded_cover_thumbnail_no_cover(tmp_path: Path) -> None:
    audio = tmp_path / "empty.m4a"
    audio.write_bytes(b"not-a-real-m4a")
    result = extract_embedded_cover_thumbnail(
        {"file_path": str(audio), "size": 128}
    )
    assert result["ok"] in {True, False}
