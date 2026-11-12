"""Entry point.

  python -m midiconv                     open the Keytrace app window
  python -m midiconv convert song.mp3 [-o song.mid] [--engine transkun] [--set views=full] [--out pedal=extend]
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from . import APP_NAME


def _kv(items):
    out = {}
    for it in items or []:
        k, _, v = it.partition("=")
        out[k.strip()] = v.strip()
    return out


def convert_cli(argv) -> int:
    ap = argparse.ArgumentParser(prog="python -m midiconv convert",
                                 description=f"{APP_NAME}: convert one piano recording to MIDI without the app window")
    ap.add_argument("input", help="audio or video file")
    ap.add_argument("-o", "--output", help="MIDI file to write (default: the input's name with .mid)")
    ap.add_argument("--instrument", default="piano", help=argparse.SUPPRESS)  # piano is the only one
    ap.add_argument("--engine", help="ensemble, transkun or aria (default: the best one installed)")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE", help="engine option")
    ap.add_argument("--out", action="append", metavar="KEY=VALUE", help="output option")
    args = ap.parse_args(argv)

    from . import pipeline
    from .engines.base import Progress

    src = Path(args.input)
    dst = Path(args.output) if args.output else src.with_suffix(".mid")

    def show(frac, msg):
        print(f"\r{frac * 100:5.1f}%  {msg or '':<60}", end="", file=sys.stderr, flush=True)

    with tempfile.TemporaryDirectory() as tmp:
        stats = pipeline.run(src, tmp, instrument=args.instrument, engine=args.engine,
                             engine_options=_kv(args.set), output_options=_kv(args.out),
                             progress=Progress(show), preview=False)
        shutil.copyfile(Path(tmp) / pipeline.MIDI_FILE, dst)
    print(f"\n{stats['notes']} notes, {stats['pedals']} pedal events, "
          f"{stats['seconds_total']} s -> {dst}", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "convert":
        return convert_cli(argv[1:])
    from .desktop import main as desktop_main

    return desktop_main(argv)


if __name__ == "__main__":
    sys.exit(main())
