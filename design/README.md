# Design directions

These studies were made when Keytrace was still called MIDI Converter, so the prototypes show that
name and an instrument picker. Direction 01, Essential, became the app's design.

Twelve clickable, high-fidelity prototypes of the app's interface, built from the same real
transcription (Schubert, Impromptu Op. 90 No. 4, first 60 s, Ensemble engine) so they compare fairly.
They are design studies: no backend, nothing here is used by the app.

Open the gallery to compare them in every state:

- in Claude Code: the `design-gallery` preview (`.claude/launch.json`), or
- any browser: `python -m http.server 8798 --directory design`, then http://localhost:8798

Each prototype also opens on its own (`variants/<name>/index.html`) and accepts
`?state=home|progress|result|advanced` (add `&clean=1` to hide the reviewer's state switcher).

| # | Direction | Idea |
|---|---|---|
| 01 | Essential | The easiest possible: one huge drop target, one big Save button, three plain choices |
| 02 | Modern | The current app, refined |
| 03 | Engineer Console | Everything visible: confidence-coloured roll, histograms, note table, logs, CLI preview |
| 04 | Pro Dashboard | Between modern and technical: stat cards, charts, always-visible options |
| 05 | Studio | DAW-style transport, waveform and MIDI lanes, pedal automation, inspector |
| 06 | Hardware Rack | Studio gear: VFD display, knobs, switches, backlit buttons |
| 07 | Sheet & Ink | Paper and serif; the result as a graphic score with dynamics and pedal marks |
| 08 | Playful | Friendly consumer app |
| 09 | Brutalist | Huge condensed type, hard grid, one accent |
| 10 | Glass | Translucent panels over an ambient gradient |
| 11 | Guided | Step-by-step wizard for beginners |
| 12 | Library | Many files: library table, queue, thumbnails, batch actions |

`shared/mock-data.js` holds the real data, `shared/roll.js` a no-module copy of the app's piano roll.
