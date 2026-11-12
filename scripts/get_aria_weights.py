"""Download the Aria-AMT piano checkpoint into models/aria-amt/ (resumable).

  python scripts/get_aria_weights.py            # download (or resume) and verify
  python scripts/get_aria_weights.py --verify   # only check an existing file

Source: Hugging Face dataset repo loubb/aria-midi (EleutherAI aria-amt "piano-medium-double-1.0").
The weights are published alongside a CC BY-NC-SA 4.0 dataset and were trained on MAESTRO:
treat them as non-commercial. Only the Python standard library is used.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

FILENAME = "piano-medium-double-1.0.safetensors"
URL = f"https://huggingface.co/datasets/loubb/aria-midi/resolve/main/{FILENAME}"
SIZE = 446_577_344
SHA256 = "089d3129dbe93246aeda55efe668c8a48af08afaf9dd15c64cef0a07c0fb30a4"  # HF X-Linked-ETag
DEST_DIR = Path(__file__).resolve().parent.parent / "models" / "aria-amt"
CHUNK = 1 << 20


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def _fmt(n: float) -> str:
    return f"{n / 1e6:7.1f} MB"


def _download(part: Path, retries: int = 5) -> None:
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        if have == SIZE:
            return
        if have > SIZE:
            part.unlink()
            have = 0
        req = urllib.request.Request(URL, headers={"User-Agent": "midiconv-weights-fetch/1.0"})
        if have:
            req.add_header("Range", f"bytes={have}-")
            print(f"Resuming at {_fmt(have).strip()}")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if have and r.status != 206:  # server ignored the range: start over
                    have = 0
                mode = "ab" if have else "wb"
                t0, done, last = time.monotonic(), have, 0.0
                with open(part, mode) as f:
                    while True:
                        block = r.read(CHUNK)
                        if not block:
                            break
                        f.write(block)
                        done += len(block)
                        now = time.monotonic()
                        if now - last > 0.5 or done == SIZE:
                            rate = (done - have) / max(1e-6, now - t0)
                            print(f"\r{done / SIZE * 100:5.1f}%  {_fmt(done)} / {_fmt(SIZE).strip()}"
                                  f"  {rate / 1e6:5.1f} MB/s", end="", flush=True)
                            last = now
                print()
            if part.stat().st_size == SIZE:
                return
            print(f"Connection ended early ({part.stat().st_size} of {SIZE} bytes).")
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            print(f"\nDownload interrupted ({e.__class__.__name__}: {e}).")
        if attempt < retries:
            time.sleep(min(30, 2 ** attempt))
    raise SystemExit("Download failed; run the script again to resume.")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--verify", action="store_true", help="only verify an existing file")
    ap.add_argument("--no-hash", action="store_true", help="skip the SHA-256 check (size is still checked)")
    args = ap.parse_args(argv)

    DEST_DIR.mkdir(parents=True, exist_ok=True)
    dest = DEST_DIR / FILENAME
    part = dest.with_name(dest.name + ".part")

    if not dest.exists():
        if args.verify:
            print(f"Missing: {dest}")
            return 1
        print(f"Downloading {FILENAME} ({_fmt(SIZE).strip()}) to {DEST_DIR}")
        _download(part)
        # Check the download before it takes the final name: the engine only checks the size, so
        # a corrupt file under the final name would load and transcribe garbage.
        if not args.no_hash:
            print("Verifying SHA-256 ...")
            digest = _sha256(part)
            if digest != SHA256:
                part.unlink()
                print(f"Checksum mismatch ({digest}); the download was deleted. Run the script again.")
                return 1
        part.replace(dest)
        print(f"OK: {dest} ({dest.stat().st_size:,} bytes)")
        return 0

    size = dest.stat().st_size
    if size != SIZE:
        print(f"Wrong size: {size} bytes, expected {SIZE}. Delete {dest} and run again.")
        return 1
    if not args.no_hash:
        print("Verifying SHA-256 ...")
        digest = _sha256(dest)
        if digest != SHA256:
            print(f"Checksum mismatch ({digest}). Delete {dest} and run again.")
            return 1
    print(f"OK: {dest} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
