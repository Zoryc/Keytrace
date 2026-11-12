# MIDI Converter

> "MIDI Converter" is a working name.

A Windows desktop app that turns **solo piano recordings into MIDI files**, as accurately as current research allows. It runs locally on your NVIDIA graphics card.

- **Drop a file and get a MIDI.** It reads MP3, WAV, FLAC, M4A/AAC, OGG/Opus, WMA and AIFF, plus the audio track of video files (MP4, MKV, MOV, WebM). You can also right-click a file in Explorer and choose **Convert to MIDI**.
- **State-of-the-art piano transcription.** It writes the notes, how hard each key was struck (velocity), the sustain pedal and the soft pedal.
- **Check before you save.** The result appears as a piano roll and plays on a sampled grand piano. An Original / Both / MIDI switch lets you compare it with the recording.
- **Advanced options** are in their own panel:
  - engine settings;
  - how the pedal is written;
  - played or flat dynamics;
  - minimum note length;
  - MIDI tempo.

  MIDI-file options update the open result instantly, without converting again.
- **Ready for more instruments.** Piano is the first one. Engines are plug-ins, and the app builds its instrument list and options from them.

## Install

Run `MIDI-Converter-Setup-<version>.exe` (about 31 MB). It installs for your user only, so it needs no administrator rights.

Setup then opens a progress window and downloads what the app needs: Python, the GPU version of PyTorch and the transcription models.

| Component | Download | Notes |
|---|---|---|
| MIDI Converter (required) | about 2.8 GB | Python 3.13, PyTorch with CUDA 12.8, Transkun V2 |
| Ensemble mode with Aria-AMT (on by default) | about 450 MB | the most accurate setting; its model weights are licensed for non-commercial use |

**Requirements:**
- Windows 10 or 11, 64-bit.
- An NVIDIA GPU. An RTX card is recommended; without one the app falls back to the CPU and is very slow.
- About 8 GB of free disk space.
- An internet connection during setup.

If the download is interrupted, **MIDI Converter.exe** finishes it the next time you open the app.

The installer is not code-signed, so the first time Windows SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway**.

Uninstall from Windows Settings → Apps. The uninstaller asks whether to keep your conversion history, which is stored in `%LOCALAPPDATA%\MIDI Converter`.

## Use

1. Open **MIDI Converter** from the Start menu.
2. Drop a recording on the window, or click **choose a file**. Conversion starts right away. A 2-minute piece takes about half a minute with the default Ensemble engine on an RTX 5070 Ti.
3. Check the result:
   - Press Space to play.
   - Switch between **Original**, **Both** and **MIDI**.
   - Hover a note to see its pitch, velocity and length, and how sure the model is. Notes the model is less sure about are drawn dashed.
4. Click **Save MIDI**.

Recent conversions are listed under the drop area. Click one to open it again.

### Advanced options

| Option | What it does |
|---|---|
| Engine | **Ensemble (Transkun + Aria)**: the most accurate and the default. **Transkun V2**: about 4× faster and almost as accurate. **Aria-AMT**: alone, for comparison. |
| Analysis views | Each 16-second window is analysed as stereo, left, right and mid, and the results are averaged. This is the default because it measured best. |
| Second opinion | How unsure Transkun must be before a note that only Aria heard is added. |
| Sustain pedal | Pedal events (CC64), baked into note lengths, or left out. |
| Soft pedal | Include una corda events (CC67). |
| Dynamics | As played, or one flat velocity. |
| Minimum note length | Drop very short notes. |
| MIDI tempo | Changes only how bars line up in a DAW or notation app. Notes keep their real timing. |

## Accuracy

Measured with `bench/` on **12 excerpts of 2 minutes each from the MAESTRO v3 test split**, which none of the models trained on, with the standard transcription metrics (mir_eval).

The same excerpts were also degraded to imitate real-world recordings:
- a 128 kbps MP3;
- a phone recording;
- a concert hall's reverb;
- noise at 15 dB;
- a worst case combining hall, noise, phone and a 64 kbps MP3.

Note-onset F1 (%), where a note counts when its pitch is right and its start is within 50 ms:

| Engine | Clean | MP3 | Phone | Reverb | Noise | Worst case |
|---|---|---|---|---|---|---|
| Transkun V2, paper settings | 98.36 | 98.30 | 97.14 | 98.30 | 97.69 | 96.14 |
| Transkun V2, stereo views (this app) | 98.38 | 98.37 | 97.37 | 98.36 | 97.74 | 96.00 |
| Aria-AMT alone | 97.54 | 97.56 | 95.82 | 97.62 | 96.70 | 89.96 |
| **Ensemble (this app's default)** | **98.60** | **98.58** | **97.78** | **98.59** | **98.10** | **96.58** |

- **Ensemble:** it also improves note ends (by +0.17 to +0.28 points) and sounding lengths with the pedal (by +0.28 to +0.68 points). Velocity is unchanged. Note detection is better on 9–10 of the 12 pieces in every condition.
- **Stereo views:** compared with the paper settings, they improve note-end accuracy on 11 of 12 pieces. On noisy audio they also improve sustain-pedal accuracy by up to 6.6 points.
- **Where to find the details:** the full tables and the method are in `bench/`. Every rule and threshold was chosen by leave-one-piece-out cross-validation.

### How it works

1. **Decode.** PyAV, which bundles FFmpeg, reads the file at its native sample rate.
2. **Transkun V2** ([Yan & Duan, ISMIR 2024](https://github.com/Yujia-Yan/Transkun)) is the primary model. A transformer scores every possible note interval, and a semi-Markov CRF picks the best set exactly. On top of the original, MIDI Converter adds:
   - averaging over four stereo views;
   - a fix for an upstream bug that cut long pedal presses where analysis windows meet;
   - full 32-bit precision and the highest-quality resampling;
   - an exact per-note confidence taken from the CRF's posterior.
3. **Aria-AMT** ([EleutherAI](https://github.com/EleutherAI/aria-amt)) gives a second opinion. A note only Aria heard is added when Transkun's own probability of a note starting there is at least 0.3, so Aria only breaks ties where Transkun was unsure. Each added note gets Transkun's own estimate of when the key was released.
4. **Write.** Key releases stay key releases, and the pedal is written as CC64/CC67 events.

## Limitations

- **Solo piano only.** With other instruments, their notes can be written as piano notes and piano notes under them can be missed. Published results show about 85 % instead of 98 % with an orchestra.
- **Pedals:** sustain and soft pedal are on/off; half-pedalling and the sostenuto pedal are not detected.
- **Highest notes:** notes near the top of the keyboard (around C8) are sometimes missed, because the model listens up to 8 kHz.
- **Speed:** a GPU is strongly recommended.
- **Licenses:** the models are trained on MAESTRO (CC BY-NC-SA 4.0) and the Aria-AMT weights are non-commercial. Treat transcriptions as fine for personal use, not commercial.

## Development

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
```

```bash
.venv\Scripts\python -m pip install -r requirements.txt
```

```bash
.venv\Scripts\python -m pip install --no-deps transkun==2.0.1 moduleconf==0.1.4
```

```bash
.venv\Scripts\python scripts\fetch_piano_samples.py
```

Run the app, or convert a file from the command line:

```bash
.venv\Scripts\python -m midiconv
```

```bash
.venv\Scripts\python -m midiconv convert "recording.mp3" -o "recording.mid" --engine transkun
```

Benchmark: `bench\fetch_maestro.py` downloads about 230 MB of MAESTRO excerpts, `bench\degrade.py` makes the degraded copies, `bench\evaluate.py --list` shows the configurations, and `bench\fusion.py` runs the ensemble analysis.

To build the installer, see [installer/README.md](installer/README.md):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
```

### Layout

| Path | What |
|---|---|
| `midiconv/engines/` | engines (`transkun_engine.py`, `aria_engine.py`, `ensemble_engine.py`) and the instrument registry |
| `midiconv/desktop.py` | the app window (pywebview / WebView2), single instance, file hand-off |
| `midiconv/server.py`, `jobs.py`, `pipeline.py` | local backend for the window: job queue, conversion pipeline |
| `web/` | the interface (HTML/CSS/JS, no build step) |
| `bench/` | accuracy benchmark and fusion analysis |
| `installer/` | Inno Setup script, C# launcher and setup window, build script |
| `scripts/` | runtime setup, weights and sample downloads |

### Adding an instrument

1. Subclass `midiconv.engines.base.Engine`.
2. Implement `transcribe(audio, options, progress)` so it returns a `Transcription` (tracks of notes and pedals).
3. Register the engine in `midiconv/engines/__init__.py` with an `Instrument` entry.

The instrument picker and the engine's Advanced options come from that registry.

## Credits and licenses

- [Transkun](https://github.com/Yujia-Yan/Transkun) by Yujia Yan: code MIT; weights trained on MAESTRO.
- [Aria-AMT](https://github.com/EleutherAI/aria-amt) by EleutherAI: code Apache-2.0; weights CC BY-NC-SA 4.0.
- [MAESTRO](https://magenta.tensorflow.org/datasets/maestro) (Hawthorne et al., 2019), CC BY-NC-SA 4.0. Used for training by the models, and for benchmarking here.
- [smplr](https://github.com/danigb/smplr), MIT, plays the previews with the Splendid Grand Piano samples (public domain, by Akai).
- [pywebview](https://pywebview.flowrl.com/), [PyAV](https://github.com/PyAV-Org/PyAV) / FFmpeg, soxr, pretty_midi, mir_eval, FastAPI, [uv](https://github.com/astral-sh/uv) and [Inno Setup](https://jrsoftware.org/isinfo.php).
