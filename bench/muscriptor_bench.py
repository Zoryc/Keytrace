"""Benchmark MuScriptor (Kyutai + Mirelo, 2026) on the same MAESTRO piano excerpts as bench/evaluate.py.

  python bench/muscriptor_bench.py --size large --sets clean,worst

Needs `pip install --no-deps muscriptor==0.4.0 einops huggingface_hub` and gated weights: accept the
license on huggingface.co/MuScriptor/muscriptor-<size> and run `hf auth login` once.

Fairness notes (see the README's Accuracy section):
  * MuScriptor outputs no velocity and no pedal: compare on onset F1 / precision / recall.
  * Its offsets are score-aligned durations, neither key releases nor pedal-extended.
  * Its training data is undisclosed and likely contains the same compositions, so a MuScriptor
    win on MAESTRO is inconclusive; a loss is informative.
  * Raw transcribe() events are scored (never the beat-gridded MIDI export). The median onset lag
    is reported; a lag-corrected "oracle" score is shown separately, clearly labelled.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import evaluate as ev  # noqa: E402
from midiconv.audio import load_audio  # noqa: E402
from midiconv.fusion import match_notes  # noqa: E402
from midiconv.model import Note  # noqa: E402

REVISIONS = {  # pinned Hugging Face revisions (verified 2026-11-12)
    "small": "8c127f603b807520fa465c838e9bfee8a91ada4e",
    "medium": "f32236969308476e01fd3aae67357de5feb05a2d",
    "large": "8809fdfbed2affa7ade94a7059e746e3880720e7",
}


def load_model(size: str):
    import torch
    from muscriptor import TranscriptionModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    # A manual download (model.safetensors + config.json side by side) in models/muscriptor-<size>/ wins.
    local = HERE.parent / "models" / f"muscriptor-{size}" / "model.safetensors"
    if local.is_file():
        if not (local.parent / "config.json").is_file():
            raise SystemExit(f"{local.parent} needs config.json next to model.safetensors")
        return TranscriptionModel.load_model(str(local), device=device)
    from huggingface_hub import hf_hub_download

    repo = f"MuScriptor/muscriptor-{size}"
    weights = hf_hub_download(repo, "model.safetensors", revision=REVISIONS[size])
    hf_hub_download(repo, "config.json", revision=REVISIONS[size])
    return TranscriptionModel.load_model(weights, device=device)


def transcribe(model, audio, prelude: bool, piano_only: bool):
    import torch
    from muscriptor import NoteEndEvent, NoteStartEvent
    from muscriptor.tokenizer.notes import Note as MNote, trim_overlapping_notes, validate_notes

    x = torch.from_numpy(np.ascontiguousarray(audio.samples.T))
    opened, notes = {}, []
    for evt in model.transcribe((x, audio.sr), instruments=["acoustic_piano"] if piano_only else None,
                                prelude_forcing=prelude):
        if isinstance(evt, NoteStartEvent):
            opened[evt.index] = evt
        elif isinstance(evt, NoteEndEvent):
            s = opened.pop(evt.start_event.index, evt.start_event)
            if s.instrument != "drums":
                notes.append(MNote(is_drum=False, program=0, onset=s.start_time, offset=evt.end_time, pitch=s.pitch))
    for s in opened.values():  # started but never ended
        if s.instrument != "drums":
            notes.append(MNote(is_drum=False, program=0, onset=s.start_time, offset=None, pitch=s.pitch))
    notes = trim_overlapping_notes(validate_notes(notes, fix=True), sort=True)
    return [Note(float(n.onset), float(n.offset), int(n.pitch), 100) for n in notes if 21 <= n.pitch <= 108]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="large", choices=list(REVISIONS))
    ap.add_argument("--sets", default="clean")
    ap.add_argument("--no-prelude", action="store_true", help="disable prelude forcing")
    ap.add_argument("--all-instruments", action="store_true", help="do not condition on acoustic piano")
    args = ap.parse_args()
    cfg = f"muscriptor_{args.size}" + ("_noprelude" if args.no_prelude else "") + ("_anyinst" if args.all_instruments else "")
    sets = ["clean", "mp3", "phone", "reverb", "noise", "worst"] if args.sets == "all" else args.sets.split(",")
    manifest = json.loads((ev.DATA / "maestro" / "manifest.json").read_text(encoding="utf-8"))
    ev.RESULTS.mkdir(parents=True, exist_ok=True)

    model = None
    for set_name in sets:
        rows, lags = [], []
        for m in manifest:
            cache = ev.RESULTS / f"{cfg}__{set_name}__{m['id']}.json"
            ref, ref_ped = ev.load_reference(ev.DATA / "maestro" / f"{m['id']}.mid", m["seconds"])
            saved = ev.load_notes(cfg, set_name, m["id"])
            if cache.exists() and saved is not None:
                res, est = json.loads(cache.read_text()), saved[0]
            else:
                if model is None:
                    t0 = time.perf_counter()
                    model = load_model(args.size)
                    print(f"loaded {cfg} in {time.perf_counter() - t0:.0f} s", flush=True)
                audio = load_audio(ev.audio_for_set(set_name, m["id"]))
                t0 = time.perf_counter()
                est = transcribe(model, audio, not args.no_prelude, not args.all_instruments)
                secs = time.perf_counter() - t0
                ev.save_notes(cfg, set_name, m["id"], est, [])
                res = ev.score(ref, ref_ped, est, [], m["seconds"])
                res["seconds"] = secs
                cache.write_text(json.dumps(res))
            pairs = match_notes(ref, est)
            lags += [est[j].start - ref[i].start for i, j in pairs]
            rows.append((m, ref, ref_ped, est, res))
            print(f"{set_name:7s} {cfg} {m['id']}  onset {res['onset'] * 100:6.2f}  P {res['onset_p'] * 100:6.2f}  "
                  f"R {res['onset_r'] * 100:6.2f}  pedoff {res['pedoff'] * 100:6.2f}  ({res['seconds']:.0f}s)", flush=True)
        lag = float(np.median(lags)) if lags else 0.0
        shifted = [ev.score(ref, ref_ped, [Note(n.start - lag, n.end - lag, n.pitch, n.velocity) for n in est], [],
                            m["seconds"]) for m, ref, ref_ped, est, _ in rows]
        mean = lambda rs, k: np.mean([r[k] for r in rs]) * 100  # noqa: E731
        res_only = [r for *_, r in rows]
        print(f"\n[{set_name}] {cfg}: onset F1 {mean(res_only, 'onset'):.2f} (P {mean(res_only, 'onset_p'):.2f}, "
              f"R {mean(res_only, 'onset_r'):.2f}), on+off {mean(res_only, 'on+off'):.2f}, pedoff {mean(res_only, 'pedoff'):.2f}, "
              f"{np.mean([r['seconds'] for r in res_only]):.0f} s per 2-min piece")
        print(f"[{set_name}] median onset lag {lag * 1000:+.1f} ms; ORACLE lag-corrected onset F1 "
              f"{mean(shifted, 'onset'):.2f} (lag measured on the test set itself)\n", flush=True)


if __name__ == "__main__":
    main()
