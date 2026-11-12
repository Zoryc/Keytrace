"""Offline analysis of note-level fusion between two engines, from notes saved by evaluate.py.

  python bench/fusion.py --a channels --b aria --sets clean,mp3,phone,reverb,noise,worst

Reports, per set:
  * agreement: how many of A's misses B catches, and how many of A's false notes B also has;
  * F1 of fusion rules (see RULES), with the confidence threshold chosen by leave-one-piece-out
    cross-validation so the numbers are not tuned on the piece they are measured on.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import evaluate as ev  # noqa: E402
from midiconv.fusion import fuse_notes, match_notes  # noqa: E402

THRESHOLDS = [0.0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 0.995]
POST_THRESHOLDS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.01]


def onset_prf(ref, est, limit):
    import mir_eval

    ref = [n for n in ref if n.start < limit]
    est = [n for n in est if n.start < limit]
    if not ref or not est:
        return 0.0, 0.0, 0.0
    r_iv, r_hz, _ = ev._arrays(ref)
    e_iv, e_hz, _ = ev._arrays(est)
    return mir_eval.transcription.precision_recall_f1_overlap(r_iv, r_hz, e_iv, e_hz, offset_ratio=None)[:3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default="channels")
    ap.add_argument("--b", default="aria")
    ap.add_argument("--sets", default="clean,mp3,phone,reverb,noise,worst")
    args = ap.parse_args()
    import json

    manifest = json.loads((ev.DATA / "maestro" / "manifest.json").read_text(encoding="utf-8"))
    for set_name in args.sets.split(","):
        pieces = []
        for m in manifest:
            a = ev.load_notes(args.a, set_name, m["id"])
            b = ev.load_notes(args.b, set_name, m["id"])
            if a is None or b is None:
                continue
            ref, ref_ped = ev.load_reference(ev.DATA / "maestro" / f"{m['id']}.mid", m["seconds"])
            post = ev.load_posterior(args.a, set_name, m["id"])
            pieces.append((m, ref, ref_ped, a, b, post))
        if not pieces:
            print(f"[{set_name}] no saved notes for both engines")
            continue

        # agreement analysis
        caught = missed_a = fp_a = fp_shared = 0
        for m, ref, _, (an, _), (bn, _), _post in pieces:
            lim = m["seconds"] - ev.EDGE_MARGIN
            ref_l = [n for n in ref if n.start < lim]
            an_l = [n for n in an if n.start < lim]
            bn_l = [n for n in bn if n.start < lim]
            ma = match_notes(ref_l, an_l)
            mb = match_notes(ref_l, bn_l)
            mab = match_notes(an_l, bn_l)
            a_hit_ref = {i for i, _ in ma}
            b_hit_ref = {i for i, _ in mb}
            a_tp = {j for _, j in ma}
            a_in_b = {i for i, _ in mab}
            for i in range(len(ref_l)):
                if i not in a_hit_ref:
                    missed_a += 1
                    caught += i in b_hit_ref
            for j in range(len(an_l)):
                if j not in a_tp:
                    fp_a += 1
                    fp_shared += j in a_in_b
        print(f"\n[{set_name}] {len(pieces)} pieces: B catches {caught}/{missed_a} of A's missed notes; "
              f"B also has {fp_shared}/{fp_a} of A's false notes")

        def evaluate(rule, thr, subset):
            fs = []
            for m, ref, _, (an, ap_), (bn, bp), post in subset:
                kw = {}
                if post is not None:
                    kw = {"posterior": post[0], "frame_seconds": post[1], "durations": post[2]}
                fused = fuse_notes(an, bn, rule=rule, threshold=thr, **kw)
                fs.append(onset_prf(ref, fused, m["seconds"] - ev.EDGE_MARGIN))
            return np.mean(fs, axis=0)

        base = evaluate("a_only", 0.0, pieces)
        print(f"  {'A alone':34s} P {base[0] * 100:6.2f}  R {base[1] * 100:6.2f}  F1 {base[2] * 100:6.2f}")
        bonly = evaluate("b_only", 0.0, pieces)
        print(f"  {'B alone':34s} P {bonly[0] * 100:6.2f}  R {bonly[1] * 100:6.2f}  F1 {bonly[2] * 100:6.2f}")
        has_post = all(pc[5] is not None for pc in pieces)
        rules = ("union", "intersect", "veto_low_conf", "rescue", "veto_and_rescue") + (("post_rescue",) if has_post else ())
        for rule in rules:
            # leave-one-piece-out threshold selection
            prf = []
            chosen = []
            for k in range(len(pieces)):
                train = pieces[:k] + pieces[k + 1:]
                grid = POST_THRESHOLDS if rule == "post_rescue" else THRESHOLDS
                best = max(grid, key=lambda t: evaluate(rule, t, train)[2]) if rule not in ("union", "intersect") else 0.0
                chosen.append(best)
                prf.append(evaluate(rule, best, [pieces[k]]))
            prf = np.mean(prf, axis=0)
            print(f"  {rule:34s} P {prf[0] * 100:6.2f}  R {prf[1] * 100:6.2f}  F1 {prf[2] * 100:6.2f}  "
                  f"(dF1 {(prf[2] - base[2]) * 100:+.2f}; thresholds {sorted(set(chosen))})")


if __name__ == "__main__":
    main()
