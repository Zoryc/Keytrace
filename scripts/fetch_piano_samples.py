"""Download the Splendid Grand Piano samples used by the playback preview into web/vendor/piano/.

The sample list is read from the vendored smplr build (web/vendor/smplr.mjs), so it always matches
the player. Samples: Akai Steinway, public domain (sfzinstruments/SplendidGrandPiano), hosted by
smplr at smpldsnds.github.io. About 23 MB, OGG Vorbis. Safe to re-run (skips existing files).
"""
from __future__ import annotations

import concurrent.futures as cf
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SMPLR = ROOT / "web" / "vendor" / "smplr.mjs"
DEST = ROOT / "web" / "vendor" / "piano"
BASE = "https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples/"


def sample_names() -> list[str]:
    s = SMPLR.read_text(encoding="utf-8")
    i = s.index("var LAYERS = [")
    j = s.index("\n];", i)
    names = re.findall(r'\[\d+, "([^"]+)"\]', s[i:j])
    if len(names) < 100:
        raise SystemExit(f"Unexpected smplr layout: found only {len(names)} samples")
    return sorted(set(names))


def fetch(name: str) -> int:
    dst = DEST / f"{name}.ogg"
    if dst.exists() and dst.stat().st_size > 0:
        return 0
    url = BASE + urllib.parse.quote(name) + ".ogg"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            tmp = dst.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(dst)
            return len(data)
        except Exception:
            if attempt == 3:
                raise
    return 0


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    names = sample_names()
    total = 0
    with cf.ThreadPoolExecutor(8) as pool:
        for k, n in enumerate(pool.map(fetch, names), 1):
            total += n
            print(f"\r{k}/{len(names)} samples", end="", flush=True)
    (DEST / "LICENSE.txt").write_text(
        "Splendid Grand Piano samples by Akai, released into the public domain.\n"
        "Source: https://github.com/sfzinstruments/SplendidGrandPiano (OGG versions hosted by smplr).\n",
        encoding="utf-8")
    print(f"\n{len(names)} samples in {DEST} ({total / 1e6:.1f} MB downloaded)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
