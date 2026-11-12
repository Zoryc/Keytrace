"""End-to-end conversion: decode -> transcribe -> output options -> MIDI + JSON + preview audio."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import engines
from .audio import load_audio, write_preview
from .engines.base import Progress, coerce_options
from .midi_io import to_json, write_midi
from .postprocess import OUTPUT_OPTIONS, apply_output_options


@dataclass
class Result:
    midi: Path
    notes_json: Path
    preview: Path | None
    stats: dict = field(default_factory=dict)


def convert(src: str | Path, out_dir: str | Path, *, instrument: str = "piano", engine: str | None = None,
            engine_options: dict | None = None, output_options: dict | None = None,
            progress: Progress | None = None, midi_name: str = "transcription.mid",
            write_preview_audio: bool = True) -> Result:
    progress = progress or Progress()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    eng = engines.get_engine(instrument, engine)
    ok, why = eng.availability()
    if not ok:
        raise RuntimeError(why)
    e_opts = coerce_options(eng.options, engine_options)
    o_opts = coerce_options(OUTPUT_OPTIONS, output_options)

    t0 = time.perf_counter()
    progress(0.0, "Reading the audio")
    audio = load_audio(src)
    preview = None
    if write_preview_audio:
        progress(0.02, "Preparing the preview")
        preview = out_dir / "preview.flac"
        write_preview(audio, preview)
    t_decode = time.perf_counter() - t0

    raw = eng.transcribe(audio, e_opts, progress.sub(0.05, 0.97))
    t_engine = time.perf_counter() - t0 - t_decode

    progress(0.98, "Writing the MIDI file")
    final = apply_output_options(raw, o_opts)
    midi_path = out_dir / midi_name
    write_midi(final, midi_path, tempo=o_opts["tempo"])
    notes_json = out_dir / "notes.json"
    payload = to_json(final)
    stats = {
        "duration": round(audio.duration, 2),
        "sample_rate": audio.sr,
        "channels": audio.channels,
        "notes": final.note_count,
        "pedals": sum(len(t.pedals) for t in final.tracks),
        "engine": eng.id,
        "engine_name": eng.name,
        "engine_options": e_opts,
        "output_options": o_opts,
        "seconds_decode": round(t_decode, 2),
        "seconds_transcribe": round(t_engine, 2),
        "info": raw.info,
    }
    payload["stats"] = stats
    notes_json.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    progress(1.0, "Done")
    return Result(midi_path, notes_json, preview, stats)
