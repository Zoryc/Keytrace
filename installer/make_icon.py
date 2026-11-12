"""Draw the Keytrace icon (installer/assets/Keytrace.ico) with Pillow.

The Keytrace mark, the one used everywhere (the favicon and header in web/index.html as inline SVG, the setup
window's LogoView in launcher/Controls.cs): a #2C7567 ("Essential" teal, in both themes) rounded square with
white piano keys (32 x 32 viewBox: rx 8, four 2.4-wide round-capped strokes from y 9 to 23, two 4 x 8 black-key
blocks at x 11 and 20, rx 1.2).

Each size is rendered at 8x and downsampled, so small sizes stay crisp. The ICO uses 32-bit
BMP entries up to 64 px (read by every Windows API and .NET's Icon class) and PNG entries for
128 and 256 px, like the icons Windows ships.

  python installer/make_icon.py [output.ico] [--png preview.png]
"""
from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (0x2C, 0x75, 0x67, 255)
WHITE = (255, 255, 255, 255)
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
PNG_MIN = 128  # entries this large or larger are stored as PNG
SUPERSAMPLE = 8


def render(size: int) -> Image.Image:
    """The icon at size x size pixels (RGBA)."""
    big = size * SUPERSAMPLE
    u = big / 32.0  # one viewBox unit in pixels
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(8 * u), fill=ACCENT)
    half = 1.2  # half the stroke width
    for x in (9, 14, 19, 24):  # white key separators: round-capped strokes from y=9 to y=23
        d.rounded_rectangle([(x - half) * u, (9 - half) * u, (x + half) * u - 1, (23 + half) * u - 1],
                            radius=round(half * u), fill=WHITE)
    for x in (11, 20):  # black keys
        d.rounded_rectangle([x * u, 9 * u, (x + 4) * u - 1, 17 * u - 1], radius=round(1.2 * u), fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def bmp_entry(img: Image.Image) -> bytes:
    """32-bit BGRA DIB for an ICO entry: BITMAPINFOHEADER, bottom-up pixels, AND mask."""
    w, h = img.size
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.tobytes("raw", "BGRA")
    stride = w * 4
    rows = b"".join(px[y * stride:(y + 1) * stride] for y in range(h - 1, -1, -1))
    mask_stride = ((w + 31) // 32) * 4
    alpha = img.getchannel("A").tobytes()
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(mask_stride)
        for x in range(w):
            if alpha[y * w + x] == 0:  # fully transparent: set the AND bit
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + rows + bytes(mask)


def png_entry(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: Path, sizes: list[int]) -> None:
    entries = []
    for s in sizes:
        img = render(s)
        entries.append((s, png_entry(img) if s >= PNG_MIN else bmp_entry(img)))
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for s, data in entries:
        dim = 0 if s >= 256 else s
        out.write(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    for _, data in entries:
        out.write(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out.getvalue())


def main(argv: list[str]) -> int:
    out = Path(__file__).resolve().parent / "assets" / "Keytrace.ico"
    preview = None
    args = list(argv)
    if "--png" in args:
        i = args.index("--png")
        preview = Path(args[i + 1])
        del args[i:i + 2]
    if args:
        out = Path(args[0])
    write_ico(out, SIZES)
    print(f"Wrote {out} ({out.stat().st_size} bytes, sizes {', '.join(map(str, SIZES))})")
    if preview is not None:
        sheet = Image.new("RGBA", (sum(SIZES) + 10 * len(SIZES) + 10, 276), (255, 255, 255, 255))
        x = 10
        for s in SIZES:
            sheet.alpha_composite(render(s), (x, 10))
            x += s + 10
        sheet.save(preview)
        print(f"Wrote preview {preview}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
