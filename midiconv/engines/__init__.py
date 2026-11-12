"""Instrument / engine registry.

To add an instrument: write an Engine subclass (see base.py) and register it below with an
Instrument entry. The web UI builds its instrument picker and advanced options from this registry.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .base import Cancelled, Engine, Option, Progress, coerce_options  # noqa: F401


@dataclass
class Instrument:
    id: str
    name: str
    description: str
    default_engine: str
    engines: dict[str, Engine] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description,
                "default_engine": self.default_engine,
                "engines": [e.to_json() for e in self.engines.values()]}


_INSTRUMENTS: dict[str, Instrument] = {}


def register(instrument: Instrument, *engines: Engine) -> None:
    inst = _INSTRUMENTS.setdefault(instrument.id, instrument)
    for e in engines:
        assert e.instrument == inst.id, (e.id, inst.id)
        inst.engines[e.id] = e


def instruments() -> list[Instrument]:
    return list(_INSTRUMENTS.values())


def get_instrument(instrument_id: str) -> Instrument:
    try:
        return _INSTRUMENTS[instrument_id]
    except KeyError:
        raise KeyError(f"Unknown instrument '{instrument_id}'.") from None


def get_engine(instrument_id: str, engine_id: str | None = None) -> Engine:
    inst = get_instrument(instrument_id)
    engine_id = engine_id or inst.default_engine
    if engine_id not in inst.engines:
        raise KeyError(f"Unknown engine '{engine_id}' for {inst.name}.")
    return inst.engines[engine_id]


def _register_builtin() -> None:
    import logging

    from .transkun_engine import TranskunEngine

    transkun = TranskunEngine()
    aria = None
    try:  # optional second piano engine; a broken aria-amt install only hides it
        from .aria_engine import AriaEngine

        aria = AriaEngine()
        if not aria.availability()[0]:
            aria = None
    except Exception as e:  # pragma: no cover
        logging.getLogger(__name__).info("Aria-AMT engine not available: %s", e)

    piano = Instrument("piano", "Piano", "Solo piano recordings.", default_engine="transkun")
    if aria is not None:
        from .ensemble_engine import EnsembleEngine

        piano.default_engine = "ensemble"  # measured more accurate than either engine alone (bench/fusion.py)
        register(piano, EnsembleEngine(transkun, aria), transkun, aria)
    else:
        register(piano, transkun)


_register_builtin()
