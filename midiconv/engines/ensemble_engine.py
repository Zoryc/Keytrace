"""Ensemble piano engine: Transkun V2 (primary) + Aria-AMT (second opinion).

Transkun's output is kept as is. A note that only Aria hears is added when Transkun's own exact
onset posterior at that key and time is at least `threshold`, i.e. Aria only breaks ties where
Transkun itself was unsure. Added notes get Transkun's most likely key release for that onset.

Measured on 12 MAESTRO test excerpts (bench/fusion.py chose the threshold by leave-one-piece-out
cross-validation; bench/evaluate.py --configs ensemble): note-onset F1 98.38 -> 98.61 (clean),
98.37 -> 98.59 (MP3), 98.36 -> 98.60 (reverb), 97.74 -> 98.11 (noise), 97.37 -> 97.79 (phone),
96.00 -> 96.62 (worst case); better on 7-9 of 12 pieces in every condition, worse on at most one.
Note ends and pedal-sustained lengths improve too; velocity is unchanged. Simple union,
intersection or confidence-veto rules did not help.
"""
from __future__ import annotations

from ..audio import Audio
from ..fusion import fuse_notes
from ..model import Track, Transcription
from .base import Engine, Option, Progress, coerce_options


class EnsembleEngine(Engine):
    id = "ensemble"
    name = "Ensemble (Transkun + Aria)"
    instrument = "piano"
    summary = ("Most accurate: Transkun V2 transcribes, and Aria-AMT recovers notes Transkun was unsure "
               "about. Takes about three times as long as Transkun alone.")

    def __init__(self, transkun: Engine, aria: Engine):
        self.transkun, self.aria = transkun, aria
        views = next(o for o in transkun.options if o.key == "views")
        self.options = [
            views,
            Option("rescue", "Second opinion", "choice", "0.3",
                   "How unsure Transkun must have been before a note heard only by Aria is added. "
                   "Lower adds more notes.",
                   choices=[("0.1", "Generous"), ("0.3", "Balanced (measured best)"), ("0.5", "Cautious")]),
        ]

    def _load(self):  # warm-up hook used by the job queue
        for eng in (self.transkun, self.aria):
            if hasattr(eng, "_load"):
                eng._load()

    def availability(self):
        for eng in (self.transkun, self.aria):
            ok, why = eng.availability()
            if not ok:
                return False, why
        return True, ""

    def transcribe(self, audio: Audio, opts: dict, progress: Progress) -> Transcription:
        t_opts = coerce_options(self.transkun.options, {"views": opts.get("views")})
        a = self.transkun.transcribe(audio, t_opts, progress.sub(0.0, 0.35))
        progress(0.35, "Getting a second opinion from Aria-AMT")
        b = self.aria.transcribe(audio, {}, progress.sub(0.35, 0.97))
        aux = a.aux
        ta, tb = a.tracks[0], b.tracks[0]
        threshold = float(opts.get("rescue", 0.3))
        notes = fuse_notes(ta.notes, tb.notes, rule="post_rescue", threshold=threshold,
                           posterior=aux.get("onset_posterior"), durations=aux.get("onset_duration_frames"),
                           frame_seconds=aux.get("frame_seconds", 1024 / 44100),
                           frame_offset=aux.get("frame_offset", 0.0))
        added = len(notes) - len(ta.notes)
        progress(1.0, "Finishing")
        info = {**a.info, "aria_notes": len(tb.notes), "notes_added_by_aria": added, "rescue": threshold}
        return Transcription([Track("Piano", 0, False, notes, ta.pedals)], audio.duration, self.id, info)
