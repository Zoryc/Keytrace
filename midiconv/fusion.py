"""Note-level fusion of two transcriptions of the same audio (A = primary engine, B = second opinion)."""
from __future__ import annotations

from collections import defaultdict

from .model import Note

ONSET_TOLERANCE = 0.05  # seconds, same as the standard onset metric


def match_notes(ref: list[Note], est: list[Note], tol: float = ONSET_TOLERANCE) -> list[tuple[int, int]]:
    """One-to-one matching of same-pitch notes with onsets within `tol`, closest pairs first.
    Returns (index in ref, index in est) pairs."""
    by_pitch_r: dict[int, list[int]] = defaultdict(list)
    by_pitch_e: dict[int, list[int]] = defaultdict(list)
    for i, n in enumerate(ref):
        by_pitch_r[n.pitch].append(i)
    for j, n in enumerate(est):
        by_pitch_e[n.pitch].append(j)
    pairs = []
    for p, ri in by_pitch_r.items():
        ei = by_pitch_e.get(p)
        if not ei:
            continue
        cands = []
        ei_sorted = sorted(ei, key=lambda j: est[j].start)
        starts = [est[j].start for j in ei_sorted]
        import bisect

        for i in ri:
            t = ref[i].start
            k = bisect.bisect_left(starts, t - tol)
            while k < len(starts) and starts[k] <= t + tol:
                cands.append((abs(starts[k] - t), i, ei_sorted[k]))
                k += 1
        cands.sort()
        used_r, used_e = set(), set()
        for _, i, j in cands:
            if i in used_r or j in used_e:
                continue
            used_r.add(i)
            used_e.add(j)
            pairs.append((i, j))
    return pairs


def posterior_at(posterior, frame_seconds: float, pitch: int, t: float, radius: int = 2,
                 frame_offset: float = 0.0) -> tuple[float, int]:
    """Max of A's onset posterior for `pitch` within +-radius frames of time t, and the frame where it
    peaks; (0, -1) if unknown. Frame g of the map is centred at (g + frame_offset) * frame_seconds."""
    if posterior is None or not 21 <= pitch <= 108:
        return 0.0, -1
    g = int(round(t / frame_seconds - frame_offset))
    lo, hi = max(0, g - radius), min(posterior.shape[0], g + radius + 1)
    if hi <= lo:
        return 0.0, -1
    col = posterior[lo:hi, pitch - 21]
    k = int(col.argmax())
    return float(col[k]), lo + k


def fuse_notes(a: list[Note], b: list[Note], rule: str = "veto_low_conf", threshold: float = 0.9,
               posterior=None, frame_seconds: float = 1024 / 44100, veto_threshold: float = 0.0,
               durations=None, frame_offset: float = 0.0) -> list[Note]:
    """Rules:
      a_only / b_only    one engine alone
      union              A plus every B note A does not have
      intersect          only notes both engines found (A's timing and velocity)
      veto_low_conf      A's notes, except those with confidence < threshold that B did not find
      rescue             A plus B-only notes with velocity >= threshold * 100
      veto_and_rescue    both of the above
      post_rescue        A plus B-only notes where A's own onset posterior is >= threshold
                         (B breaks ties only where A was unsure); also drops unmatched A notes
                         with confidence < veto_threshold
    Matched notes keep A's timing, velocity and length; B-only notes keep B's."""
    if rule == "a_only":
        return list(a)
    if rule == "b_only":
        return list(b)
    pairs = match_notes(a, b)
    a_matched = {i for i, _ in pairs}
    b_matched = {j for _, j in pairs}
    out: list[Note] = []
    for i, n in enumerate(a):
        if rule == "intersect" and i not in a_matched:
            continue
        if rule in ("veto_low_conf", "veto_and_rescue") and i not in a_matched and n.confidence < threshold:
            continue
        if rule == "post_rescue" and i not in a_matched and n.confidence < veto_threshold:
            continue
        out.append(n)
    if rule in ("union", "rescue", "veto_and_rescue", "post_rescue"):
        # A's own decoded onsets also light up its posterior; a B-only note that close to an A note of
        # the same pitch is the same key, not a missed one.
        guard = (2 + 1) * frame_seconds + ONSET_TOLERANCE
        a_onsets: dict[int, list[float]] = defaultdict(list)
        for n in a:
            a_onsets[n.pitch].append(n.start)
        for v in a_onsets.values():
            v.sort()
        import bisect

        for j, n in enumerate(b):
            if j in b_matched:
                continue
            if rule == "post_rescue":
                near = a_onsets.get(n.pitch, [])
                k = bisect.bisect_left(near, n.start - guard)
                if k < len(near) and near[k] <= n.start + guard:
                    continue
                p, g = posterior_at(posterior, frame_seconds, n.pitch, n.start, frame_offset=frame_offset)
                if p < threshold:
                    continue
                end = n.end
                if durations is not None and g >= 0:  # A's own most likely key release for this onset
                    end = n.start + max(1, int(durations[g, n.pitch - 21])) * frame_seconds
                out.append(Note(n.start, end, n.pitch, n.velocity, round(max(p, 0.5), 3)))
                continue
            if rule != "union" and n.velocity < threshold * 100:
                continue
            out.append(Note(n.start, n.end, n.pitch, n.velocity, 0.5))
    out.sort(key=lambda n: (n.start, n.pitch))
    return out
