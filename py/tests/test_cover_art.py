from __future__ import annotations

from io import BytesIO

from PIL import Image

from liked_music_syncer.cover_art import make_square_cover


def test_make_square_cover_returns_square_jpeg() -> None:
    image = Image.new("RGB", (1600, 900), (50, 100, 150))
    raw = BytesIO()
    image.save(raw, format="PNG")

    squared = make_square_cover(raw.getvalue(), size=512)
    result = Image.open(BytesIO(squared))

    assert result.size == (512, 512)
    assert result.format == "JPEG"
