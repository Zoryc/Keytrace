"""Download short excerpts of MAESTRO v3 *test-split* pieces (audio + ground-truth MIDI).

MAESTRO is shipped as a single 108 GB zip, but the server supports HTTP range requests, so this
script opens the zip remotely (zipfile over a seekable HTTP reader) and only streams the first
`--seconds` of each selected WAV plus its MIDI file.

Output: bench/data/maestro/<id>.wav, <id>.mid, and manifest.json.
MAESTRO is licensed CC BY-NC-SA 4.0 (Hawthorne et al., ICLR 2019).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
import wave
import zipfile
from pathlib import Path

BASE = "https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/"
ZIP_URL = BASE + "maestro-v3.0.0.zip"
CSV_URL = BASE + "maestro-v3.0.0.csv"
ROOT = Path(__file__).resolve().parent / "data" / "maestro"


class HttpRangeFile(io.RawIOBase):
    """Read-only, seekable file object backed by HTTP range requests (with a read-ahead buffer)."""

    def __init__(self, url: str, block: int = 1 << 20):
        self.url, self.block, self.pos = url, block, 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
        self._buf_start, self._buf = -1, b""
        self.downloaded = 0

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=io.SEEK_SET):
        self.pos = {io.SEEK_SET: off, io.SEEK_CUR: self.pos + off, io.SEEK_END: self.size + off}[whence]
        return self.pos

    def _fetch(self, start: int, end: int) -> bytes:  # inclusive end
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                self.downloaded += len(data)
                return data
            except Exception:
                if attempt == 4:
                    raise

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        out = bytearray()
        while n > 0:
            in_buf = self._buf_start <= self.pos < self._buf_start + len(self._buf)
            if not in_buf:
                start = self.pos
                end = min(self.size - 1, start + max(self.block, n) - 1)
                self._buf, self._buf_start = self._fetch(start, end), start
            off = self.pos - self._buf_start
            chunk = self._buf[off: off + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def pick_pieces(rows, count):
    """Deterministic pick: test split sorted by (year, file), evenly spaced so every recording year
    (= different piano/room setups in MAESTRO) is represented."""
    test = sorted((r for r in rows if r["split"] == "test"), key=lambda r: (r["year"], r["audio_filename"]))
    count = min(count, len(test))
    return [test[round(i * (len(test) - 1) / max(1, count - 1))] for i in range(count)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=10, help="number of test pieces")
    ap.add_argument("--seconds", type=float, default=120.0, help="excerpt length from the start")
    args = ap.parse_args()

    ROOT.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(CSV_URL, timeout=60) as r:
        rows = list(csv.DictReader(io.TextIOWrapper(r, encoding="utf-8")))
    pieces = pick_pieces(rows, args.count)

    remote = HttpRangeFile(ZIP_URL)
    zf = zipfile.ZipFile(io.BufferedReader(remote, buffer_size=1 << 20))
    names = set(zf.namelist())
    prefix = "maestro-v3.0.0/"

    manifest = []
    for i, row in enumerate(pieces):
        pid = f"m{i:02d}"
        wav_name, mid_name = prefix + row["audio_filename"], prefix + row["midi_filename"]
        assert wav_name in names and mid_name in names, (wav_name, mid_name)

        (ROOT / f"{pid}.mid").write_bytes(zf.read(mid_name))

        with zf.open(wav_name) as fh:
            head = fh.read(4096)
            # Parse the RIFF header to find the data chunk.
            assert head[:4] == b"RIFF" and head[8:12] == b"WAVE"
            p, fmt, data_off = 12, None, None
            while p + 8 <= len(head):
                cid, csize = head[p:p + 4], int.from_bytes(head[p + 4:p + 8], "little")
                if cid == b"fmt ":
                    fmt = head[p + 8:p + 8 + csize]
                elif cid == b"data":
                    data_off = p + 8
                    break
                p += 8 + csize + (csize & 1)
            channels = int.from_bytes(fmt[2:4], "little")
            sr = int.from_bytes(fmt[4:8], "little")
            bits = int.from_bytes(fmt[14:16], "little")
            frame_bytes = channels * bits // 8
            want = int(args.seconds * sr) * frame_bytes
            pcm = bytearray(head[data_off:])
            while len(pcm) < want:
                chunk = fh.read(min(1 << 20, want - len(pcm)))
                if not chunk:
                    break
                pcm += chunk
            pcm = bytes(pcm[: len(pcm) - len(pcm) % frame_bytes][:want])

        with wave.open(str(ROOT / f"{pid}.wav"), "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(bits // 8)
            w.setframerate(sr)
            w.writeframes(pcm)

        dur = len(pcm) / frame_bytes / sr
        manifest.append({
            "id": pid, "seconds": dur, "composer": row["canonical_composer"], "title": row["canonical_title"],
            "year": row["year"], "audio_filename": row["audio_filename"], "midi_filename": row["midi_filename"],
        })
        print(f"[{i + 1}/{len(pieces)}] {pid}: {row['canonical_composer']} - {row['canonical_title']} "
              f"({dur:.0f}s)  downloaded so far {remote.downloaded / 1e6:.0f} MB", flush=True)

    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"done: {len(manifest)} pieces, {remote.downloaded / 1e6:.0f} MB downloaded -> {ROOT}")


if __name__ == "__main__":
    sys.exit(main())
