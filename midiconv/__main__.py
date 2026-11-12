"""Command line.

  python -m midiconv                       start the web app (http://127.0.0.1:8765)
  python -m midiconv serve --port 8765     same, explicit
  python -m midiconv convert song.mp3 [-o song.mid] [--engine transkun] [--set views=full ...]
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path


def _kv(items):
    out = {}
    for it in items or []:
        k, _, v = it.partition("=")
        out[k.strip()] = v.strip()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="midiconv", description="MIDI Converter")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="start the web app")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--no-browser", action="store_true")
    c = sub.add_parser("convert", help="convert one file")
    c.add_argument("input")
    c.add_argument("-o", "--output")
    c.add_argument("--instrument", default="piano")
    c.add_argument("--engine")
    c.add_argument("--set", action="append", metavar="KEY=VALUE", help="engine option")
    c.add_argument("--out", action="append", metavar="KEY=VALUE", help="output option")
    args = ap.parse_args(argv)

    if args.cmd == "convert":
        from .engines.base import Progress
        from .pipeline import convert

        src = Path(args.input)
        dst = Path(args.output) if args.output else src.with_suffix(".mid")

        def show(frac, msg):
            print(f"\r{frac * 100:5.1f}%  {msg or '':<60}", end="", file=sys.stderr, flush=True)

        with tempfile.TemporaryDirectory() as tmp:
            res = convert(src, tmp, instrument=args.instrument, engine=args.engine,
                          engine_options=_kv(args.set), output_options=_kv(args.out),
                          progress=Progress(show), write_preview_audio=False)
            shutil.copyfile(res.midi, dst)
        print(f"\n{res.stats['notes']} notes, {res.stats['pedals']} pedal events, "
              f"{res.stats['seconds_transcribe']} s -> {dst}", file=sys.stderr)
        return 0

    from .server import run

    run(host=getattr(args, "host", "127.0.0.1"), port=getattr(args, "port", 8765),
        open_browser=not getattr(args, "no_browser", False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
