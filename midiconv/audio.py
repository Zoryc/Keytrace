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
        in_fmt = None  # (rate, layout, format) the current resampler was built for
        chunks: list[np.ndarray] = []
        n_ch = 1
        rate = 0
        bad = good = 0

        def drain(r, frame):
            for out in r.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1, n_ch))

        for packet in container.demux(stream):
            try:
                frames = packet.decode()
            except Exception:
                # Corrupt packet: keep the timeline by filling its duration with silence.
                bad += 1
                if rate and packet.duration and packet.time_base:
                    chunks.append(np.zeros((int(round(float(packet.duration * packet.time_base) * rate)), n_ch),
                                           dtype=np.float32))
                continue
            for frame in frames:
                fmt = (frame.sample_rate, frame.layout.name, frame.format.name)
                if resampler is None:
                    rate = frame.sample_rate
                    n_ch = min(max_channels, max(1, len(frame.layout.channels)))
                elif fmt != in_fmt:  # the stream changed format mid-file: flush, then start a new resampler
                    drain(resampler, None)
                    resampler = None
                if resampler is None:
                    resampler = av.AudioResampler(format="flt", layout="stereo" if n_ch == 2 else "mono", rate=rate)
                    in_fmt = fmt
                drain(resampler, frame)
                good += 1
        if resampler is not None:
            drain(resampler, None)
        if bad and good == 0:
            raise AudioError("Could not decode the audio: the file seems to be damaged.")

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

    block = 1 << 20  # frames; clipping block by block avoids a second full-length copy of the audio
    with sf.SoundFile(str(path), "w", samplerate=audio.sr, channels=audio.channels, format="FLAC",
                      subtype="PCM_16") as f:
        for i in range(0, len(audio.samples), block):
            f.write(np.clip(audio.samples[i:i + block], -1.0, 1.0))
