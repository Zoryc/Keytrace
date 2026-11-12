# MIDI Converter installer

A small online installer: `MIDI-Converter-Setup-<version>.exe` (about 31 MB) copies the app files. Then a native setup window downloads Python, PyTorch and the packages (about 3 GB) with the bundled `uv`.

## Build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
```

Output: `installer\dist\MIDI-Converter-Setup-<version>.exe`. The version comes from `midiconv/__init__.py`.

Needs: the dev venv (`.venv`, used for `scripts/fetch_piano_samples.py` and, if the icon is missing, `make_icon.py`, which needs Pillow), Inno Setup 6.7+ (`%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`) and the .NET Framework C# compiler (`csc.exe`, part of Windows). Override the paths with `-Python`, `-Iscc` and `-Csc`.

The script:

1. Downloads uv 0.13.7 once into `installer\build\cache` and checks its SHA-256.
2. Fetches the piano samples.
3. Makes the icon if `installer\assets\MIDIConverter.ico` is missing.
4. Stages the files in `installer\build\stage`.
5. Compiles the launcher.
6. Runs ISCC.

It stops on the first error.

## Files

| Path | What |
|---|---|
| `build.ps1` | build script (Windows PowerShell 5.1) |
| `MIDIConverter.iss` | Inno Setup script |
| `launcher\*.cs`, `launcher\app.manifest` | `MIDI Converter.exe`: launcher and setup window (C# 5, .NET Framework 4.x, WinForms) |
| `make_icon.py`, `assets\MIDIConverter.ico` | icon (the favicon artwork; 16 to 256 px) |

## Installed layout

```
{app}\MIDI Converter.exe        launcher + setup window
{app}\tools\uv.exe              uv 0.13.7
{app}\assets\MIDIConverter.ico
{app}\app\                      midiconv, web, scripts, requirements-runtime.txt
{app}\python\                   uv-managed CPython 3.13           (created by the setup window)
{app}\runtime\                  the app's venv; midiconv-ready.txt marks a finished setup
{app}\setup.log                 setup log (appended, restarted past 5 MB)
{app}\setup-options.txt         with-aria=0/1 for a later repair (written by the installer and by each setup)
```

`{app}` is `%LOCALAPPDATA%\Programs\MIDI Converter` by default (per user). The "all users" option installs it in Program Files. User data stays in `%LOCALAPPDATA%\MIDI Converter`: the uninstaller asks before deleting it, and never deletes it when silent.

A first install needs a new or empty folder, or a previous MIDI Converter install, because the setup creates and the uninstaller deletes folders with generic names in it. If the chosen folder has other files, the wizard switches to `<folder>\MIDI Converter` and asks you to click Next again. A silent install stops with exit code 7.

## Launcher

- `MIDI Converter.exe [files...]`: if `runtime\Scripts\pythonw.exe` and the ready marker exist, starts `pythonw -m midiconv [files...]`. It runs in `{app}\app` with `PYTHONNOUSERSITE=1` and `PYTHONUTF8=1`, and with `PYTHON*` variables removed. Relative file paths are made absolute. If the runtime is not ready, it shows the setup window (repair), then starts the app. If `{app}` is not writable (all-users install), it first asks for elevation and runs `--setup --quiet [--with-aria] --elevated-repair` elevated. It keeps holding the setup mutex while it waits, and the private `--elevated-repair` flag tells the elevated copy not to treat that held mutex as another running setup. If the elevated setup fails, a message box points to `setup.log`.
- `MIDI Converter.exe --setup [--with-aria] [--quiet] [--unattended]` exits with 0 (success), 1 (error) or 2 (cancelled). `--quiet` closes the window by itself on success; `--unattended` (passed by the installer when it runs with `/SILENT` or `/VERYSILENT`) also closes it about 6 s after a failure, unless someone clicks Retry or Show details. The setup window runs:
  1. `uv python install 3.13 --no-bin --no-registry`
  2. `uv venv runtime --python 3.13 --allow-existing --no-project`
  3. `runtime\Scripts\python.exe app\scripts\setup_runtime.py --uv tools\uv.exe [--with-aria]`, which reports with `@@STATUS`, `@@PROGRESS`, `@@DONE` and `@@ERROR`. Without `--with-aria`, it uninstalls `aria-amt` and `ariautils` and deletes `app\models\aria-amt` if an earlier setup installed them.

  Every step runs in a Windows job object, so Cancel (or the launcher being killed) stops uv and pip too. The ready marker is deleted when a setup starts, so an interrupted setup or upgrade is repaired at the next start. Unless `MIDICONV_UV_CACHE` is set, the uv cache is `{app}\.uv-cache` and is removed at the end.

  uv builds `proxy-tools` (a pywebview dependency published only as source) inside its cache, about 150 characters below the cache folder. Without Windows long path support the build fails once the cache path is longer than about 109 characters. So when `{app}\.uv-cache` is longer than 90 characters (an install folder deeper than about 80 characters), the launcher uses `%TEMP%\MIDIConverter-uv-cache` instead. It passes that folder to `setup_runtime.py` as `MIDICONV_UV_CACHE` and removes it at the end. A `MIDICONV_UV_CACHE` you set yourself is used as is, so keep it short.

## Installer switches

The standard Inno switches work (`/SILENT`, `/VERYSILENT`, `/DIR=`, `/COMPONENTS="main,aria"`, `/MERGETASKS="!desktopicon"`, `/LOG=`), plus:

- `/SKIPRUNTIME`: copy the files only. The download happens the first time MIDI Converter is opened. It uses the components chosen here.

After copying the files, the installer always does the following, with or without `/SKIPRUNTIME`:

- writes `setup-options.txt` from the Aria component;
- deletes `runtime\midiconv-ready.txt`, so the runtime is set up again for the new files and components (by the setup window now, or when the app is next opened);
- if Aria is not selected, deletes `app\models\aria-amt` (the setup then uninstalls its packages);
- if the context-menu task is not selected, deletes its registry keys.

Even with `/VERYSILENT`, the setup window is shown during the download. In a silent install it closes by itself after a failure too (`--unattended`). Otherwise it waits for Retry or Close. The installer itself always finishes: when the download fails, the app finishes it later. A silent install only logs that failure. An interactive install also shows a message box.

## Notes

- `RedirectionGuard=no` in the `.iss`. Inno Setup 6.7 turns on Windows RedirectionGuard by default, and child processes inherit it. uv links `python\cpython-3.13-...` to the patch version with a junction, and the venv's `python.exe` goes through it. Under RedirectionGuard, `uv python install` fails with OS error 448.
- The uninstaller removes `runtime`, `python`, `.uv-cache` and `app\models\aria-amt` with `rd /s /q "\\?\..."`. This removes the junction without following it and handles PyTorch paths longer than 260 characters, which `[UninstallDelete]` leaves behind. It removes each of the first three folders only if it carries the setup's mark. For `runtime`, that is a ready marker or a `pyvenv.cfg` whose `home` is in `{app}\python`. For `python`, it is a `cpython-3.13*` folder, or only uv's own `.lock`, `.gitignore`, `.temp` and `.cache` (what a failed first download leaves). For `.uv-cache`, it is a `CACHEDIR.TAG` file. In `app`, it removes only `midiconv`, `web`, `scripts` and `models\aria-amt`.
- The installer and launcher are not code-signed, so Windows SmartScreen warns on first run.
