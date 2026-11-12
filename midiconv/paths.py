"""Where things live. The app folder may be read-only (installed), so user data goes to LocalAppData."""
from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent  # repo root, or {install}\app when installed
WEB_DIR = APP_DIR / "web"
MODELS_DIR = APP_DIR / "models"


def data_dir() -> Path:
    """Conversions, logs, window storage. Override with MIDICONV_DATA."""
    override = os.environ.get("MIDICONV_DATA")
    if override:
        p = Path(override)
    else:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        p = Path(base) / "MIDI Converter"
    p.mkdir(parents=True, exist_ok=True)
    return p
