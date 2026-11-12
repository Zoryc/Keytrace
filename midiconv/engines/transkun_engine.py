"""Transkun V2 piano engine (Yan & Duan, ISMIR 2024; pip package `transkun`, MIT code).

Runs the model in-process instead of through the transkun CLI (which needs pydub/ffmpeg and the
removed pkg_resources). Compared with the CLI it adds:
  * full-FP32 math (TF32 off) and soxr VHQ resampling,
  * a fix for upstream issue #42 (long events, mostly the sustain pedal, mis-ended/dropped
    when overlapping windows are merged),
  * test-time augmentation (TTA): several in-distribution views of every window are scored and
    their semi-CRF interval scores averaged before one exact Viterbi decode; velocities and
    onset/offset refinements are averaged over the views too,
Benchmarked on 12 MAESTRO test excerpts (bench/): the stereo views improve note-end F1 on 11/12
pieces (+0.55) and sustain-pedal onset F1 (+1.6) at equal onset F1. Smaller window hops are NOT
exposed: Transkun's window stitching assumes a 50 % overlap and duplicates notes otherwise
(onset precision fell to 72 % at a 4 s hop).
"""
from __future__ import annotations

import contextlib
import importlib.resources as ir
import json
import math
import sys
import threading
import types
import warnings
from collections import defaultdict

import numpy as np

from ..audio import Audio
from ..model import SOFT, SUSTAIN, Note, Pedal, Track, Transcription
from .base import Engine, Option, Progress

TARGET_SR = 44100
SEGMENT_SECONDS = 16.0  # training chunk length; positional embeddings are learned, keep it fixed
HOP_SECONDS = 8.0  # the stitching logic assumes 50 % overlap

VIEW_SETS = {
    "none": ["orig"],
    "channels": ["orig", "left", "right", "mid"],
    "full": ["orig", "left", "right", "mid", "bright", "dark"],
}


def _melscale_fbanks_htk(n_freqs, f_min, f_max, n_mels, sample_rate, norm=None, mel_scale="htk"):
    import torch

    hz2mel = lambda f: 2595.0 * math.log10(1.0 + f / 700.0)  # noqa: E731
    all_freqs = torch.linspace(0, sample_rate // 2, n_freqs)
    m_pts = torch.linspace(hz2mel(f_min), hz2mel(f_max), n_mels + 2)
    f_pts = 700.0 * (10 ** (m_pts / 2595.0) - 1.0)
    f_diff = f_pts[1:] - f_pts[:-1]
    slopes = f_pts.unsqueeze(0) - all_freqs.unsqueeze(1)
    down = (-1.0 * slopes[:, :-2]) / f_diff[:-1]
    up = slopes[:, 2:] / f_diff[1:]
    return torch.clamp(torch.minimum(down, up), min=0.0)


@contextlib.contextmanager
def _torchaudio_or_shim():
    """transkun only uses torchaudio to build a mel filterbank that the checkpoint overwrites anyway."""
    try:
        import torchaudio  # noqa: F401
        yield
        return
    except Exception:
        pass
    shim = types.ModuleType("torchaudio")
    shim.functional = types.SimpleNamespace(melscale_fbanks=_melscale_fbanks_htk)
    sys.modules["torchaudio"] = shim
    try:
        yield
    finally:
        if sys.modules.get("torchaudio") is shim:
            del sys.modules["torchaudio"]


def _usable_channels(y: np.ndarray) -> tuple[np.ndarray, str]:
    """Stereo views assume two live, positively correlated channels. Fall back to the live channel
    when one is (near) silent, and flip one channel when they are in opposite polarity, so that the
    'mid' view cannot cancel out. Returns (samples [N, C], note for the stats or '')."""
    if y.ndim != 2 or y.shape[1] != 2 or y.shape[0] == 0:
        return y, ""
    probe = y[:: max(1, y.shape[0] // 2_000_000)].astype(np.float64)  # <= ~2M frames is plenty
    e = np.sqrt((probe ** 2).mean(axis=0)) + 1e-12
    if e.min() < 0.01 * e.max():  # one channel more than 40 dB quieter
        live = int(np.argmax(e))
        return np.ascontiguousarray(y[:, live:live + 1]), f"used the {'left' if live == 0 else 'right'} channel only"
    corr = float((probe[:, 0] * probe[:, 1]).mean() / (e[0] * e[1]))
    if corr < -0.3:  # polarity-inverted channel
        out = y.copy()
        out[:, 1] *= -1.0
        return out, "right channel polarity inverted"
    return y, ""


class TranskunEngine(Engine):
    id = "transkun"
    name = "Transkun V2"
    instrument = "piano"
    summary = ("State-of-the-art solo piano transcription (ISMIR 2024): notes, velocities, "
               "sustain and soft pedal.")
    options = [
        Option("views", "Analysis views", "choice", "channels",
               "Each 16-second window is analysed from several angles (stereo, left, right, mid; "
               "optionally tone-tilted copies) and the scores are averaged before decoding.",
               choices=[("none", "Single view (paper settings)"),
                        ("channels", "Stereo views (4x)"),
                        ("full", "Stereo + tone views (6x)")]),
        Option("velocity", "Velocity read-out", "choice", "mode",
               "How a note's loudness is read from the model's probability distribution.",
               choices=[("mode", "Most likely (paper)"), ("mean", "Average"), ("median", "Median")]),
        Option("merge_fix", "Long-event merge fix", "bool", True,
               "Fixes upstream bug #42 that cuts or drops long sustain-pedal presses."),
    ]

    def __init__(self):
        self._model = None
        self._device = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ loading
    def availability(self):
        try:
            import transkun  # noqa: F401
            if not ir.files("transkun.pretrained").joinpath("2.0.pt").is_file():
                return False, "Transkun weights (2.0.pt) are missing from the transkun package."
            return True, ""
        except Exception as e:  # pragma: no cover
            return False, f"transkun is not installed ({e})."

    def _load(self):
        import torch

        if self._model is not None:
            return self._model
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)  # torch.jit.script deprecation (torch>=2.10)
            import transkun.ModelTransformer as MT

        pkg = ir.files("transkun.pretrained")
        conf = json.loads((pkg / "2.0.conf").read_text(encoding="utf-8"))["Model"]
        cfg = MT.Config()  # code defaults differ from the shipped conf -> overwrite every field
        for k in list(vars(cfg)):
            setattr(cfg, k, conf["config"][k])
        with ir.as_file(pkg / "2.0.pt") as p:
            state = torch.load(p, map_location="cpu", weights_only=True)
        state = state["best_state_dict"] if "best_state_dict" in state else state["state_dict"]
        with _torchaudio_or_shim():
            model = MT.TransKun(conf=cfg)
        res = model.load_state_dict(state, strict=False)
        if res.missing_keys or res.unexpected_keys:
            raise RuntimeError(f"Transkun checkpoint mismatch: {res}")
        model.backbone.useGradientCheckpoint = False  # avoids torch.utils.checkpoint in eval

        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cuda.matmul.allow_tf32 = False
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model = model.to(self._device).eval()
        return self._model

    def unload(self):
        self._model = None

    # ------------------------------------------------------------------ inference
    def transcribe(self, audio: Audio, opts: dict, progress: Progress) -> Transcription:
        import torch

        with self._lock:
            progress(0.0, "Loading the piano model")
            model = self._load()
            progress.check()
            a = audio.resampled(TARGET_SR, "VHQ")
            samples, channel_note = _usable_channels(a.samples)
            # Stays on the CPU: only one 16 s window at a time is moved to the GPU.
            x = torch.from_numpy(samples).transpose(0, 1).contiguous()  # [C, N]
            views = VIEW_SETS.get(opts.get("views", "channels"), ["orig"])
            if x.shape[0] == 1:
                views = [v for v in views if v not in ("left", "right", "mid")] or ["orig"]
            events, (posterior, durations, frame_offset) = self._run(
                model, x, HOP_SECONDS, views, opts.get("velocity", "mode"), bool(opts.get("merge_fix", True)), progress)

        notes, pedals = [], []
        for e in events:
            if e.pitch > 0:
                notes.append(Note(float(e.start), float(e.end), int(e.pitch), int(max(1, min(127, e.velocity))),
                                  round(float(getattr(e, "conf", 1.0)), 4)))
            elif -e.pitch in (SUSTAIN, SOFT):
                pedals.append(Pedal(float(e.start), float(e.end), int(-e.pitch), 127))
        notes.sort(key=lambda n: (n.start, n.pitch))
        pedals.sort(key=lambda p: (p.start, p.cc))
        info = {"views": views}
        if channel_note:
            info["channels"] = channel_note
        return Transcription([Track("Piano", 0, False, notes, pedals)], audio.duration, self.id, info,
                             aux={"onset_posterior": posterior, "onset_duration_frames": durations,
                                  "frame_seconds": model.hopSize / model.fs, "frame_offset": frame_offset,
                                  "lowest_pitch": 21})

    @staticmethod
    def _view(cur, name):
        """cur: [C, S] window. Returns a [C, S] view; every view must keep the channel count."""
        import torch

        if name == "orig":
            return cur
        if name in ("left", "right", "mid"):
            ch = {"left": cur[0], "right": cur[1], "mid": 0.5 * (cur[0] + cur[1])}[name]
            return ch.unsqueeze(0).expand_as(cur)
        if name in ("bright", "dark"):
            # Zero-phase spectral tilt, +-3 dB at the band edges around 1 kHz (inside the
            # +-3 dB EQ augmentation the model was trained with). Keeps the frame grid intact.
            spec = torch.fft.rfft(cur, dim=-1)
            f = torch.fft.rfftfreq(cur.shape[-1], 1.0 / TARGET_SR).to(cur.device)
            octaves = torch.log2(torch.clamp(f, 50.0, 16000.0) / 1000.0)  # about -4.3..+4
            sign = 1.0 if name == "bright" else -1.0
            gain_db = sign * 3.0 * torch.clamp(octaves / 4.0, -1.0, 1.0)
            spec = spec * (10.0 ** (gain_db / 20.0))
            return torch.fft.irfft(spec, n=cur.shape[-1], dim=-1)
        raise ValueError(name)

    def _run(self, model, x, hop_s, views, vel_mode, merge_fix, progress):
        import torch
        import torch.nn.functional as F
        from transkun.Data import resolveOverlapping
        from transkun.Util import makeFrame

        fs, hop = model.fs, model.hopSize
        seg_s = SEGMENT_SECONDS
        pad_begin = seg_s - hop_s
        x = F.pad(x, (math.ceil(pad_begin * fs), math.ceil(pad_begin * fs)))
        n_sample = x.shape[-1]
        n_sym = len(model.targetMIDIPitch)
        start_pos = [math.floor(pad_begin * fs / hop)] * n_sym
        step = math.ceil(hop_s * fs / hop) * hop
        seg = math.ceil(seg_s * fs)
        last_frame_idx = round(seg / hop)
        starts = list(range(0, n_sample, step))
        by_type = defaultdict(list)
        # onset posterior on the global frame grid, keys only (88 x frames), max over windows
        n_global = int(math.ceil((n_sample / fs - 2 * pad_begin) * fs / hop)) + 2
        posterior = np.zeros((max(1, n_global), 88), dtype=np.float32)
        durations = np.ones((max(1, n_global), 88), dtype=np.int32)  # frames

        # Global frame g is centred at (g + frame_offset) * hop / fs seconds; the offset is the same for
        # every window because window starts are whole multiples of the hop.
        frame_offset = (-pad_begin * fs / hop) - round(-pad_begin * fs / hop)
        with torch.inference_mode():
            for si, i in enumerate(starts):
                progress(si / len(starts), f"Transcribing window {si + 1} of {len(starts)}")
                begin_time = i / fs - pad_begin
                cur = x[:, i:min(i + seg, n_sample)].to(self._device)
                if cur.shape[-1] < seg:
                    cur = F.pad(cur, (0, seg - cur.shape[-1]))
                batch = torch.stack([self._view(cur, v) for v in views], 0)  # [K, C, S]
                frames = makeFrame(batch, hop, model.windowSize)  # [K, C, nFrame, W]
                events, last_p, onset_p, dur = self._decode_window(model, frames, start_pos, vel_mode, last_frame_idx)
                start_pos = [max(k - int(step / hop), 0) for k in last_p]
                off = int(round(begin_time * fs / hop))
                lo, hi = max(0, -off), min(onset_p.shape[0], posterior.shape[0] - off)
                if si > 0:
                    # A key already held when this window starts looks like an onset at its first frames;
                    # the previous window saw that region with context, so it is the one to trust.
                    lo = max(lo, 2)
                if hi > lo:  # keep, per frame and key, the window that is most sure of an onset there
                    new_p = onset_p[lo:hi, 2:].numpy()
                    cur_p = posterior[lo + off:hi + off]
                    take = new_p > cur_p
                    cur_p[take] = new_p[take]
                    durations[lo + off:hi + off][take] = dur[lo:hi, 2:].numpy()[take]

                for e in events:
                    e.start = max(e.start + begin_time, 0.0)
                    e.end = max(e.end + begin_time, e.start)
                for e in events:
                    lst = by_type[e.pitch]
                    if lst and e.start < lst[-1].end:
                        last = lst[-1]
                        if e.hasOnset:
                            lst[-1] = e
                        elif merge_fix and e.end <= last.start:
                            pass  # stale tail of an event `last` already superseded (#42)
                        elif merge_fix and e.hasOffset and not last.hasOffset:
                            last.hasOffset, last.end = True, e.end  # last.end was a window edge (#42)
                        else:
                            last.hasOffset = e.hasOffset
                            last.end = max(e.end, last.end)
                        continue
                    if e.hasOnset:
                        lst.append(e)
        progress(1.0, "Finishing")

        for lst in by_type.values():
            if lst:
                lst[-1].hasOffset = True
        events = [e for lst in by_type.values() for e in lst if e.hasOffset]
        with contextlib.redirect_stdout(None):  # resolveOverlapping prints '!!!!' for zero-length notes
            return resolveOverlapping(events), (posterior, durations, frame_offset)

    @staticmethod
    def _decode_window(model, frames, start_pos, vel_mode, last_frame_idx):
        """Like TransKun.transcribeFrames for one window, but with K views averaged."""
        import torch
        import torch.nn.functional as F
        from transkun import CRF
        from transkun.CRF.NeuralSemiCRFInterval import forward_backward
        from transkun.Data import Note as TNote

        K = frames.shape[0]
        mean = frames.mean(dim=[1, 2, 3], keepdim=True)
        std = frames.std(dim=[1, 2, 3], keepdim=True)
        fb = (frames - mean) / (std + 1e-8)
        feats = model.framewiseFeatureExtractor(fb).contiguous()
        feats = feats.view(K, *feats.shape[-3:])
        ctx = model.backbone(feats, outputIndices=torch.tensor(model.targetMIDIPitch, device=feats.device))
        S, S_skip = model.scorer(ctx)  # [T, T, K, nSym], [T-1, K, nSym]
        S, S_skip = S.mean(dim=2), S_skip.mean(dim=1)
        crf = CRF.NeuralSemiCRFInterval(S, S_skip)
        path = crf.decode(forcedStartPos=start_pos, forward=False)  # nSym lists of (begin, end) frames
        n_sym = len(model.targetMIDIPitch)
        assert len(path) == n_sym

        # Confidence: exact posterior (semi-CRF forward-backward) that the track has an event
        # starting within +-1 frame (+-23 ms) of a given frame, whatever its end.
        _, marg, _ = forward_backward(S, S_skip)  # marg[end, begin, track]
        onset_p = marg.sum(dim=0)  # [begin, track]
        # Most likely end frame for an event starting at each frame (gives notes added by another
        # engine a key release estimated by this model).
        dur = (marg.argmax(dim=0) - torch.arange(marg.shape[1], device=marg.device)[:, None]).clamp(min=1)
        onset_p = onset_p + F.pad(onset_p[1:], (0, 0, 0, 1)) + F.pad(onset_p[:-1], (0, 0, 1, 0))
        onset_p = onset_p.clamp(max=1.0).cpu()
        dur = dur.to(torch.int32).cpu()
        del marg
        if sum(len(p) for p in path) == 0:
            return [], [0] * n_sym, onset_p, dur

        p_vel = of_val = of_pres = 0.0
        for k in range(K):
            ca, cb, _, _ = model.fetchIntervalFeaturesBatch(ctx[k:k + 1], [path])
            inp = torch.cat([ca, cb, ca * cb], dim=-1)
            p_vel = p_vel + F.softmax(model.velocityPredictor(inp), dim=-1)
            v, pres = model.refinedOFPredictor(inp).chunk(2, dim=-1)
            mean_of = torch.distributions.ContinuousBernoulli(logits=v).mean
            of_val = of_val + torch.clamp((mean_of - 0.5) / 0.99, -0.5, 0.5)
            of_pres = of_pres + pres
        p_vel, of_val, of_pres = p_vel / K, of_val / K, of_pres / K

        w = torch.arange(128, device=p_vel.device)
        if vel_mode == "mean":
            velocity = (p_vel * w).sum(-1).round()
        elif vel_mode == "median":
            velocity = torch.argmax(((p_vel.cumsum(-1) - 0.5) > 0) * torch.arange(128, 0.0, -1, device=p_vel.device), -1)
        else:
            velocity = torch.argmax(p_vel, dim=-1)
        velocity = velocity.long().cpu().tolist()
        of_val = of_val.cpu().tolist()
        of_pres = (of_pres > 0).cpu().tolist()

        frame_dur = model.hopSize / model.fs
        out, last_p, n = [], [], 0
        for j, sym in enumerate(model.targetMIDIPitch):
            last_end, cur_last_p = 0.0, 0
            for (b, e) in path[j]:
                start = (b + of_val[n][0]) * frame_dur
                end = (e + of_val[n][1]) * frame_dur
                has_on = (b > 0) or of_pres[n][0]
                has_off = (e < last_frame_idx) or of_pres[n][1]
                start = max(start, last_end)
                end = max(end, start + 1e-8)
                last_end = end
                tn = TNote(start=start, end=end, pitch=sym, velocity=velocity[n],
                           hasOnset=has_on, hasOffset=has_off)
                tn.conf = float(onset_p[b, j])
                out.append(tn)
                if has_off:
                    cur_last_p = e
                n += 1
            last_p.append(cur_last_p)
        out.sort(key=lambda t: (t.start, t.end, t.pitch))
        return out, last_p, onset_p, dur
