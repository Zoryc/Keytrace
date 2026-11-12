"""MIDI file writing and the JSON note format consumed by the web front end."""
from __future__ import annotations

from pathlib import Path

from .model import Transcription
from .postprocess import pedal_extended_ends

RESOLUTION = 960  # ticks per beat: 0.52 ms per tick at 120 BPM


def write_midi(tr: Transcription, path: str | Path, tempo: float = 120.0) -> None:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(resolution=RESOLUTION, initial_tempo=float(tempo))
    for t in tr.tracks:
        inst = pretty_midi.Instrument(program=t.program, is_drum=t.is_drum, name=t.name)
        for n in t.notes:
            inst.notes.append(pretty_midi.Note(velocity=int(n.velocity), pitch=int(n.pitch),
                                               start=float(n.start), end=float(n.end)))
        for p in t.pedals:
            inst.control_changes.append(pretty_midi.ControlChange(p.cc, int(p.value), float(p.start)))
            inst.control_changes.append(pretty_midi.ControlChange(p.cc, 0, float(p.end)))
        inst.control_changes.sort(key=lambda c: (c.time, c.value))  # release before re-press at same time
        pm.instruments.append(inst)
    pm.write(str(path))


def to_json(tr: Transcription) -> dict:
    """Compact note list for the piano roll and browser playback.

    notes: [start, end, pitch, velocity, sounding_end, confidence]
    pedals: [start, end, cc, value]"""
    tracks = []
    for t in tr.tracks:
        ends = pedal_extended_ends(t.notes, t.pedals)
        tracks.append({
            "name": t.name, "program": t.program, "is_drum": t.is_drum,
            "notes": [[round(n.start, 4), round(n.end, 4), n.pitch, n.velocity, round(e, 4),
                       round(n.confidence, 3)] for n, e in zip(t.notes, ends)],
            "pedals": [[round(p.start, 4), round(p.end, 4), p.cc, p.value] for p in t.pedals],
        })
    return {"duration": round(tr.duration, 4), "engine": tr.engine, "tracks": tracks}
