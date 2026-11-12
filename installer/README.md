# Keytrace installer

A small online installer: `Keytrace-Setup-<version>.exe` (about 31 MB) copies the app files. Then a native setup window ("Setting up Keytrace") downloads Python, PyTorch and the packages (about 3 GB) with the bundled `uv`.

## Build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
```

Output: `installer\dist\Keytrace-Setup-<version>.exe`. The version comes from `midiconv/__init__.py`.

Needs: the dev venv (`.venv`, used for `scripts/fetch_piano_samples.py` and, when the icon must be remade, `make_icon.py`, which needs Pillow and Microsoft Edge), Inno Setup 6.7+ (`%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`) and the .NET Framework C# compiler (`csc.exe`, part of Windows). Override the paths with `-Python`, `-Iscc`, `-Csc` and `-Edge`.

The script:

1. Downloads uv 0.13.7 once into `installer\build\cache` and checks its SHA-256.
2. Fetches the piano samples.
3. Makes the icon, `installer\assets\Keytrace.ico`, when it is missing or older than one of the master SVGs or `make_icon.py`.
4. Stages the files in `installer\build\stage`.
5. Compiles the launcher.
6. Runs ISCC.

It stops on the first error.

## Files

| Path | What |
|---|---|
| `build.ps1` | build script (Windows PowerShell 5.1) |
| `Keytrace.iss` | Inno Setup script |
| `launcher\*.cs`, `launcher\app.manifest` | `Keytrace.exe`: launcher and setup window (C# 5, .NET Framework 4.x, WinForms) |
| `make_icon.py`, `assets\Keytrace.ico` | the Keytrace mark as an icon (16 to 256 px), rendered from the master SVGs (see below) |

### The mark

The masters are `web\brand\keytrace-mark.svg` (64-unit art, for sizes above 24 px) and `web\brand\keytrace-mark-small.svg` (16-unit art hand-tuned for 16 to 24 px). Everything else derives from them:

- the web's favicon is `brand/keytrace-mark-small.svg` itself, and its header (28 px) an inline copy of `keytrace-mark.svg` in `web\index.html`;
- the desktop app's loading and error pages inline `keytrace-mark.svg`, read at run time (`midiconv\desktop.py`);
- `make_icon.py` renders each size of `Keytrace.ico` with headless Edge, at exactly that size on a transparent background: the small art for 16, 20 and 24 px, the full art for 32, 40, 48, 64, 96, 128 and 256 px. It writes one frame per size (32-bit BMP up to 96 px, PNG for 128 and 256 px) and reads the file back with Pillow to check every size and its alpha. `python installer\make_icon.py [out.ico] [--png sheet.png] [--frames DIR]` also writes previews;
- the setup window draws the frame of `Keytrace.ico` that fits its logo (see below).

## Installed layout

```
{app}\Keytrace.exe              launcher + setup window
{app}\tools\uv.exe              uv 0.13.7
{app}\assets\Keytrace.ico
{app}\app\                      midiconv, web, scripts, requirements-runtime.txt
{app}\python\                   uv-managed CPython 3.13           (created by the setup window)
{app}\runtime\                  the app's venv; midiconv-ready.txt marks a finished setup
{app}\setup.log                 setup log (appended, restarted past 5 MB)
{app}\setup-options.txt         with-aria=0/1 for a later repair (written by the installer and by each setup)
```

`{app}` is `%LOCALAPPDATA%\Programs\Keytrace` by default (per user). The "all users" option installs it in Program Files. User data stays in `%LOCALAPPDATA%\Keytrace`: the uninstaller asks before deleting it, and never deletes it when silent.

A first install needs a new or empty folder, or a previous Keytrace install, because the setup creates and the uninstaller deletes folders with generic names in it. If the chosen folder has other files, the wizard switches to `<folder>\Keytrace` and asks you to click Next again. A silent install stops with exit code 7.

Identifiers: the app window holds the mutex `Keytrace.SingleInstance` (the installer's `AppMutex`), and the window and the shortcuts share the AppUserModelID `Keytrace.Desktop`. The Explorer verb is the registry key `Software\Classes\SystemFileAssociations\<audio|video>\shell\Keytrace`, labelled "Convert to MIDI with Keytrace".

### Upgrading from MIDI Converter 0.1.0

Keytrace was called "MIDI Converter" up to 0.1.0. The Inno `AppId` is unchanged, so the setup upgrades such an install in place, in its folder (by default `%LOCALAPPDATA%\Programs\MIDI Converter`). It deletes the old launcher (`MIDI Converter.exe`), `assets\MIDIConverter.ico`, the "MIDI Converter" Start menu and desktop shortcuts and the old Explorer verb (`shell\MIDIConverter`), and also waits for a running MIDI Converter 0.1.0 (mutex `MIDIConverter.SingleInstance`). The app moves the old user data folder (`%LOCALAPPDATA%\MIDI Converter`) to `%LOCALAPPDATA%\Keytrace` the first time it starts; the uninstaller offers to delete both folders.

## Launcher

- `Keytrace.exe [files...]`: if `runtime\Scripts\pythonw.exe` and the ready marker exist, starts `pythonw -m midiconv [files...]`. It runs in `{app}\app` with `PYTHONNOUSERSITE=1` and `PYTHONUTF8=1`, and with `PYTHON*` variables removed. Relative file paths are made absolute. If the runtime is not ready, it shows the setup window (repair), then starts the app. If `{app}` is not writable (all-users install), it first asks for elevation and runs `--setup --quiet [--with-aria] --elevated-repair` elevated. It keeps holding the setup mutex (`Local\Keytrace.Setup`) while it waits, and the private `--elevated-repair` flag tells the elevated copy not to treat that held mutex as another running setup. If the elevated setup fails, a message box points to `setup.log`.
- `Keytrace.exe --setup [--with-aria] [--quiet] [--unattended]` exits with 0 (success), 1 (error) or 2 (cancelled). `--quiet` closes the window by itself on success; `--unattended` (passed by the installer when it runs with `/SILENT` or `/VERYSILENT`) also closes it about 6 s after a failure, unless someone clicks Retry or Show details. The setup window runs:
  1. `uv python install 3.13 --no-bin --no-registry`
  2. `uv venv runtime --python 3.13 --allow-existing --no-project`
  3. `runtime\Scripts\python.exe app\scripts\setup_runtime.py --uv tools\uv.exe [--with-aria]`, which reports with `@@STATUS`, `@@PROGRESS`, `@@DONE` and `@@ERROR`. Without `--with-aria`, it uninstalls `aria-amt` and `ariautils` and deletes `app\models\aria-amt` if an earlier setup installed them.

  Every step runs in a Windows job object, so Cancel (or the launcher being killed) stops uv and pip too. The ready marker is deleted when a setup starts, so an interrupted setup or upgrade is repaired at the next start. Unless `MIDICONV_UV_CACHE` is set, the uv cache is `{app}\.uv-cache` and is removed at the end.

  uv builds `proxy-tools` (a pywebview dependency published only as source) inside its cache, about 150 characters below the cache folder. Without Windows long path support the build fails once the cache path is longer than about 109 characters. So when `{app}\.uv-cache` is longer than 90 characters (an install folder deeper than about 80 characters), the launcher uses `%TEMP%\Keytrace-uv-cache` instead. It passes that folder to `setup_runtime.py` as `MIDICONV_UV_CACHE` and removes it at the end. A `MIDICONV_UV_CACHE` you set yourself is used as is, so keep it short.

The setup window's header shows the Keytrace mark, a frame of `{app}\assets\Keytrace.ico` (else of the copy embedded in `Keytrace.exe`): the 48 px frame at 100%, the 96 px frame at 200%, and at other scales a larger frame scaled down. Then the headline with the wordmark: "Keytrace" in Sitka Display Semibold, "Key" in ink (#1B2523) and "trace" in teal (#2C7567). Windows 10's Sitka has no semibold, so it falls back to Sitka Display Bold, then Georgia Bold.

To look at the setup window without downloading anything, put `Keytrace.exe` (from `installer\build\launcher`) in an empty folder with an `app\scripts\setup_runtime.py` (any content) and a stand-in `tools\uv.exe`: it exits with 0 for `python install`, copies itself to `<dir>\Scripts\python.exe` for `venv <dir>`, and otherwise (as the runtime's python) prints `@@STATUS` and `@@PROGRESS` lines, then waits, or writes `runtime\midiconv-ready.txt` and prints `@@DONE`, or prints `@@ERROR`. Then run `Keytrace.exe --setup` there.

## Installer switches

The standard Inno switches work (`/SILENT`, `/VERYSILENT`, `/DIR=`, `/COMPONENTS="main,aria"`, `/MERGETASKS="!desktopicon"`, `/LOG=`), plus:

- `/SKIPRUNTIME`: copy the files only. The download happens the first time Keytrace is opened. It uses the components chosen here.

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
