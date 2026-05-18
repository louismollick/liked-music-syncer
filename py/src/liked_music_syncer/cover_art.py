from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageStat


def make_square_cover(image_bytes: bytes, size: int = 1200) -> bytes:
    source = Image.open(BytesIO(image_bytes)).convert("RGB")
    width, height = source.size
    ratio = width / height if height else 1

    if 0.9 <= ratio <= 1.1:
        square = source
    elif 0.75 <= ratio <= 1.35:
        edge = min(width, height)
        left = max((width - edge) // 2, 0)
        top = max((height - edge) // 2, 0)
        square = source.crop((left, top, left + edge, top + edge))
    else:
        dominant = tuple(int(channel) for channel in ImageStat.Stat(source).mean[:3])
        edge = max(width, height)
        square = Image.new("RGB", (edge, edge), dominant)
        square.paste(source, ((edge - width) // 2, (edge - height) // 2))

    square.thumbnail((size, size))
    canvas = Image.new("RGB", (size, size), tuple(int(channel) for channel in ImageStat.Stat(square).mean[:3]))
    canvas.paste(square, ((size - square.width) // 2, (size - square.height) // 2))

    output = BytesIO()
    canvas.save(output, format="JPEG", quality=92)
    return output.getvalue()
