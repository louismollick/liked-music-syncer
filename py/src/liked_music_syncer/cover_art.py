from __future__ import annotations

from io import BytesIO
from typing import cast

from PIL import Image, ImageChops, ImageOps


def _average_corner_color(image: Image.Image) -> tuple[int, int, int]:
    width, height = image.size
    corners: tuple[tuple[int, int, int], ...] = (
        cast(tuple[int, int, int], image.getpixel((0, 0))),
        cast(tuple[int, int, int], image.getpixel((width - 1, 0))),
        cast(tuple[int, int, int], image.getpixel((0, height - 1))),
        cast(tuple[int, int, int], image.getpixel((width - 1, height - 1))),
    )
    return (
        sum(pixel[0] for pixel in corners) // len(corners),
        sum(pixel[1] for pixel in corners) // len(corners),
        sum(pixel[2] for pixel in corners) // len(corners),
    )


def _trim_uniform_border(image: Image.Image, *, tolerance: int = 18) -> Image.Image:
    background = Image.new("RGB", image.size, _average_corner_color(image))
    difference = ImageChops.difference(image, background).convert("L")
    mask = difference.point(lambda value: 255 if value > tolerance else 0)
    bounding_box = mask.getbbox()

    if bounding_box is None:
        return image

    left, top, right, bottom = bounding_box
    if left == 0 and top == 0 and right == image.width and bottom == image.height:
        return image

    return image.crop(bounding_box)


def make_square_cover(image_bytes: bytes, size: int = 1200) -> bytes:
    source = Image.open(BytesIO(image_bytes)).convert("RGB")
    prepared = _trim_uniform_border(source)
    square = ImageOps.fit(
        prepared,
        (size, size),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )

    output = BytesIO()
    square.save(output, format="JPEG", quality=92)
    return output.getvalue()
