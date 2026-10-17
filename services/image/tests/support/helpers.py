"""Helper functions for test image generation."""

import io

from PIL import Image


def make_test_jpeg(width: int = 100, height: int = 100, with_gps: bool = False) -> bytes:
    """Generate JPEG image bytes with optional GPS EXIF tag."""
    img = Image.new("RGB", (width, height), color=(255, 100, 50))
    buf = io.BytesIO()
    if with_gps:
        exif = img.getexif()
        # Tag 34853 is GPSInfo
        gps_ifd = exif.get_ifd(34853)
        gps_ifd[1] = "N"
        gps_ifd[2] = 37.7749
        img.save(buf, format="JPEG", exif=exif)
    else:
        img.save(buf, format="JPEG")
    return buf.getvalue()


def make_test_png(width: int = 100, height: int = 100) -> bytes:
    """Generate PNG image bytes."""
    img = Image.new("RGBA", (width, height), color=(100, 200, 50, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_test_webp(width: int = 100, height: int = 100) -> bytes:
    """Generate WebP image bytes."""
    img = Image.new("RGB", (width, height), color=(50, 100, 255))
    buf = io.BytesIO()
    img.save(buf, format="WEBP")
    return buf.getvalue()
