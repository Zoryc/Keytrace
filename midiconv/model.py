"""Instrument-agnostic transcription data model shared by every engine."""
from __future__ import annotations

from dataclasses import dataclass, field

SUSTAIN, SOSTENUTO, SOFT = 64, 66, 67


@dataclass
class Note:
    start: float  # seconds
    end: float  # seconds (key release; pedal sustain is carried separately)
    pitch: int  # MIDI note number
    velocity: int  # 1..127
    confidence: float = 1.0  # 0..1, e.g. engine agreement in ensemble mode


@dataclass
class Pedal:
    start: float
    end: float
    cc: int  # MIDI controller: 64 sustain, 66 sostenuto, 67 soft
    value: int = 127


@dataclass
class Track:
    name: str
    program: int = 0  # General MIDI program (0 = Acoustic Grand Piano)
    is_drum: bool = False
    notes: list[Note] = field(default_factory=list)
    pedals: list[Pedal] = field(default_factory=list)


@dataclass
class Transcription:
    tracks: list[Track]
    duration: float
    engine: str
    info: dict = field(default_factory=dict)  # small, JSON-able; shown in stats
    aux: dict = field(default_factory=dict, repr=False)  # large engine internals (never saved), e.g. for fusion

    @property
    def note_count(self) -> int:
        return sum(len(t.notes) for t in self.tracks)
