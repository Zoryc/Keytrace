"""Engine and option interfaces. One engine = one transcription model for one instrument."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable

from ..audio import Audio
from ..model import Transcription


class Cancelled(Exception):
    pass


class Progress:
    """Maps a sub-task's 0..1 progress into a slice of the job's overall progress and checks for cancel."""

    def __init__(self, callback: Callable[[float, str | None], None] | None = None,
                 cancel: threading.Event | None = None, lo: float = 0.0, hi: float = 1.0):
        self._cb, self._cancel, self.lo, self.hi = callback, cancel, lo, hi

    def __call__(self, frac: float, message: str | None = None) -> None:
        self.check()
        if self._cb:
            self._cb(self.lo + max(0.0, min(1.0, frac)) * (self.hi - self.lo), message)

    def check(self) -> None:
        if self._cancel is not None and self._cancel.is_set():
            raise Cancelled()

    def sub(self, a: float, b: float) -> "Progress":
        span = self.hi - self.lo
        return Progress(self._cb, self._cancel, self.lo + a * span, self.lo + b * span)


@dataclass
class Option:
    key: str
    label: str
    kind: str  # "choice" | "bool" | "number"
    default: Any
    help: str = ""
    choices: list[tuple[str, str]] | None = None  # (value, label)
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str = ""

    def to_json(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if v is not None}
        if self.choices is not None:
            d["choices"] = [{"value": v, "label": l} for v, l in self.choices]
        return d

    def coerce(self, value: Any) -> Any:
        if value is None:
            return self.default
        if self.kind == "bool":
            if isinstance(value, str):
                return value.strip().lower() in ("1", "true", "yes", "on")
            return bool(value)
        if self.kind == "number":
            v = float(value)
            if self.min is not None:
                v = max(self.min, v)
            if self.max is not None:
                v = min(self.max, v)
            return int(v) if isinstance(self.default, int) and float(v).is_integer() else v
        if self.kind == "choice":
            allowed = [c[0] for c in self.choices or []]
            return value if value in allowed else self.default
        return value


def coerce_options(specs: list[Option], raw: dict | None) -> dict:
    raw = raw or {}
    return {o.key: o.coerce(raw.get(o.key)) for o in specs}


class Engine:
    id: str = ""
    name: str = ""
    instrument: str = ""
    summary: str = ""
    options: list[Option] = []

    def availability(self) -> tuple[bool, str]:
        """(ready, reason). Engines whose weights or packages are missing report why."""
        return True, ""

    def transcribe(self, audio: Audio, opts: dict, progress: Progress) -> Transcription:
        raise NotImplementedError

    def unload(self) -> None:
        pass

    def to_json(self) -> dict:
        ok, why = self.availability()
        return {"id": self.id, "name": self.name, "summary": self.summary, "available": ok,
                "unavailable_reason": why, "options": [o.to_json() for o in self.options]}
