"""End-to-end conversion: decode -> transcribe -> output options -> MIDI + JSON + preview audio.

Files written to the work directory:
  preview.flac        decoded input, exactly the timeline the engine saw (for A/B playback)
  raw.json            engine output before output options (allows instant re-export)
  transcription.mid   final MIDI
  notes.json          note list for the web piano roll (see midi_io.to_json)
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path

from . import engines
from .audio import load_audio, write_preview
from .engines.base import Progress, coerce_options
from .midi_io import to_json, write_midi
from .model import Note, Pedal, Track, Transcription
from .postprocess import OUTPUT_OPTIONS, apply_output_options

MIDI_FILE, NOTES_FILE, RAW_FILE, PREVIEW_FILE = "transcription.mid", "notes.json", "raw.json", "preview.flac"


def run(src: str | Path, workdir: str | Path, *, instrument: str = "piano", engine: str | None = None,
        engine_options: dict | None = None, output_options: dict | None = None,
        progress: Progress | None = None, preview: bool = True) -> dict:
    """Convert one file. Returns stats; raises AudioError / Cancelled / RuntimeError."""
    progress = progress or Progress()
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    eng = engines.get_engine(instrument, engine)
    ok, why = eng.availability()
    if not ok:
        raise RuntimeError(why)
    e_opts = coerce_options(eng.options, engine_options)
    o_opts = coerce_options(OUTPUT_OPTIONS, output_options)

    t0 = time.perf_counter()
    progress(0.0, "Reading the audio")
    audio = load_audio(src)
    if preview:
        progress(0.02, "Preparing the preview")
        write_preview(audio, workdir / PREVIEW_FILE)
    t_decode = time.perf_counter() - t0

    raw = eng.transcribe(audio, e_opts, progress.sub(0.04, 0.98))
    save_raw(raw, workdir / RAW_FILE)
    progress(0.99, "Writing the MIDI file")
    stats = {
        "duration": round(audio.duration, 2), "sample_rate": audio.sr, "channels": audio.channels,
        "engine": eng.id, "engine_name": eng.name, "engine_options": e_opts,
        "seconds_decode": round(t_decode, 2), "info": raw.info,
    }
    stats = export(raw, o_opts, workdir, stats)
    stats["seconds_total"] = round(time.perf_counter() - t0, 2)
    _rewrite_stats(workdir, stats)
    progress(1.0, "Done")
    return stats


def export(raw: Transcription, output_options: dict | None, workdir: str | Path, stats: dict | None = None) -> dict:
    """Apply output options to a raw transcription and (re)write the MIDI and notes.json."""
    workdir = Path(workdir)
    o_opts = coerce_options(OUTPUT_OPTIONS, output_options)
    final = apply_output_options(raw, o_opts)
    write_midi(final, workdir / MIDI_FILE, tempo=o_opts["tempo"])
    stats = {**(stats or {}), "notes": final.note_count,
             "pedals": sum(len(t.pedals) for t in final.tracks), "output_options": o_opts}
    payload = to_json(final)
    payload["stats"] = stats
    (workdir / NOTES_FILE).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return stats


def _rewrite_stats(workdir: Path, stats: dict) -> None:
    p = workdir / NOTES_FILE
    payload = json.loads(p.read_text(encoding="utf-8"))
    payload["stats"] = stats
    p.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def save_raw(tr: Transcription, path: Path) -> None:
    d = {"duration": tr.duration, "engine": tr.engine, "info": tr.info,
         "tracks": [{"name": t.name, "program": t.program, "is_drum": t.is_drum,
                     "notes": [asdict(n) for n in t.notes], "pedals": [asdict(p) for p in t.pedals]}
                    for t in tr.tracks]}
    Path(path).write_text(json.dumps(d), encoding="utf-8")


def load_raw(path: Path) -> Transcription:
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    tracks = [Track(t["name"], t["program"], t["is_drum"], [Note(**n) for n in t["notes"]],
                    [Pedal(**p) for p in t["pedals"]]) for t in d["tracks"]]
    return Transcription(tracks, d["duration"], d["engine"], d.get("info", {}))
