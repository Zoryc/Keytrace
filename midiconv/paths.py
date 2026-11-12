"""Where things live. The app folder may be read-only (installed), so user data goes to LocalAppData."""
from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

from . import APP_NAME

APP_DIR = Path(__file__).resolve().parent.parent  # repo root, or {install}\app when installed
WEB_DIR = APP_DIR / "web"
MODELS_DIR = APP_DIR / "models"

LEGACY_DATA_NAME = "MIDI Converter"  # the data folder's name before 0.2.0 (the app's earlier name)

# What the first data_dir() call did with the legacy folder, for the log (set up after that call).
migration_log: list[str] = []
_migration_lock = threading.Lock()
_migration_checked = False
_use_legacy = False  # the legacy folder could be neither moved nor copied: use it for this run


def data_dir() -> Path:
    """Conversions, logs, window storage. Override with MIDICONV_DATA.

    The default is %LOCALAPPDATA%\\Keytrace. The first call of a run moves the folder of the app's
    earlier name, %LOCALAPPDATA%\\MIDI Converter, there when only that one exists."""
    override = os.environ.get("MIDICONV_DATA")
    if override:
        p = Path(override)
    else:
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
        p = base / APP_NAME
        _migrate_once(base / LEGACY_DATA_NAME, p)
        if _use_legacy:
            p = base / LEGACY_DATA_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def _migrate_once(old: Path, new: Path) -> None:
    global _migration_checked, _use_legacy
    if _migration_checked:
        return
    with _migration_lock:
        if _migration_checked:
            return
        try:
            _use_legacy = not migrate_legacy_data(old, new)
        except Exception as e:  # never stop the app over this
            migration_log.append(f"data folder: moving {old} to {new} failed ({e}); using the old folder for now")
            _use_legacy = old.is_dir() and not new.exists()
        _migration_checked = True


def migrate_legacy_data(old: Path, new: Path, attempts: int = 4) -> bool:
    """Move the data folder `old` to `new` when `new` does not exist and `old` does.

    First renames the folder (same volume: instant and atomic), retrying briefly while a file in it
    is still open (say, by a WebView2 process that has not exited yet). If that keeps failing, copies
    it to a temporary sibling, renames the copy into place (so `new` never holds a partial copy) and
    then deletes what it can of `old`. If the copy fails, `old` is left untouched and the partial
    copy is removed.

    Returns False when `old` is still the only copy, so the caller should keep using it for now
    (the move is tried again at the next start); True otherwise."""
    if new.exists() or not old.is_dir():
        return True
    move_error: OSError | None = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(0.25 * attempt)
        try:
            os.replace(old, new)
            migration_log.append(f"data folder: moved {old} to {new}")
            return True
        except OSError as e:
            move_error = e
            if new.exists() or not old.is_dir():  # another instance moved it meanwhile
                return True

    tmp = new.with_name(f"{new.name}.migrating-{os.getpid()}")
    try:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(old, tmp, symlinks=True)
        os.replace(tmp, new)
    except (OSError, shutil.Error) as e:
        shutil.rmtree(tmp, ignore_errors=True)
        if new.exists():  # another instance finished first
            return True
        msg = str(e) if len(str(e)) < 400 else str(e)[:400] + "…"
        migration_log.append(f"data folder: could not move ({move_error}) or copy ({msg}) {old} to {new}; "
                             "using the old folder for now")
        return False
    left: list[str] = []
    shutil.rmtree(old, onexc=lambda _func, path, _exc: left.append(path))
    migration_log.append(f"data folder: copied {old} to {new} because moving it failed ({move_error})"
                         + (f"; {len(left)} item(s) of the old folder could not be deleted" if left else ""))
    return True
