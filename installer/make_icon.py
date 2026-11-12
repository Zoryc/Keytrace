"""Make the Keytrace icon (installer/assets/Keytrace.ico) from the master SVGs of the mark.

The masters are in web/brand/: keytrace-mark-small.svg (16-unit art, hand-tuned for 16 to 24 px) and
keytrace-mark.svg (64-unit art, for larger sizes). Every rendition of the mark derives from them: the web's
header (inline copy) and favicon (the small master itself), the desktop app's loading and error pages (read
from the master at run time), this icon, and the launcher's setup window (it draws the frame of this icon
that fits its logo, see launcher/Controls.cs).

Each icon size is rasterised from its master by headless Microsoft Edge, at exactly that size (a page of
size x size CSS pixels showing the SVG as an <img> at 100%, device scale factor 1, sRGB, transparent
background, software rasteriser so that the result does not depend on the GPU), so every frame is the
browser's own rendering of the vector art, not a resampled bitmap: the small art for 16, 20 and 24 px, the
full art for 32, 40, 48, 64, 96, 128 and 256 px.

The ICO holds one frame per size: 32-bit BMP entries up to 96 px (read by every Windows API and .NET's Icon
class) and PNG entries for 128 and 256 px, like the icons Windows ships. The file is then read back with
Pillow to check that every size is there, with the same pixels and alpha as its rendering.

  python installer/make_icon.py [output.ico] [--png preview.png] [--frames DIR] [--edge path\\to\\msedge.exe]

  --png     also write a contact sheet of the frames (on light and dark backgrounds)
  --frames  also write each frame as DIR/keytrace-<size>.png
  --edge    the Edge executable (default: the usual install locations, then msedge on PATH)
"""
from __future__ import annotations

import base64
import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "web" / "brand"
SMALL_SVG = BRAND / "keytrace-mark-small.svg"  # 16 to 24 px
FULL_SVG = BRAND / "keytrace-mark.svg"         # above 24 px
SMALL_SIZES = [16, 20, 24]
FULL_SIZES = [32, 40, 48, 64, 96, 128, 256]
SIZES = SMALL_SIZES + FULL_SIZES
PNG_MIN = 128  # entries this large or larger are stored as PNG
TEAL = (0x2C, 0x75, 0x67, 255)  # the masters' background, checked in every frame
EDGE_TIMEOUT = 90  # s per frame


def find_edge(explicit: str | None) -> Path:
    candidates = [Path(explicit)] if explicit else []
    for var in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(var)
        if base:
            candidates.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    on_path = shutil.which("msedge")
    if on_path:
        candidates.append(Path(on_path))
    for c in candidates:
        if c.is_file():
            return c
    raise SystemExit("Microsoft Edge (msedge.exe) not found; pass --edge path\\to\\msedge.exe")


def master_for(size: int) -> Path:
    return SMALL_SVG if size in SMALL_SIZES else FULL_SVG


def rasterise(edge: Path, svg: Path, size: int, work: Path) -> Image.Image:
    """The SVG at size x size pixels (RGBA), as headless Edge renders it on a transparent background."""
    uri = "data:image/svg+xml;base64," + base64.b64encode(svg.read_bytes()).decode("ascii")
    page = work / f"mark-{size}.html"
    shot = work / f"mark-{size}.png"
    page.write_text(
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        f"html,body{{margin:0;padding:0;width:{size}px;height:{size}px;overflow:hidden;background:transparent}}"
        "img{display:block;width:100%;height:100%}"
        f'</style></head><body><img src="{uri}" alt=""></body></html>', encoding="utf-8")
    profile = work / f"profile-{size}"  # a private profile: independent of any running Edge
    args = [str(edge), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-sync", "--hide-scrollbars", f"--user-data-dir={profile}",
            "--force-device-scale-factor=1", "--force-color-profile=srgb",
            "--default-background-color=00000000", f"--window-size={size},{size}",
            f"--screenshot={shot}", page.as_uri()]
    r = subprocess.run(args, capture_output=True, text=True, timeout=EDGE_TIMEOUT)
    if r.returncode != 0 or not shot.is_file():
        raise RuntimeError(f"Edge failed to render {svg.name} at {size} px (exit {r.returncode}):\n{r.stderr.strip()}")
    with Image.open(shot) as im:
        img = im.convert("RGBA")
    check_frame(img, size, f"{svg.name} at {size} px")
    return img


def check_frame(img: Image.Image, size: int, what: str) -> None:
    """The frame is size x size, with a transparent corner and the masters' teal at the top edge's middle
    (catches a blank or opaque screenshot and colour-managed output)."""
    if img.size != (size, size):
        raise RuntimeError(f"{what}: got {img.size[0]} x {img.size[1]} px")
    corner = img.getpixel((0, 0))[3]
    top = img.getpixel((size // 2, 0))
    if corner > 32 or top != TEAL:
        raise RuntimeError(f"{what}: unexpected pixels (corner alpha {corner}, top {top}, expected {TEAL})")


def render_all(edge: Path) -> dict[int, Image.Image]:
    # Edge's helper processes can hold their profile a moment after it exits: cleanup errors are not fatal.
    with tempfile.TemporaryDirectory(prefix="keytrace-icon-", ignore_cleanup_errors=True) as tmp:
        work = Path(tmp)
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = {s: pool.submit(rasterise, edge, master_for(s), s, work) for s in SIZES}
            return {s: jobs[s].result() for s in SIZES}


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


def write_ico(path: Path, frames: dict[int, Image.Image]) -> None:
    entries = [(s, png_entry(img) if s >= PNG_MIN else bmp_entry(img)) for s, img in sorted(frames.items())]
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


def verify_ico(path: Path, frames: dict[int, Image.Image]) -> None:
    """Read the ICO back with Pillow: one frame per size, each with the same RGBA bytes as its rendering, and a real
    alpha channel (transparent corners, an opaque body and translucent anti-aliased edges)."""
    with Image.open(path) as ico:
        if ico.format != "ICO":
            raise RuntimeError(f"{path}: not an ICO ({ico.format})")
        entries = len(ico.ico.entry)
        found = sorted(ico.ico.sizes())
        expected = sorted((s, s) for s in frames)
        if entries != len(frames) or found != expected:
            raise RuntimeError(f"{path}: {entries} entries, sizes {found}; expected {expected}")
        for s, src in frames.items():
            got = ico.ico.getimage((s, s)).convert("RGBA")
            if got.size != (s, s) or got.tobytes() != src.tobytes():
                raise RuntimeError(f"{path}: the {s} px frame differs from its rendering")
            alpha = got.getchannel("A")
            lo, hi = alpha.getextrema()
            translucent = sum(alpha.histogram()[1:255])
            if lo > 16 or hi != 255 or translucent == 0:
                raise RuntimeError(f"{path}: the {s} px frame lost its alpha (alpha {lo} to {hi}, "
                                   f"{translucent} translucent pixels)")


def contact_sheet(frames: dict[int, Image.Image]) -> Image.Image:
    """The frames left to right, on the app's light background (top) and dark background (bottom)."""
    pad = 10
    width = sum(frames) + pad * (len(frames) + 1)
    row = max(frames) + 2 * pad
    sheet = Image.new("RGBA", (width, 2 * row), (0xF6, 0xF8, 0xF7, 255))
    sheet.paste((0x0F, 0x15, 0x13, 255), (0, row, width, 2 * row))
    x = pad
    for s in sorted(frames):
        for y in (pad, row + pad):
            sheet.alpha_composite(frames[s], (x, y))
        x += s + pad
    return sheet


def main(argv: list[str]) -> int:
    out = Path(__file__).resolve().parent / "assets" / "Keytrace.ico"
    opts: dict[str, str] = {}
    args = list(argv)
    for flag in ("--png", "--frames", "--edge"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                raise SystemExit(f"{flag} needs a value")
            opts[flag] = args[i + 1]
            del args[i:i + 2]
    if len(args) > 1 or (args and args[0].startswith("-")):
        raise SystemExit(__doc__)
    if args:
        out = Path(args[0])
    for svg in (SMALL_SVG, FULL_SVG):
        if not svg.is_file():
            raise SystemExit(f"Master SVG not found: {svg}")
    edge = find_edge(opts.get("--edge"))
    frames = render_all(edge)
    tmp = out.with_name(out.name + ".tmp")  # replaces the icon only once it has passed the check
    write_ico(tmp, frames)
    try:
        verify_ico(tmp, frames)
    except Exception:
        tmp.unlink()
        raise
    tmp.replace(out)
    print(f"Wrote {out} ({out.stat().st_size} bytes, sizes {', '.join(map(str, SIZES))}; "
          f"{SMALL_SVG.name} up to {SMALL_SIZES[-1]} px, {FULL_SVG.name} above; rendered by {edge.name})")
    if "--frames" in opts:
        d = Path(opts["--frames"])
        d.mkdir(parents=True, exist_ok=True)
        for s, img in frames.items():
            img.save(d / f"keytrace-{s}.png")
        print(f"Wrote frames to {d}")
    if "--png" in opts:
        contact_sheet(frames).save(opts["--png"])
        print(f"Wrote preview {opts['--png']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
