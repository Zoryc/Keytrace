"""Aria-AMT piano engine (EleutherAI aria-amt; Bradshaw et al., "Aria-MIDI", ICLR 2025).

Code: Apache-2.0 (pip package `aria-amt`, imported as `amt`, plus its tokenizer package `ariautils`).
Weights: piano-medium-double-1.0.safetensors from the Hugging Face dataset repo loubb/aria-midi,
published with a CC BY-NC-SA 4.0 dataset and trained on MAESTRO: treat them as non-commercial.
Fetch them with `python scripts/get_aria_weights.py` (they go to models/aria-amt/).

A Whisper-style encoder-decoder (6+6 layers, d=768) that writes MIDI-like tokens: note on/off,
sustain pedal on/off, 10 ms onset times, velocity in steps of 5. Note offsets are *sounding*
offsets (the training targets had the sustain pedal folded into the note lengths); the pedal is
emitted as well.

Long audio uses aria's own driver, `amt.inference.transcribe.transcribe_file`: 30 s windows hopped
by 10 s; each window is prompted with the notes already transcribed in its first 10 s, decoding
stops at the first onset past 20 s, and the new tokens are shifted onto the file timeline.
Silent stretches (>5 s, 45 dB below the window peak) are cleaned with aria's own rules.

Upstream only runs as a posix multi-process CLI that reads files through torchaudio.io (removed in
torchaudio 2.9). Here it runs in-process instead:
  * the audio is decoded by midiconv, downmixed and resampled to 16 kHz with soxr VHQ, and handed to
    `transcribe_file` through an in-memory stand-in for `get_wav_segments` (same window layout,
    except that clips under 30 s are also split, so their last 10 s are not dropped);
  * the multiprocessing GPU queue is replaced by a synchronous object that decodes the window on
    the spot;
  * librosa is only needed for one silence helper; if it is not installed an equivalent numpy
    version is injected while `amt` is imported;
  * no torch.compile (no Triton on Windows) and no int8; bf16 autocast as upstream. Instead, each
    window is decoded by a sync-free re-implementation of `process_segments` whose per-token step
    is replayed as a CUDA graph (token-identical to upstream's process_segments on MAESTRO
    excerpts, about 7x faster here); `_transcribe_tokens(..., fast=False)` runs upstream's own;
  * the prompt builder's `random.shuffle` uses a private seeded RNG, so results are reproducible;
  * windows of digital silence (peak below -80 dBFS) are not decoded (the model babbles on them).
Token sequences are turned into notes by a tolerant version of aria's detokenizer (a malformed
token never aborts the whole file); sustain presses during which no note sounds are dropped (the
model emits them in bulk on quiet noise). Stereo is averaged to mono like aria's loader, unless the
channels cancel (polarity-inverted channel), in which case the louder channel is used.
"""
from __future__ import annotations

import contextlib
import importlib.util
import logging
import math
import random
import sys
import threading
import types
import warnings
from collections import Counter
from pathlib import Path

import numpy as np

from ..audio import Audio
from ..model import SUSTAIN, Note, Pedal, Track, Transcription
from .base import Engine, Progress

TARGET_SR = 16000
WINDOW_S = 30  # aria's chunk_len
STRIDE_FACTOR = 3  # 10 s hop; each window contributes its 10..20 s span (0..20 s for the first)
MODEL_CONFIG = "medium-double"
WEIGHTS_NAME = "piano-medium-double-1.0.safetensors"
WEIGHTS_SIZE = 446_577_344
WEIGHTS_PATH = Path(__file__).resolve().parents[2] / "models" / "aria-amt" / WEIGHTS_NAME
MAX_NOTE_MS = 5000  # aria's detokenizer caps every note at 5 s
CANCEL_CHECK_TOKENS = 64
USE_CUDA_GRAPH = True  # replay the per-token decoder step as a CUDA graph (eager fallback)
RNG_SEED = 0
SILENCE_PEAK = 1e-4  # windows whose peak is below -80 dBFS are not decoded

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------- import helpers
def _signal_to_frame_nonsilent(y, frame_length=2048, hop_length=512, top_db=60, ref=np.max,
                               aggregate=np.max):
    """numpy equivalent of librosa.effects._signal_to_frame_nonsilent (librosa >= 0.10, mono):
    centred RMS frames (zero padding), dB relative to `ref`, True where above -top_db."""
    y = np.asarray(y, dtype=np.float32).reshape(-1)
    pad = frame_length // 2
    yp = np.pad(y, (pad, pad), mode="constant")
    if len(yp) < frame_length:
        yp = np.pad(yp, (0, frame_length - len(yp)))
    frames = np.lib.stride_tricks.sliding_window_view(yp, frame_length)[::hop_length]
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=-1))
    ref_value = ref(rms) if callable(ref) else ref
    db = 20.0 * np.log10(np.maximum(1e-5, rms)) - 20.0 * np.log10(np.maximum(1e-5, ref_value))
    return db > -top_db


@contextlib.contextmanager
def _librosa_or_shim():
    """aria's transcribe module imports one private librosa helper at import time. Use the real one
    when it imports; otherwise (librosa absent, broken, or a version without that private helper)
    inject the numpy version for the duration of the import and put sys.modules back as it was."""
    try:
        real = importlib.util.find_spec("librosa") is not None
        if real:
            from librosa.effects import _signal_to_frame_nonsilent as _real  # noqa: F401
    except Exception:  # broken install, or the private helper moved
        real = False
    if real:
        yield
        return
    names = ("librosa", "librosa.effects")
    saved = {name: sys.modules.get(name) for name in names}
    lib = types.ModuleType("librosa")
    eff = types.ModuleType("librosa.effects")
    eff._signal_to_frame_nonsilent = _signal_to_frame_nonsilent
    lib.effects = eff
    sys.modules["librosa"], sys.modules["librosa.effects"] = lib, eff
    try:
        yield
    finally:
        for name, mod in (("librosa.effects", eff), ("librosa", lib)):
            if sys.modules.get(name) is mod:
                if saved[name] is None:
                    del sys.modules[name]
                else:
                    sys.modules[name] = saved[name]


def _import_aria():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # torch.jit.script deprecation, etc.
        with _librosa_or_shim():
            import amt.inference.transcribe as T
        from amt.audio import AudioTransform
        from amt.config import load_model_config
        from amt.inference.model import AmtEncoderDecoder, ModelConfig
        from amt.tokenizer import AmtTokenizer
    return T, AudioTransform, load_model_config, AmtEncoderDecoder, ModelConfig, AmtTokenizer


class _CountingHandler(logging.Handler):
    """Collects aria's driver log messages (window skips, recoveries, overflows) for Transcription.info."""

    KEYS = {
        "Context length overflow": "context_overflow",
        "Failed to reconcile": "reconcile_failed",
        "Removed tokens": "silence_cleanup",
    }

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.counts: Counter = Counter()

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return
        for k, v in self.KEYS.items():
            if k in msg:
                self.counts[v] += 1


# ---------------------------------------------------------------------------- engine
class AriaEngine(Engine):
    id = "aria"
    name = "Aria-AMT"
    instrument = "piano"
    summary = ("EleutherAI's sequence-to-sequence piano transcriber (ICLR 2025), trained with heavy "
               "audio augmentation: notes, velocities and sustain pedal.")
    options = []

    def __init__(self):
        self._lock = threading.Lock()
        self._model = None
        self._transform = None
        self._tokenizer = None
        self._T = None
        self._graph = None

    # ------------------------------------------------------------------ loading
    def availability(self):
        try:
            if importlib.util.find_spec("amt") is None or importlib.util.find_spec("ariautils") is None:
                return False, "aria-amt is not installed (pip install --no-deps aria-amt ariautils)."
            for dep in ("safetensors", "orjson", "tqdm"):
                if importlib.util.find_spec(dep) is None:
                    return False, f"aria-amt needs the '{dep}' package."
            if not WEIGHTS_PATH.is_file():
                return False, "Aria-AMT weights are missing (run scripts/get_aria_weights.py)."
            if WEIGHTS_PATH.stat().st_size != WEIGHTS_SIZE:
                return False, "Aria-AMT weights are incomplete (run scripts/get_aria_weights.py)."
            import torch

            if not torch.cuda.is_available():
                return False, "Aria-AMT needs an NVIDIA GPU (CUDA)."
            return True, ""
        except Exception as e:  # pragma: no cover
            return False, f"Aria-AMT is unavailable ({e.__class__.__name__}: {e})."

    def _load(self):
        if self._model is not None:
            return self._model
        import torch
        from safetensors.torch import load_file

        T, AudioTransform, load_model_config, AmtEncoderDecoder, ModelConfig, AmtTokenizer = _import_aria()

        class _InferenceTransform(AudioTransform):
            def _get_paths(self, dir_path):  # training-only noise/IR assets; don't touch site-packages
                return []

        tokenizer = AmtTokenizer()
        cfg = ModelConfig(**load_model_config(MODEL_CONFIG))
        cfg.set_vocab_size(tokenizer.vocab_size)
        model = AmtEncoderDecoder(cfg)
        state = load_file(str(WEIGHTS_PATH), device="cpu")
        state = {k.removeprefix("_orig_mod."): v for k, v in state.items()}  # compiled-model keys
        model.load_state_dict(state)
        model.decoder.setup_cache(batch_size=1, max_seq_len=T.MAX_BLOCK_LEN,
                                  dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float)
        model = model.cuda().eval()  # after setup_cache, as upstream (moves the causal mask too)
        transform = _InferenceTransform().cuda().eval()
        graph = None
        if USE_CUDA_GRAPH:
            try:
                graph = self._capture_decode_step(model)
            except Exception as e:  # pragma: no cover - fall back to eager decoding
                _log.warning("Aria-AMT: CUDA graph capture failed, decoding eagerly (%s)", e)
        self._T, self._tokenizer, self._transform, self._graph = T, tokenizer, transform, graph
        self._model = model  # last: a failed load leaves the engine unloaded
        return model

    @staticmethod
    def _capture_decode_step(model):
        """Records one single-token decoder step as a CUDA graph (~400 small kernels per token,
        so launch overhead dominates in eager mode). The graph reads the token and its position
        from static buffers and uses the model's KV caches in place; the cross-attention cache is
        filled by the eager prefill of each window, exactly as upstream."""
        import torch
        from torch.nn.attention import SDPBackend, sdpa_kernel

        dev = torch.device("cuda")
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float
        tok_buf = torch.zeros((1, 1), dtype=torch.long, device=dev)
        pos_buf = torch.zeros((1,), dtype=torch.long, device=dev)
        xa_none = torch.zeros(0, dtype=torch.int, device=dev)
        xa_dummy = torch.zeros((1, model.dims.n_audio_ctx, model.dims.n_audio_state), device=dev)

        def step():
            return model.decoder.forward(x=tok_buf, xa=xa_dummy, x_input_pos=pos_buf, xa_input_pos=xa_none)[:, -1]

        ctx = lambda: (torch.autocast("cuda", dtype=dtype, cache_enabled=False), torch.inference_mode(),  # noqa: E731
                       sdpa_kernel(SDPBackend.MATH))
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side), contextlib.ExitStack() as st:
            for c in ctx():
                st.enter_context(c)
            for _ in range(3):  # warm-up (writes junk at cache position 0; every prefill rewrites it)
                step()
        torch.cuda.current_stream().wait_stream(side)
        graph = torch.cuda.CUDAGraph()
        with contextlib.ExitStack() as st:
            for c in ctx():
                st.enter_context(c)
            with torch.cuda.graph(graph, capture_error_mode="thread_local"):
                out = step()
        torch.cuda.synchronize()
        return types.SimpleNamespace(graph=graph, tok=tok_buf, pos=pos_buf, out=out)

    def unload(self):
        with self._lock:  # never pull the model out from under a running transcription
            self._model = self._transform = self._tokenizer = self._graph = None
        try:
            import gc

            import torch

            gc.collect()  # the model's state-dict hooks form reference cycles
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # pragma: no cover
            pass

    # ------------------------------------------------------------------ inference
    def transcribe(self, audio: Audio, opts: dict, progress: Progress) -> Transcription:
        with self._lock:
            progress(0.0, "Loading the piano model")
            self._load()
            progress.check()
            wav = self._prepare(audio)
            seq, diag = self._transcribe_tokens(wav, progress)
        notes, pedals = tokens_to_events(seq, audio.duration)
        info = {"offsets": "sounding", "windows": diag.pop("windows")}
        if diag:
            info["driver"] = diag
        return Transcription([Track("Piano", 0, False, notes, pedals)], audio.duration, self.id, info)

    @staticmethod
    def _downmix(x: np.ndarray) -> np.ndarray:
        """Channel mean, as aria's loader, unless the channels cancel (one polarity-inverted: the
        mean is >20 dB below the louder channel), in which case the louder channel is used."""
        y = x.mean(axis=1)
        if x.shape[1] > 1:
            sub = slice(None, None, max(1, len(x) // 2_000_000))  # energy estimate, bounded memory
            ch = np.sqrt(np.mean(np.square(x[sub], dtype=np.float64), axis=0))
            mid = float(np.sqrt(np.mean(np.square(y[sub], dtype=np.float64))))
            if ch.max() > 0 and mid < 0.1 * ch.max():
                _log.info("Aria-AMT: stereo channels cancel when mixed; using channel %d", int(np.argmax(ch)))
                y = x[:, int(np.argmax(ch))]
        return y

    @classmethod
    def _prepare(cls, audio: Audio):
        """Mono 16 kHz float32 CPU tensor."""
        import torch

        mono = Audio(np.ascontiguousarray(cls._downmix(audio.samples)[:, None], dtype=np.float32), audio.sr)
        y = mono.resampled(TARGET_SR, "VHQ").samples[:, 0]
        return torch.from_numpy(np.ascontiguousarray(y, dtype=np.float32))

    @staticmethod
    def _windows(wav):
        """aria's get_wav_segments(stride_factor=3, pad_last=True) layout, from memory: windows of
        30 s starting every 10 s, the last one zero-padded, enough of them that every 10 s stride is
        transcribed (window k contributes [10k+10, 10k+20) s; the first one [0, 20) s)."""
        import torch.nn.functional as F

        chunk = TARGET_SR * WINDOW_S
        stride = chunk // STRIDE_FACTOR
        n_strides = max(1, math.ceil(len(wav) / stride))
        n_windows = max(1, n_strides - 1)
        total = (n_windows - 1) * stride + chunk
        wav = F.pad(wav, (0, max(0, total - len(wav))))
        return [wav[i * stride:i * stride + chunk] for i in range(n_windows)]

    def _transcribe_tokens(self, wav, progress: Progress, fast: bool = True):
        """Runs aria's own file driver (transcribe_file) on in-memory audio.

        fast=True decodes each window with `_decode_window` (token-identical to upstream's
        process_segments, without its ~10 host-device syncs per token); fast=False calls upstream's
        process_segments itself (kept for verification). Returns (token sequence, diagnostics)."""
        T, model, transform, tokenizer = self._T, self._model, self._transform, self._tokenizer
        windows = self._windows(wav)
        n = len(windows)

        def segments(audio_path=None, stride_factor=None, pad_last=False, segment=None):
            for i, w in enumerate(windows):
                progress(i / n, f"Transcribing window {i + 1} of {n}")
                yield w

        results: dict = {}
        silent = [0]
        t_logger = logging.getLogger("amt.inference.transcribe")
        decode = self._decode_window

        class _SyncGPU:  # stands in for the multiprocessing gpu_task_queue
            def put(self, item):
                (seg, prefix), pid = item
                prefix = list(prefix)  # upstream pads the prompt list in place (harmless only across processes)
                if float(seg.abs().max()) < SILENCE_PEAK:
                    # Digital silence is out of distribution (the model babbles until the 4096-token
                    # limit); answer "nothing new in this window" the way the model would.
                    results[pid] = prefix + [tokenizer.eos_tok]
                    silent[0] += 1
                elif fast:
                    results[pid] = decode(seg, prefix, progress, t_logger)
                else:
                    results[pid] = T.process_segments([((seg, prefix), pid)], model, transform, tokenizer,
                                                      t_logger)[0]

        steps = [0]
        orig_decode = T.decode_token

        def decode_token(*a, **k):  # cancel check inside long windows (upstream path only)
            steps[0] += 1
            if steps[0] % CANCEL_CHECK_TOKENS == 0:
                progress.check()
            return orig_decode(*a, **k)

        # The prompt builder shuffles the order of held-over ('prev') notes with the global
        # `random` module, which makes upstream non-deterministic; use a private seeded RNG so the
        # same audio always gives the same MIDI (and the global RNG is left alone).
        import amt.tokenizer as AT

        rng = random.Random(RNG_SEED)
        counter = _CountingHandler()
        saved = {k: getattr(T, k) for k in ("get_wav_segments", "decode_token", "tqdm", "random")}
        saved_tok_random = AT.random
        T.get_wav_segments = segments
        T.decode_token = decode_token
        T.tqdm = lambda it, *a, **k: it  # no progress bars on stderr from a worker thread
        T.random = AT.random = rng
        saved_log = (t_logger.level, t_logger.propagate)
        t_logger.addHandler(counter)  # aria's driver logs at INFO; count, don't print
        t_logger.setLevel(logging.INFO)
        t_logger.propagate = False
        try:
            seq = T.transcribe_file("<memory>", _SyncGPU(), results, pid=0, tokenizer=tokenizer)
        finally:
            t_logger.removeHandler(counter)
            t_logger.setLevel(saved_log[0])
            t_logger.propagate = saved_log[1]
            for k, v in saved.items():
                setattr(T, k, v)
            AT.random = saved_tok_random
        progress(1.0, "Finishing")
        diag = {"windows": n, **dict(counter.counts)}
        if silent[0]:
            diag["silent_windows"] = silent[0]
        for key in ("context_overflow", "reconcile_failed"):
            if diag.get(key):
                _log.warning("Aria-AMT: %s in %d of %d windows", key.replace("_", " "), diag[key], n)
        diag["tokens"] = len(seq)
        return seq, diag

    def _decode_window(self, audio_seg, prefix: list, progress: Progress, logger: logging.Logger):
        """Single-window re-implementation of amt.inference.transcribe.process_segments.

        Same model calls, same arithmetic, same greedy rules (pedal-off logit x1.05, onset/velocity
        expected-value re-pick within +-2 tokens, stop at <E> or at the first onset >= 20 s), but
        boolean-mask writes become torch.where and the stop test runs every CANCEL_CHECK_TOKENS
        steps, so the GPU is not synchronised ~10 times per token. Tokens produced after the stop
        are never written into the sequence, so the result is identical. The single-token steps
        replay a CUDA graph when one was captured (same kernels, ~5x faster on Windows)."""
        import torch
        from torch.nn.attention import SDPBackend, sdpa_kernel

        T, model, tok, graph = self._T, self._model, self._tokenizer, self._graph
        max_len = T.MAX_BLOCK_LEN
        dev = torch.device("cuda")
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float
        with torch.autocast("cuda", dtype=dtype), torch.inference_mode():
            log_mels = self._transform.log_mel(audio_seg.to(dev)[None])
            audio_features = model.encoder(xa=log_mels)

            prefix_len = len(prefix)
            seq = torch.tensor([tok.encode(tok.trunc_seq(list(prefix), max_len))], device=dev)
            eos = torch.full((1,), max_len, dtype=torch.int, device=dev)
            pos = torch.arange(max_len, device=dev)
            xa_all = torch.arange(audio_features.shape[1], device=dev)
            xa_none = torch.zeros(0, dtype=torch.int, device=dev)
            cols = torch.arange(3419, device=dev)[None]  # amt get_static_mask(): onset/velocity ids
            interval = (cols >= 392) & (cols <= 3418)
            vocab_idx = None
            nan_seen = torch.zeros((), dtype=torch.bool, device=dev)

            idx = prefix_len
            done = False
            for idx in range(prefix_len, max_len - 1):
                if idx == prefix_len:
                    logits = model.decoder.forward(x=seq[:, :idx], xa=audio_features,
                                                   x_input_pos=pos[:idx], xa_input_pos=xa_all)[:, -1]
                elif graph is not None:
                    graph.tok.copy_(seq[:, idx - 1:idx])
                    graph.pos.copy_(pos[idx - 1:idx])
                    graph.graph.replay()
                    logits = graph.out.clone()
                else:
                    with sdpa_kernel(SDPBackend.MATH):
                        logits = model.decoder.forward(x=seq[:, idx - 1:idx], xa=audio_features,
                                                       x_input_pos=pos[idx - 1:idx], xa_input_pos=xa_none)[:, -1]
                nan_seen |= torch.isnan(logits).any()
                logits[:, 389] *= 1.05  # pedal-off
                next_ids = torch.argmax(logits, dim=-1)

                # recalculate_tok_ids(): expected token id within +-2 of the argmax (onset/vel only)
                probs = torch.softmax(logits, dim=-1)
                tok_ids = next_ids.unsqueeze(1)
                beam = (cols <= tok_ids + 2) & (cols >= tok_ids - 2)
                keep = (interval & beam) | (cols == tok_ids)
                probs = torch.where(keep, probs, torch.zeros((), dtype=probs.dtype, device=dev))
                if vocab_idx is None:
                    vocab_idx = torch.arange(probs.size(1), device=dev).float().unsqueeze(0)
                ev = (probs * vocab_idx).sum(dim=1) / (probs.sum(dim=1) + 1e-9)
                # Upstream's TorchScript-fused kernel rounds .5 up (roundf), not half-to-even like
                # torch.round; ties are common because bf16 logits often tie.
                next_ids = torch.floor(ev + 0.5).to(torch.long)

                # update_seq_end_idxs_()
                eos = torch.where((next_ids == 1) & (eos > idx), idx, eos)
                eos = torch.where((next_ids >= 2418) & (eos > idx), idx - 2, eos)
                insert = (prefix_len <= idx) & (eos >= idx)
                seq[:, idx] = torch.where(insert, next_ids, seq[:, idx])

                if (idx - prefix_len) % CANCEL_CHECK_TOKENS == CANCEL_CHECK_TOKENS - 1:
                    progress.check()
                    if bool(nan_seen):
                        raise AssertionError("NaN seen in logits")
                    if bool((eos <= idx).all()):
                        done = True
                        break
            if bool(nan_seen):
                raise AssertionError("NaN seen in logits")
            if not done and bool((eos <= idx).all()):
                done = True
            if not done:
                logger.warning("Context length overflow when transcribing segment(s)")
            end = int(eos[0])
            return tok.decode(seq[0, :end + 1].tolist())


# ---------------------------------------------------------------------------- tokens -> notes
def tokens_to_events(seq, duration: float, max_note_ms: int | None = MAX_NOTE_MS):
    """Tolerant version of AmtTokenizer._detokenize_midi_dict on aria's stitched token sequence.

    Same semantics for well-formed input (times in ms, notes capped at `max_note_ms`, unclosed
    notes end at the end of the audio), but malformed tokens are skipped instead of aborting, and
    a re-struck key that never got its 'off' token closes the previous note at the new onset
    instead of silently dropping it."""
    dur_ms = duration * 1000.0
    open_notes: dict[int, tuple[int, int]] = {}
    raw: list[tuple[int, int, int, int]] = []  # (start_ms, end_ms, pitch, velocity)
    pedal_msgs: list[tuple[int, int]] = []  # (ms, 1 down / 0 up)

    def close(pitch, end_ms):
        start, vel = open_notes.pop(pitch)
        if max_note_ms is not None:
            end_ms = min(end_ms, start + max_note_ms)
        raw.append((start, end_ms, pitch, vel))

    toks = [t for t in seq if isinstance(t, tuple) and len(t) == 2]
    i = 0
    while i < len(toks):
        kind, val = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else (None, None)
        if kind == "on" and isinstance(val, int):
            vel = toks[i + 2] if i + 2 < len(toks) else (None, None)
            if nxt[0] != "onset" or vel[0] != "vel":
                i += 1
                continue
            if val in open_notes:
                close(val, nxt[1])
            open_notes[val] = (int(nxt[1]), int(vel[1]))
            i += 3
        elif kind == "off" and isinstance(val, int):
            if nxt[0] != "onset":
                i += 1
                continue
            if val in open_notes:
                close(val, nxt[1])
            i += 2
        elif kind == "pedal" and val in (0, 1):
            if nxt[0] != "onset":
                i += 1
                continue
            pedal_msgs.append((int(nxt[1]), int(val)))
            i += 2
        else:
            i += 1
    for pitch in list(open_notes):
        close(pitch, max(dur_ms, open_notes[pitch][0]))

    notes = []
    for start, end, pitch, vel in raw:
        s = start / 1000.0
        e = min(end / 1000.0, duration)
        if not (0 <= pitch <= 127) or s >= duration or e <= s:
            continue
        notes.append(Note(s, e, int(pitch), int(max(1, min(127, vel)))))
    notes.sort(key=lambda n: (n.start, n.pitch))

    pedals, down = [], None
    for ms, val in sorted(pedal_msgs, key=lambda t: t[0]):  # stable: same-time order kept
        if val == 1 and down is None:
            down = ms
        elif val == 0 and down is not None:
            if ms > down:
                pedals.append(Pedal(down / 1000.0, min(ms / 1000.0, duration), SUSTAIN, 127))
            down = None
    if down is not None and down / 1000.0 < duration:
        pedals.append(Pedal(down / 1000.0, duration, SUSTAIN, 127))
    pedals = [p for p in pedals if p.end > p.start]
    return notes, _drop_idle_pedals(notes, pedals)


def _drop_idle_pedals(notes: list[Note], pedals: list[Pedal]) -> list[Pedal]:
    """Drops sustain presses during which no note sounds: they change nothing audible, and on
    noise-only stretches (room tone, hiss before or after the music) the model emits them by the
    hundred (e.g. ~250 presses and no notes on 30 s of -70 dBFS white noise). Costs about 3 of 900
    real presses on the MAESTRO excerpts (pedal F1 -0.06). Unlike ariautils'
    remove_redundant_pedals, a note's (sounding) end does not need to fall inside the press."""
    import bisect

    union: list[list[float]] = []  # merged sounding intervals of all notes
    for n in sorted(notes, key=lambda n: n.start):
        if union and n.start <= union[-1][1]:
            union[-1][1] = max(union[-1][1], n.end)
        else:
            union.append([n.start, n.end])
    starts = [u[0] for u in union]
    out = []
    for p in pedals:
        k = bisect.bisect_left(starts, p.end) - 1  # last sounding stretch starting before the release
        if k >= 0 and union[k][1] > p.start:
            out.append(p)
    return out
