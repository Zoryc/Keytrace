"""Make degraded copies of the MAESTRO excerpts to test robustness on real-world-like audio.

Sets (bench/data/degraded/<set>/<id>.flac), all time-aligned with the originals:
  mp3      128 kbps MP3 round trip (lame via PyAV's bundled FFmpeg)
  phone    300-3400 Hz band, 8 kHz resample round trip, light clipping
  reverb   synthetic hall (RT60 ~1.6 s, early reflections), 50% wet
  noise    pink noise at 15 dB SNR
  worst    reverb + noise (20 dB) + phone band + 64 kbps MP3
Deterministic (fixed seeds).
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import numpy as np
import scipy.signal as sps
import soundfile as sf
import soxr

ROOT = Path(__file__).resolve().parent / "data"
SR = 44100


def mp3_roundtrip(y: np.ndarray, sr: int, kbps: int) -> np.ndarray:
    import av

    buf = io.BytesIO()
    with av.open(buf, "w", format="mp3") as out:
        st = out.add_stream("libmp3lame", rate=sr, layout="stereo" if y.shape[1] == 2 else "mono")
        st.bit_rate = kbps * 1000
        fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(y.T.astype(np.float32)), format="fltp",
                                        layout="stereo" if y.shape[1] == 2 else "mono")
        fr.sample_rate = sr
        for pkt in st.encode(fr):
            out.mux(pkt)
        for pkt in st.encode(None):
            out.mux(pkt)
    buf.seek(0)
    chunks = []
    with av.open(buf, "r") as inp:
        for frame in inp.decode(audio=0):
            chunks.append(frame.to_ndarray())
    z = np.concatenate(chunks, axis=1).T
    if z.shape[1] != y.shape[1]:
        z = z.reshape(-1, y.shape[1])
    n = y.shape[0]
    z = z[:n] if len(z) >= n else np.pad(z, ((0, n - len(z)), (0, 0)))
    return z.astype(np.float32)


def phone(y: np.ndarray, sr: int) -> np.ndarray:
    sos = sps.butter(6, [300, 3400], btype="bandpass", fs=sr, output="sos")
    z = sps.sosfiltfilt(sos, y, axis=0)
    z = soxr.resample(soxr.resample(z, sr, 8000, quality="HQ"), 8000, sr, quality="HQ")[: len(y)]
    z = z / (np.abs(z).max() + 1e-9) * 0.9
    z = np.tanh(2.0 * z) / np.tanh(2.0)  # mild clipping of a cheap mic/AGC
    return z.astype(np.float32)


def hall_rir(sr: int, rt60: float = 1.6, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(rt60 * 1.2 * sr)
    t = np.arange(n) / sr
    tail = rng.standard_normal((n, 2)) * np.exp(-6.9 * t / rt60)[:, None]
    tail[: int(0.012 * sr)] = 0
    sos = sps.butter(2, 6000, btype="low", fs=sr, output="sos")
    tail = sps.sosfilt(sos, tail, axis=0)
    rir = 0.25 * tail / np.sqrt((tail ** 2).sum(0, keepdims=True))
    rir[0] += 1.0  # direct path at t=0 keeps timing aligned
    for d, g in ((0.011, 0.5), (0.017, 0.4), (0.023, 0.35), (0.031, 0.3)):
        rir[int(d * sr)] += g * np.array([1, 0.8]) * rng.choice([-1, 1])
    return rir


def reverb(y: np.ndarray, sr: int, wet: float = 0.5) -> np.ndarray:
    rir = hall_rir(sr)
    chans = [sps.fftconvolve(y[:, c % y.shape[1]], rir[:, c % 2])[: len(y)] for c in range(y.shape[1])]
    z = np.stack(chans, 1)
    z = (1 - wet) * y + wet * z / (np.abs(z).max() + 1e-9) * np.abs(y).max()
    return z.astype(np.float32)


def pink_noise(n: int, ch: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((n, ch))
    spec = np.fft.rfft(white, axis=0)
    f = np.fft.rfftfreq(n, 1 / SR)
    spec /= np.sqrt(np.maximum(f, 20.0))[:, None]
    return np.fft.irfft(spec, n=n, axis=0)


def add_noise(y: np.ndarray, snr_db: float, seed: int) -> np.ndarray:
    nz = pink_noise(len(y), y.shape[1], seed)
    p_sig = np.mean(y ** 2)
    nz *= np.sqrt(p_sig / (np.mean(nz ** 2) * 10 ** (snr_db / 10)))
    return (y + nz).astype(np.float32)


SETS = {
    "mp3": lambda y, sr, i: mp3_roundtrip(y, sr, 128),
    "phone": lambda y, sr, i: phone(y, sr),
    "reverb": lambda y, sr, i: reverb(y, sr),
    "noise": lambda y, sr, i: add_noise(y, 15.0, 100 + i),
    "worst": lambda y, sr, i: mp3_roundtrip(phone(add_noise(reverb(y, sr), 20.0, 200 + i), sr), sr, 64),
}


def main():
    names = sys.argv[1:] or list(SETS)
    manifest = json.loads((ROOT / "maestro" / "manifest.json").read_text(encoding="utf-8"))
    for name in names:
        out_dir = ROOT / "degraded" / name
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, m in enumerate(manifest):
            dst = out_dir / f"{m['id']}.flac"
            if dst.exists():
                continue
            y, sr = sf.read(ROOT / "maestro" / f"{m['id']}.wav", dtype="float32", always_2d=True)
            z = SETS[name](y, sr, i)
            peak = np.abs(z).max()
            if peak > 0.99:
                z = z / peak * 0.99
            sf.write(dst, z, sr, format="FLAC", subtype="PCM_16")
        print(f"{name}: {len(manifest)} files -> {out_dir}", flush=True)


if __name__ == "__main__":
    main()
