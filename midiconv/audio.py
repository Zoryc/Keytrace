"""Audio decoding (any format FFmpeg understands, via PyAV's bundled FFmpeg) and resampling."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


class AudioError(Exception):
    """A user-facing problem with the input file."""


@dataclass
class Audio:
    samples: np.ndarray  # float32, shape [n_samples, n_channels]
    sr: int

    @property
    def channels(self) -> int:
        return self.samples.shape[1]

    @property
    def duration(self) -> float:
        return self.samples.shape[0] / self.sr

    def mono(self) -> np.ndarray:
        return self.samples.mean(axis=1)

    def resampled(self, sr: int, quality: str = "VHQ") -> "Audio":
        if sr == self.sr:
            return self
        import soxr

        y = soxr.resample(self.samples, self.sr, sr, quality=quality)
        return Audio(np.ascontiguousarray(y, dtype=np.float32), sr)


def load_audio(path: str | Path, max_channels: int = 2) -> Audio:
    """Decode the first audio stream of any audio/video file to float32 at its native sample rate.

    More than `max_channels` channels are downmixed by FFmpeg (e.g. 5.1 -> stereo)."""
    import av

    path = str(path)
    try:
        container = av.open(path)
    except Exception as e:  # av.error.* subclasses vary across versions
        raise AudioError(f"Could not open this file as audio ({e.__class__.__name__}).") from e

    with container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise AudioError("This file has no audio track.")
        stream.thread_type = "AUTO"

        resampler = None
        chunks: list[np.ndarray] = []
        n_ch = 1
        rate = 0
        try:
            for frame in container.decode(stream):
                if resampler is None:
                    rate = frame.sample_rate
                    n_ch = min(max_channels, max(1, len(frame.layout.channels)))
                    resampler = av.AudioResampler(format="flt", layout="stereo" if n_ch == 2 else "mono", rate=rate)
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1, n_ch))
            if resampler is not None:
                for out in resampler.resample(None):
                    chunks.append(out.to_ndarray().reshape(-1, n_ch))
        except Exception as e:
            if not chunks:
                raise AudioError(f"Could not decode the audio ({e.__class__.__name__}).") from e
            # Truncated/corrupt tail: keep what decoded fine.

    if not chunks:
        raise AudioError("The audio track is empty.")
    y = np.ascontiguousarray(np.concatenate(chunks, axis=0), dtype=np.float32)
    if y.shape[0] < rate * 0.25:
        raise AudioError("The audio is too short (under a quarter of a second).")
    if not np.isfinite(y).all():
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    return Audio(y, rate)


def write_preview(audio: Audio, path: str | Path) -> None:
    """Lossless preview on exactly the timeline the engines saw (for A/B playback in the browser)."""
    import soundfile as sf

    sf.write(str(path), np.clip(audio.samples, -1.0, 1.0), audio.sr, format="FLAC", subtype="PCM_16")
