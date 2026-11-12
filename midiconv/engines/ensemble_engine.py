"""Ensemble piano engine: Transkun V2 (primary) + Aria-AMT (second opinion).

Transkun's output is kept as is. A note that only Aria hears is added when Transkun's own exact
onset posterior at that key and time is at least `threshold`, i.e. Aria only breaks ties where
Transkun itself was unsure. Added notes get Transkun's most likely key release for that onset.

Measured on 12 MAESTRO test excerpts (bench/fusion.py, threshold picked by leave-one-piece-out
cross-validation): note-onset F1 +0.19 (clean), +0.18 (MP3), +0.21 (reverb), +0.35 (noise),
+0.42 (phone), +0.58 (worst case); better on 9-10 of 12 pieces in every condition. Simple union,
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
               "about. About 3-4x slower than Transkun alone.")

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
