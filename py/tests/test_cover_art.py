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


def test_make_square_cover_trims_padded_thumbnail_before_square_crop() -> None:
    image = Image.new("RGB", (1200, 1200), (170, 190, 190))
    thumbnail = Image.new("RGB", (400, 240), (20, 40, 60))
    image.paste(thumbnail, (400, 480))

    raw = BytesIO()
    image.save(raw, format="PNG")

    squared = make_square_cover(raw.getvalue(), size=512)
    result = Image.open(BytesIO(squared)).convert("RGB")

    pixel = result.getpixel((8, 8))
    assert all(abs(channel - expected) <= 2 for channel, expected in zip(pixel, (20, 40, 60)))
