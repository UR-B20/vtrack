from io import BytesIO

import pytest
from PIL import Image

from vtrack_engine.images import MAX_BYTES, MIN_WIDTH, ImageRejected, validate_jpeg


def jpeg(w=640, h=360, quality=85, noise=False):
    im = Image.effect_noise((w, h), 80).convert("RGB") if noise else Image.new("RGB", (w, h), (20, 20, 20))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def rejected(data):
    with pytest.raises(ImageRejected) as e:
        validate_jpeg(data)
    return e.value.status


def test_accepts_a_normal_frame():
    assert validate_jpeg(jpeg()) == (640, 360)


def test_accepts_exactly_the_minimum_width():
    assert validate_jpeg(jpeg(w=MIN_WIDTH))[0] == MIN_WIDTH


def test_rejects_too_narrow():
    assert rejected(jpeg(w=MIN_WIDTH - 1)) == 422


def test_rejects_over_400_kb():
    big = jpeg(w=2000, h=1500, quality=100, noise=True)
    assert len(big) > MAX_BYTES
    assert rejected(big) == 413


def test_rejects_png():
    buf = BytesIO()
    Image.new("RGB", (640, 360)).save(buf, "PNG")
    assert rejected(buf.getvalue()) == 415


def test_rejects_not_an_image():
    assert rejected(b"hello, engine") == 415


def test_rejects_a_truncated_jpeg_header():
    assert rejected(b"\xff\xd8\xff" + b"\x00" * 64) == 422


def test_rejects_empty():
    assert rejected(b"") == 422


def rotated(w, h, orientation):
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = BytesIO()
    Image.new("RGB", (w, h), (20, 20, 20)).save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


@pytest.mark.parametrize(("orientation", "size"), [
    (1, (640, 360)), (3, (640, 360)), (5, (360, 640)), (6, (360, 640)), (8, (360, 640))])
def test_the_size_is_the_one_the_model_sees(orientation, size):
    # cv2.imdecode applies EXIF orientation, and the plate boxes come back in its turned
    # coordinates, so this must turn too.
    assert validate_jpeg(rotated(640, 360, orientation)) == size


def test_the_minimum_width_applies_after_turning():
    assert rejected(rotated(640, 300, 6)) == 422
