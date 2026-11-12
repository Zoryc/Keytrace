"""Instrument-independent output options applied after transcription."""
from __future__ import annotations

import copy

from .engines.base import Option
from .model import SOFT, SUSTAIN, Note, Pedal, Transcription

MIN_NOTE_SECONDS = 0.005  # below this a note cannot be written reliably (note-off before note-on)

OUTPUT_OPTIONS = [
    Option("pedal", "Sustain pedal", "choice", "cc",
           "Keep the pedal as MIDI sustain events (most faithful), bake it into note lengths "
           "(for apps that ignore the pedal), or leave it out.",
           choices=[("cc", "Pedal events (CC64)"), ("extend", "Bake into note lengths"),
                    ("none", "Leave out")]),
    Option("soft_pedal", "Soft pedal (CC67)", "bool", True, "Include una corda pedal events."),
    Option("velocity", "Dynamics", "choice", "played",
           "Keep each note's transcribed loudness, or make every note the same loudness.",
           choices=[("played", "As played"), ("flat", "Flat")]),
    Option("flat_velocity", "Flat velocity", "number", 80, "Velocity used when Dynamics is Flat.",
           min=1, max=127, step=1),
    Option("min_note_ms", "Minimum note length", "number", 0,
           "Drop notes shorter than this (0 keeps everything).", min=0, max=200, step=5, unit="ms"),
    Option("tempo", "MIDI tempo", "number", 120,
           "Tempo written in the file. Notes keep their real timing; this only changes how bars "
           "line up in a DAW or notation app.", min=20, max=300, step=1, unit="BPM"),
]


def pedal_extended_ends(notes: list[Note], pedals: list[Pedal]) -> list[float]:
    """Sounding end of each note when the sustain pedal holds it (cut at the next same-pitch onset)."""
    sustain = sorted((p.start, p.end) for p in pedals if p.cc == SUSTAIN)
    ends = []
    import bisect

    starts = [s for s, _ in sustain]
    for n in notes:
        end = n.end
        k = bisect.bisect_right(starts, n.end) - 1
        if k >= 0 and sustain[k][0] <= n.end < sustain[k][1]:
            end = sustain[k][1]
        ends.append(end)
    # A re-struck key stops the previous sounding note.
    last_by_pitch: dict[int, int] = {}
    for i, n in sorted(enumerate(notes), key=lambda t: t[1].start):
        j = last_by_pitch.get(n.pitch)
        if j is not None and ends[j] > n.start:
            ends[j] = max(notes[j].start + MIN_NOTE_SECONDS, n.start)
        last_by_pitch[n.pitch] = i
    return ends


def apply_output_options(tr: Transcription, opts: dict) -> Transcription:
    tr = copy.deepcopy(tr)
    min_len = max(MIN_NOTE_SECONDS, float(opts.get("min_note_ms", 0)) / 1000.0)
    for track in tr.tracks:
        notes = track.notes
        if opts.get("pedal") == "extend":
            ends = pedal_extended_ends(notes, track.pedals)
            for n, e in zip(notes, ends):
                n.end = e
        if opts.get("pedal") in ("extend", "none"):
            track.pedals = [p for p in track.pedals if p.cc != SUSTAIN]
        if not opts.get("soft_pedal", True):
            track.pedals = [p for p in track.pedals if p.cc != SOFT]
        if opts.get("velocity") == "flat":
            v = int(opts.get("flat_velocity", 80))
            for n in notes:
                n.velocity = v
        if opts.get("min_note_ms", 0):
            notes = [n for n in notes if n.end - n.start >= float(opts["min_note_ms"]) / 1000.0]
        track.notes = _clean(notes, min_len)
        track.pedals = [p for p in track.pedals if p.end > p.start]
    return tr


def _clean(notes: list[Note], min_len: float) -> list[Note]:
    """Same-pitch notes must not overlap, every note needs a positive length, velocity in 1..127."""
    notes = sorted(notes, key=lambda n: (n.start, n.pitch))
    last: dict[int, Note] = {}
    out = []
    for n in notes:
        n.velocity = int(max(1, min(127, n.velocity)))
        p = last.get(n.pitch)
        if p is not None and p.end > n.start:
            p.end = n.start
        out.append(n)
        last[n.pitch] = n
    for n in out:
        if n.end - n.start < min_len:
            n.end = n.start + min_len
    # Re-check overlaps that the minimum-length stretch may have created.
    last = {}
    final = []
    for n in out:
        p = last.get(n.pitch)
        if p is not None and p.end > n.start:
            if n.start - p.start < min_len:  # duplicate onset: keep the louder one
                if n.velocity > p.velocity:
                    p.velocity = n.velocity
                p.end = max(p.end, n.end)
                continue
            p.end = n.start
        final.append(n)
        last[n.pitch] = n
    return final
