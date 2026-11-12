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


def fuse_notes(a: list[Note], b: list[Note], rule: str = "veto_low_conf", threshold: float = 0.9) -> list[Note]:
    """Rules:
      a_only / b_only    one engine alone
      union              A plus every B note A does not have
      intersect          only notes both engines found (A's timing and velocity)
      veto_low_conf      A's notes, except those with confidence < threshold that B did not find
      rescue             A plus B-only notes with velocity >= threshold * 100
      veto_and_rescue    both of the above
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
        out.append(n)
    if rule in ("union", "rescue", "veto_and_rescue"):
        for j, n in enumerate(b):
            if j in b_matched:
                continue
            if rule != "union" and n.velocity < threshold * 100:
                continue
            out.append(Note(n.start, n.end, n.pitch, n.velocity, 0.5))
    out.sort(key=lambda n: (n.start, n.pitch))
    return out
