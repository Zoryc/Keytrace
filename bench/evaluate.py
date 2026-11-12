"""Accuracy benchmark against MAESTRO ground truth (mir_eval, standard AMT metrics).

  python bench/evaluate.py                        # default config matrix on clean audio
  python bench/evaluate.py --configs base,channels --sets clean,mp3
  python bench/evaluate.py --list

Metrics (F1, averaged per piece like the MAESTRO papers):
  onset      note onset within 50 ms, same pitch
  on+off     ... and offset within max(50 ms, 20% of duration), offsets = key releases
  on+off+vel ... and velocity within 10% after per-piece scaling (mir_eval.transcription_velocity)
  pedoff     onset+offset with sounding (pedal-extended) offsets for both reference and estimate
  ped_on     sustain-pedal press onset within 50 ms (pedal treated as one pitch)
Results are cached per (config, set, piece) under bench/results/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))

from midiconv.audio import load_audio  # noqa: E402
from midiconv.engines import Progress, get_engine  # noqa: E402
from midiconv.model import SUSTAIN, Note, Pedal  # noqa: E402
from midiconv.postprocess import pedal_extended_ends  # noqa: E402

DATA = ROOT / "data"
RESULTS = ROOT / "results"
EDGE_MARGIN = 1.0  # ignore notes starting in the last second of an excerpt (cut at the edge)

# name -> (engine id, engine options)
CONFIGS = {
    "stock": ("transkun", {"_stock": True}),
    "base": ("transkun", {"views": "none", "hop": "8", "merge_fix": True}),
    "nofix": ("transkun", {"views": "none", "hop": "8", "merge_fix": False}),
    "channels": ("transkun", {"views": "channels", "hop": "8", "merge_fix": True}),
    "full": ("transkun", {"views": "full", "hop": "8", "merge_fix": True}),
    "vel_mean": ("transkun", {"views": "none", "hop": "8", "velocity": "mean"}),
    "vel_median": ("transkun", {"views": "none", "hop": "8", "velocity": "median"}),
    "aria": ("aria", {}),
    "ensemble": ("ensemble", {"views": "channels", "rescue": "0.3"}),
}
DEFAULT = ["base", "channels", "full"]


def load_reference(mid_path: Path, duration: float):
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(str(mid_path))
    notes, pedals = [], []
    for inst in pm.instruments:
        for n in inst.notes:
            notes.append(Note(n.start, min(n.end, duration), n.pitch, n.velocity))
        down = None
        for cc in sorted((c for c in inst.control_changes if c.number == SUSTAIN), key=lambda c: c.time):
            if cc.value >= 64 and down is None:
                down = cc.time
            elif cc.value < 64 and down is not None:
                pedals.append(Pedal(down, cc.time, SUSTAIN))
                down = None
        if down is not None:
            pedals.append(Pedal(down, duration, SUSTAIN))
    notes = [n for n in notes if n.start < duration and n.end > n.start]
    notes.sort(key=lambda n: (n.start, n.pitch))
    return notes, pedals


def _arrays(notes, ends=None):
    if not notes:
        return np.zeros((0, 2)), np.zeros(0), np.zeros(0)
    iv = np.array([[n.start, (ends[i] if ends is not None else n.end)] for i, n in enumerate(notes)])
    iv[:, 1] = np.maximum(iv[:, 1], iv[:, 0] + 1e-3)
    hz = 440.0 * 2.0 ** ((np.array([n.pitch for n in notes]) - 69) / 12.0)
    vel = np.array([n.velocity for n in notes], dtype=float)
    return iv, hz, vel


def score(ref_notes, ref_pedals, est_notes, est_pedals, duration):
    import mir_eval

    limit = duration - EDGE_MARGIN
    ref_ends = pedal_extended_ends(ref_notes, ref_pedals)
    est_ends = pedal_extended_ends(est_notes, est_pedals)
    keep_r = [i for i, n in enumerate(ref_notes) if n.start < limit]
    keep_e = [i for i, n in enumerate(est_notes) if n.start < limit]
    rn = [ref_notes[i] for i in keep_r]
    en = [est_notes[i] for i in keep_e]
    r_iv, r_hz, r_v = _arrays(rn)
    e_iv, e_hz, e_v = _arrays(en)
    r_iv_p, _, _ = _arrays(rn, [ref_ends[i] for i in keep_r])
    e_iv_p, _, _ = _arrays(en, [est_ends[i] for i in keep_e])
    T = mir_eval.transcription
    out = {}
    if len(rn) == 0 or len(en) == 0:
        return {"onset": 0.0, "on+off": 0.0, "on+off+vel": 0.0, "pedoff": 0.0, "ped_on": 0.0,
                "n_ref": len(rn), "n_est": len(en)}
    p, r, f, _ = T.precision_recall_f1_overlap(r_iv, r_hz, e_iv, e_hz, offset_ratio=None)
    out.update(onset=f, onset_p=p, onset_r=r)
    out["on+off"] = T.precision_recall_f1_overlap(r_iv, r_hz, e_iv, e_hz)[2]
    out["on+off+vel"] = mir_eval.transcription_velocity.precision_recall_f1_overlap(
        r_iv, r_hz, r_v, e_iv, e_hz, e_v)[2]
    out["pedoff"] = T.precision_recall_f1_overlap(r_iv_p, r_hz, e_iv_p, e_hz)[2]
    rp = [p_ for p_ in ref_pedals if p_.cc == SUSTAIN and p_.start < limit]
    ep = [p_ for p_ in est_pedals if p_.cc == SUSTAIN and p_.start < limit]
    if rp and ep:
        riv = np.array([[q.start, max(q.end, q.start + 1e-3)] for q in rp])
        eiv = np.array([[q.start, max(q.end, q.start + 1e-3)] for q in ep])
        out["ped_on"] = T.precision_recall_f1_overlap(riv, np.full(len(rp), 100.0), eiv,
                                                      np.full(len(ep), 100.0), offset_ratio=None)[2]
    else:
        out["ped_on"] = float(bool(not rp and not ep))
    out["n_ref"], out["n_est"] = len(rn), len(en)
    return out


def run_engine(cfg_name, audio):
    engine_id, opts = CONFIGS[cfg_name]
    eng = get_engine("piano", engine_id)
    if opts.get("_stock"):  # upstream TransKun.transcribe, for parity checks
        import torch

        model = eng._load()
        x = torch.from_numpy(audio.resampled(44100).samples).to(eng._device)
        with torch.no_grad():
            import contextlib
            with contextlib.redirect_stdout(None):
                events = model.transcribe(x)
        notes = [Note(e.start, e.end, e.pitch, e.velocity) for e in events if e.pitch > 0]
        pedals = [Pedal(e.start, e.end, -e.pitch) for e in events if e.pitch < 0]
        return notes, pedals
    from midiconv.engines.base import coerce_options

    tr = eng.transcribe(audio, coerce_options(eng.options, opts), Progress())
    t = tr.tracks[0]
    run_engine.last_aux = tr.aux
    return t.notes, t.pedals


run_engine.last_aux = {}


def save_notes(cfg, set_name, piece_id, notes, pedals):
    """Keep raw estimates so fusion strategies can be evaluated offline (bench/fusion.py)."""
    d = RESULTS / "notes"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{cfg}__{set_name}__{piece_id}.json").write_text(json.dumps({
        "notes": [[n.start, n.end, n.pitch, n.velocity, n.confidence] for n in notes],
        "pedals": [[p.start, p.end, p.cc] for p in pedals]}))


def load_notes(cfg, set_name, piece_id):
    f = RESULTS / "notes" / f"{cfg}__{set_name}__{piece_id}.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    return ([Note(*n) for n in d["notes"]], [Pedal(s, e, c) for s, e, c in d["pedals"]])


def load_posterior(cfg, set_name, piece_id):
    f = RESULTS / "notes" / f"{cfg}__{set_name}__{piece_id}.post.npz"
    if not f.exists():
        return None
    z = np.load(f)
    dur = z["dur"].astype(np.int32) if "dur" in z.files else None
    return z["post"].astype(np.float32), float(z["frame_seconds"]), dur


def audio_for_set(set_name, piece_id):
    src = DATA / "maestro" / f"{piece_id}.wav"
    if set_name == "clean":
        return src
    p = DATA / "degraded" / set_name / f"{piece_id}.flac"
    if not p.exists():
        raise FileNotFoundError(f"{p} missing: run bench/degrade.py first")
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(DEFAULT))
    ap.add_argument("--sets", default="clean", help="clean,mp3,phone,reverb,noise,worst or 'all'")
    ap.add_argument("--pieces", default="", help="comma list of piece ids (default: all)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--need-notes", action="store_true", help="re-run cached entries that have no saved notes")
    args = ap.parse_args()
    if args.list:
        for k, v in CONFIGS.items():
            print(f"{k:16s} {v}")
        return
    manifest = json.loads((DATA / "maestro" / "manifest.json").read_text(encoding="utf-8"))
    if args.pieces:
        keep = set(args.pieces.split(","))
        manifest = [m for m in manifest if m["id"] in keep]
    RESULTS.mkdir(parents=True, exist_ok=True)
    configs = [c for c in args.configs.split(",") if c]
    sets = ["clean", "mp3", "phone", "reverb", "noise", "worst"] if args.sets == "all" else [s for s in args.sets.split(",") if s]
    table = {}
    for set_name in sets:
        for m in manifest:
            ref_notes, ref_pedals = load_reference(DATA / "maestro" / f"{m['id']}.mid", m["seconds"])
            audio = None
            for cfg in configs:
                key = hashlib.sha1(json.dumps([cfg, CONFIGS[cfg], set_name, m["id"]]).encode()).hexdigest()[:16]
                cache = RESULTS / f"{cfg}__{set_name}__{m['id']}__{key}.json"
                if cache.exists() and not args.no_cache and (load_notes(cfg, set_name, m["id"]) or not args.need_notes):
                    res = json.loads(cache.read_text())
                else:
                    if audio is None:
                        audio = load_audio(audio_for_set(set_name, m["id"]))
                    t0 = time.perf_counter()
                    run_engine.last_aux = {}
                    est_notes, est_pedals = run_engine(cfg, audio)
                    save_notes(cfg, set_name, m["id"], est_notes, est_pedals)
                    post = run_engine.last_aux.get("onset_posterior")
                    if post is not None:
                        np.savez_compressed(RESULTS / "notes" / f"{cfg}__{set_name}__{m['id']}.post.npz",
                                            post=post.astype(np.float16),
                                            dur=run_engine.last_aux["onset_duration_frames"].astype(np.int16),
                                            frame_seconds=run_engine.last_aux["frame_seconds"])
                    res = score(ref_notes, ref_pedals, est_notes, est_pedals, m["seconds"])
                    res["seconds"] = time.perf_counter() - t0
                    cache.write_text(json.dumps(res))
                table.setdefault((set_name, cfg), []).append(res)
                print(f"{set_name:8s} {cfg:16s} {m['id']}  onset {res['onset'] * 100:6.2f}  "
                      f"on+off {res['on+off'] * 100:6.2f}  vel {res['on+off+vel'] * 100:6.2f}  "
                      f"pedoff {res['pedoff'] * 100:6.2f}  ped {res['ped_on'] * 100:6.2f}  "
                      f"({res['seconds']:.1f}s)", flush=True)

    cols = ["onset", "onset_p", "onset_r", "on+off", "on+off+vel", "pedoff", "ped_on", "seconds"]
    print("\nMEAN over pieces (F1 %, time in s per 2-min piece)")
    print(f"{'set':8s} {'config':16s} " + " ".join(f"{c:>10s}" for c in cols))
    summary = {}
    for (set_name, cfg), rows in table.items():
        means = {c: float(np.mean([r.get(c, np.nan) for r in rows])) for c in cols}
        summary[f"{set_name}/{cfg}"] = means
        print(f"{set_name:8s} {cfg:16s} " + " ".join(
            f"{means[c] * (1 if c == 'seconds' else 100):10.2f}" for c in cols))
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
