"""Faster, bit-identical decoding for Transkun's semi-CRF (transkun.CRF.NeuralSemiCRFInterval).

Upstream decodes each 16 s window with two TorchScript loops of ~690 steps (Viterbi and
forward-backward). Each step launches a few tiny GPU kernels, so the GPU mostly waits for kernel
launches, and the Viterbi backtracking indexes a tensor element by element (~125 ms per window).
This module keeps upstream's arithmetic and only changes how it is driven:

  * the Viterbi pointer loop is upstream's own code (copied verbatim into a TorchScript function
    that stops before the backtracking), and the backtracking runs on plain Python lists;
  * on a CUDA GPU with enough memory, the pointer loop and upstream's `forward_backward` are
    recorded once as CUDA graphs and replayed for every window (all windows have the same shape).

The kernels are the same ones in the same order, so the results are identical to upstream's, bit
for bit (checked on the bench: notes, pedals, onset posterior and MIDI files). Set the environment
variable KEYTRACE_CUDA_GRAPHS=0 to disable the graphs.
"""
from __future__ import annotations

import logging
import os
import warnings

import torch

_log = logging.getLogger(__name__)

# CUDA graphs keep their working memory (~1-1.5 GB here) reserved for as long as they exist, and
# Windows silently spills GPU memory to system RAM when a card runs out, which is slow. Use them
# only on cards with room to spare.
MIN_GRAPH_VRAM = 10 * 2**30
MIN_FREE_VRAM = 3 * 2**30  # ... and free memory when they are recorded (other apps may hold a lot)
WARMUP_RUNS = 3  # TorchScript settles its execution plan within the first calls; capture after that

_kernels = None


def _viterbi_pointers(score, noiseScore):
    # transkun.CRF.NeuralSemiCRFInterval.viterbiBackward up to the backtracking, verbatim.
    # score: [nEndPos, nBeginPos, nBatch]; noiseScore: [nEndPos-1, nBatch]
    T = score.shape[0]
    nBatch = score.shape[2]

    q = torch.zeros(T, nBatch, device=score.device)

    # for back tracking
    ptr = []

    scoreT = score.transpose(0, 1).contiguous()

    q[T - 1] = score[T - 1, T - 1, :] * (score[T - 1, T - 1, :] > 0)

    for i in range(1, T):
        # update v_on
        subScore = scoreT[T - i - 1, T - i:, :]

        tmp = torch.cat(
            [
                q[T - i:T - i + 1, :] + noiseScore[T - i - 1, :],  # skip
                q[T - i:, :] + subScore  # an interval
            ],
            dim=0
        )

        curV, selection = tmp.max(dim=0)

        ptr.append(selection - 1)

        singletonMask = score[T - i - 1, T - i - 1, :] > 0

        q[T - i - 1] = curV + score[T - i - 1, T - i - 1, :] * singletonMask

    return torch.stack(ptr, dim=0), torch.diagonal(score, dim1=0, dim2=1) > 0, score[T - 1, T - 1, :] > 0


def _scripted():
    """(viterbi_pointers, forward_backward) as TorchScript functions, created on first use."""
    global _kernels
    if _kernels is None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)  # torch.jit.script deprecation (torch>=2.10)
            from transkun.CRF.NeuralSemiCRFInterval import forward_backward

            _kernels = (torch.jit.script(_viterbi_pointers), forward_backward)
    return _kernels


def backtrack(ptr, diag, last, forced):
    """upstream viterbiBackward's backtracking on Python lists (same loop, ~25x faster than
    TorchScript's per-element tensor indexing).

    ptr: [T-1][nBatch] ints, diag: [nBatch][T] bools, last: [nBatch] bools, forced: nBatch ints.
    Returns one list of (begin, end) frame pairs per track."""
    T = len(ptr) + 1
    cols = list(zip(*ptr)) if ptr else [()] * len(last)
    result = []
    for idx in range(len(last)):
        col, cur_diag = cols[idx], diag[idx]
        j = forced[idx]
        cur = []
        while j < T - 1:
            sel = col[T - j - 2]
            if cur_diag[j]:
                cur.append((j, j))
            if sel < 0:
                j += 1
            else:
                i = sel + j + 1
                cur.append((j, i))
                j = i
        if last[idx]:
            cur.append((T - 1, T - 1))
        result.append(cur)
    return result


class SemiCRFDecoder:
    """Decodes one window's averaged interval scores: Viterbi paths and the interval marginals.

    Not thread-safe; the engine calls it under its own lock and inside torch.inference_mode()."""

    def __init__(self, device):
        self.device = str(device)
        self._graphs = None  # (static score, static noise, dp graph, dp outputs, fb graph, fb marginals)
        self._graph_shape = None
        self._graphs_failed = False

    def _want_graphs(self) -> bool:
        if self._graphs_failed or not self.device.startswith("cuda"):
            return False
        if os.environ.get("KEYTRACE_CUDA_GRAPHS", "1").strip() == "0":
            return False
        try:
            dev = torch.device(self.device)
            return (torch.cuda.get_device_properties(dev).total_memory >= MIN_GRAPH_VRAM
                    and torch.cuda.mem_get_info(dev)[0] >= MIN_FREE_VRAM)
        except Exception:  # pragma: no cover
            return False

    def _capture(self, score, noise):
        vp, fb = _scripted()
        s_score, s_noise = score.clone(), noise.clone()
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(WARMUP_RUNS):
                vp(s_score, s_noise)
                fb(s_score, s_noise)
        torch.cuda.current_stream().wait_stream(side)
        g_dp = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g_dp, capture_error_mode="thread_local"):
            dp_out = vp(s_score, s_noise)
        g_fb = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g_fb, capture_error_mode="thread_local"):
            _, fb_marg, _ = fb(s_score, s_noise)
        torch.cuda.synchronize()
        return s_score, s_noise, g_dp, dp_out, g_fb, fb_marg

    def decode(self, score, noise, forced):
        """Returns (paths, marginals). `marginals` (upstream forward_backward's grad, [end, begin,
        track]) may be a buffer that the next call overwrites: use it before decoding again."""
        shape = (tuple(score.shape), tuple(noise.shape), score.dtype)
        if self._graphs is not None and self._graph_shape != shape:
            self._graphs = None  # a different window size: fall back to capturing again
        if self._graphs is None and self._want_graphs():
            stream = torch.cuda.current_stream()
            try:
                self._graphs = self._capture(score, noise)
                self._graph_shape = shape
                _log.info("Transkun: semi-CRF loops recorded as CUDA graphs (T=%d)", score.shape[0])
            except Exception as e:  # pragma: no cover - decode eagerly instead (same results)
                torch.cuda.set_stream(stream)  # a failed capture can leave the capture stream current
                self._graphs, self._graphs_failed = None, True
                _log.warning("Transkun: CUDA graph capture failed, decoding without graphs (%s)", e)
        if self._graphs is not None:
            s_score, s_noise, g_dp, (ptr, diag, last), g_fb, marg = self._graphs
            s_score.copy_(score)
            s_noise.copy_(noise)
            g_dp.replay()
            paths = backtrack(ptr.cpu().tolist(), diag.cpu().tolist(), last.cpu().tolist(), forced)
            g_fb.replay()
            return paths, marg
        vp, fb = _scripted()
        ptr, diag, last = vp(score, noise)
        paths = backtrack(ptr.cpu().tolist(), diag.cpu().tolist(), last.cpu().tolist(), forced)
        _, marg, _ = fb(score, noise)
        return paths, marg
