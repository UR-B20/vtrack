"""
images.py — what the engine will accept as a frame (CLAUDE.md §5.5).

JPEG only, at most 400 KB, at least 320 px wide. The engine is a public endpoint, so this
runs before anything expensive: a frame that fails here never reaches the model.

The size limit is 400 KiB. /capture targets 400 000 bytes, so a frame it produces passes on
either reading of "KB".
"""

from io import BytesIO

from PIL import Image, UnidentifiedImageError

MAX_BYTES = 400 * 1024
MIN_WIDTH = 320
JPEG_MAGIC = b"\xff\xd8\xff"


class ImageRejected(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def validate_jpeg(data: bytes) -> tuple[int, int]:
    """Return (width, height), or raise ImageRejected with the HTTP status to answer."""
    if not data:
        raise ImageRejected(422, "no image was sent")
    if len(data) > MAX_BYTES:
        raise ImageRejected(413, f"image is {len(data) // 1024} KB; the limit is 400 KB")
    if not data.startswith(JPEG_MAGIC):
        raise ImageRejected(415, "image must be a JPEG")
    try:
        # Image.open reads the header only; the pixels are not decoded here.
        with Image.open(BytesIO(data)) as im:
            if im.format != "JPEG":
                raise ImageRejected(415, "image must be a JPEG")
            width, height = im.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageRejected(422, "image could not be read as a JPEG") from exc
    if width < MIN_WIDTH:
        raise ImageRejected(422, f"image is {width} px wide; the minimum is {MIN_WIDTH} px")
    return width, height
