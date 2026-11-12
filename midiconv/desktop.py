"""MIDI Converter desktop app: the interface in a native window (Edge WebView2 via pywebview).

The backend (server.py) runs on a background thread, bound to 127.0.0.1 on a random port and
locked to this window with a per-launch token.
"""
from __future__ import annotations

import ctypes
import faulthandler
import json
import logging
import logging.handlers
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import APP_NAME, __version__
from .paths import APP_DIR, data_dir

APP_USER_MODEL_ID = "MIDIConverter.Desktop"
MUTEX_NAME = "MIDIConverter.SingleInstance"
ICON = next((p for p in (APP_DIR.parent / "assets" / "MIDIConverter.ico",  # installed layout
                         *sorted((APP_DIR / "installer").rglob("MIDIConverter.ico"))) if p.exists()), None)
log = logging.getLogger("midiconv.desktop")
_mutex = None


# ---------------------------------------------------------------------------- Windows helpers
def _acquire_single_instance() -> bool:
    global _mutex
    k32 = ctypes.windll.kernel32
    k32.CreateMutexW.restype = ctypes.c_void_p
    _mutex = k32.CreateMutexW(None, False, MUTEX_NAME)
    return k32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def _focus_existing_window() -> None:
    u32 = ctypes.windll.user32
    hwnd = u32.FindWindowW(None, APP_NAME)
    if hwnd:
        u32.ShowWindow(hwnd, 9)  # SW_RESTORE
        u32.SetForegroundWindow(hwnd)


def _dark_mode() -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def _message_box(text: str, title: str = APP_NAME, flags: int = 0x30) -> int:
    return ctypes.windll.user32.MessageBoxW(None, text, title, flags | 0x10000 | 0x40000)  # SETFOREGROUND|TOPMOST


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _setup_logging() -> Path:
    logs = data_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    path = logs / "app.log"
    handler = logging.handlers.RotatingFileHandler(path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    if sys.stdout is None or sys.stderr is None or "pythonw" in Path(sys.executable).name.lower():
        stream = open(logs / "console.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = stream
    faulthandler.enable(file=sys.stderr)
    return path


# ---------------------------------------------------------------------------- JS bridge
class DesktopApi:
    """Methods callable from the page as window.pywebview.api.<name>(...)."""

    def __init__(self):
        self._window = None
        self._prefs_path = data_dir() / "desktop.json"

    def _prefs(self) -> dict:
        try:
            return json.loads(self._prefs_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def save_midi(self, job_id: str, suggested_name: str):
        import webview

        from . import pipeline, server

        job = server.manager().get(str(job_id))
        if job is None or job.status != "done":
            return {"saved": False, "error": "This conversion is not available any more."}
        src = job.workdir / pipeline.MIDI_FILE
        prefs = self._prefs()
        start_dir = prefs.get("save_dir") or str(Path.home() / "Music")
        if not Path(start_dir).is_dir():
            start_dir = str(Path.home())
        name = "".join(c for c in (suggested_name or job.midi_name) if c not in '<>:"/\\|?*') or "transcription.mid"
        result = self._window.create_file_dialog(webview.FileDialog.SAVE, directory=start_dir,
                                                 save_filename=name, file_types=("MIDI file (*.mid)",))
        if not result:
            return {"saved": False}
        dest = Path(result if isinstance(result, str) else result[0])
        if dest.suffix.lower() not in (".mid", ".midi"):
            dest = dest.with_name(dest.name + ".mid")
        try:
            shutil.copyfile(src, dest)
        except OSError as e:
            return {"saved": False, "error": f"Could not save the file: {e.strerror or e}"}
        prefs["save_dir"] = str(dest.parent)
        try:
            self._prefs_path.write_text(json.dumps(prefs), encoding="utf-8")
        except OSError:
            pass
        return {"saved": True, "path": str(dest), "name": dest.name}

    def show_in_folder(self, path: str) -> None:
        p = Path(path)
        if p.exists():
            # A pre-quoted string is passed as is: explorer splits unquoted paths at commas.
            subprocess.Popen(f'explorer /select,"{p}"')

    def app_info(self) -> dict:
        return {"version": __version__, "data_dir": str(data_dir())}


# ---------------------------------------------------------------------------- pages
def _loading_html(dark: bool) -> str:
    bg, ink, muted, accent = ("#0f1013", "#ececf1", "#8e8e98", "#8484ff") if dark else ("#f5f5f2", "#1c1c1f", "#74747c", "#5b5bd6")
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;height:100%;background:{bg};color:{ink};font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif}}
.c{{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}}
svg{{width:56px;height:56px}} .t{{font-size:20px;font-weight:600;letter-spacing:-.01em}} .m{{color:{muted};font-size:14px}}
.b{{width:160px;height:4px;border-radius:9px;background:{muted}33;overflow:hidden}}
.b i{{display:block;width:35%;height:100%;border-radius:9px;background:{accent};animation:s 1.1s ease-in-out infinite}}
@keyframes s{{from{{transform:translateX(-100%)}}to{{transform:translateX(300%)}}}}
</style></head><body><div class="c">
<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="{accent}"/><path d="M9 9v14M14 9v14M19 9v14M24 9v14" stroke="{bg}" stroke-width="2.4" stroke-linecap="round"/><rect x="11" y="9" width="4" height="8" rx="1.2" fill="{bg}"/><rect x="20" y="9" width="4" height="8" rx="1.2" fill="{bg}"/></svg>
<div class="t">{APP_NAME}</div><div class="b"><i></i></div><div class="m" id="m">Starting…</div></div></body></html>"""


def _error_html(dark: bool, message: str, log_path: Path) -> str:
    page = _loading_html(dark).replace('<div class="b"><i></i></div>', "")
    return page.replace('<div class="m" id="m">Starting…</div>',
                        f'<div class="m" style="max-width:520px;text-align:center">{message}<br><br>'
                        f'Details: {log_path}</div>')


# ---------------------------------------------------------------------------- main
def _inbox() -> Path:
    d = data_dir() / "inbox"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _file_args(argv: list[str] | None) -> list[str]:
    return [str(Path(a).resolve()) for a in (argv or []) if not a.startswith("-") and Path(a).is_file()]


def _forward_to_running_instance(paths: list[str]) -> None:
    """Hand files to the window that is already open (it polls the inbox)."""
    if paths:
        tmp = _inbox() / f"{secrets.token_hex(8)}.tmp"
        tmp.write_text(json.dumps({"paths": paths}), encoding="utf-8")
        tmp.replace(tmp.with_suffix(".json"))
    _focus_existing_window()


def _watch_inbox(window, ready: threading.Event, started_at: float) -> None:
    """Pick up files sent by later launches and start converting them in this window."""
    box = _inbox()
    for stale in box.glob("*.json"):  # only requests left over from a previous session
        try:
            if stale.stat().st_mtime < started_at - 2.0:
                stale.unlink(missing_ok=True)
        except OSError:
            pass
    while True:
        time.sleep(0.5)
        for req in sorted(box.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                paths = json.loads(req.read_text(encoding="utf-8")).get("paths", [])
            except (OSError, ValueError):
                paths = []
            req.unlink(missing_ok=True)
            if paths and ready.wait(60):
                _convert_in_window(window, paths)


def _convert_in_window(window, paths: list[str]) -> None:
    try:
        window.restore()
    except Exception:
        pass
    window.evaluate_js(f"window.midiconvConvertPaths({json.dumps(paths)})")


def main(argv: list[str] | None = None) -> int:
    files = _file_args(argv)
    started_at = time.time()
    if not _acquire_single_instance():
        _forward_to_running_instance(files)
        return 0
    log_path = _setup_logging()
    log.info("%s %s starting (python %s)", APP_NAME, __version__, sys.version.split()[0])
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass

    try:
        import webview
    except Exception as e:  # pragma: no cover
        log.exception("pywebview unavailable")
        _message_box(f"The app window component could not be loaded ({e}).\n\nRe-run the MIDI Converter setup to repair it.")
        return 1

    from . import server

    token = secrets.token_urlsafe(32)
    port = _free_port()
    server.configure(token)
    httpd = server.make_server(port)
    threading.Thread(target=httpd.run, name="http", daemon=True).start()
    if os.environ.get("MIDICONV_DEBUG"):
        log.info("debug URL: http://127.0.0.1:%d/?token=%s", port, token)

    dark = _dark_mode()
    api = DesktopApi()
    window = webview.create_window(APP_NAME, html=_loading_html(dark), js_api=api, width=1240, height=880,
                                   min_size=(820, 600), background_color="#0F1013" if dark else "#F5F5F2")
    api._window = window

    def on_closing():
        mgr = server.manager_if_started()
        busy = mgr is not None and any(j["status"] in ("queued", "running") for j in mgr.list())
        if not busy:
            return True
        answer = _message_box("A conversion is still running. Quit anyway?\n\nIt will be cancelled.",
                              flags=0x04 | 0x30 | 0x100)  # YESNO | WARNING | DEFBUTTON2
        return answer == 6  # IDYES

    window.events.closing += on_closing

    def boot():
        _style_window(window, dark)
        deadline = time.time() + 60
        while not httpd.started and time.time() < deadline:
            time.sleep(0.05)
        if not httpd.started:
            log.error("backend did not start")
            window.load_html(_error_html(dark, "The converter engine could not start.", log_path))
            return
        window.load_url(f"http://127.0.0.1:{port}/?token={token}")
        deadline = time.time() + 60  # wait until the page has loaded its settings
        while time.time() < deadline:
            try:
                if window.evaluate_js("window.midiconvReady === true"):
                    break
            except Exception:
                pass
            time.sleep(0.2)
        page_ready.set()
        if files:
            _convert_in_window(window, files)

    page_ready = threading.Event()
    threading.Thread(target=_watch_inbox, args=(window, page_ready, started_at), name="inbox", daemon=True).start()
    try:
        start_kwargs = {"icon": str(ICON)} if ICON is not None else {}
        webview.start(boot, gui="edgechromium", private_mode=False, storage_path=str(data_dir() / "webview"),
                      debug=bool(os.environ.get("MIDICONV_DEBUG")), **start_kwargs)
    except Exception as e:
        log.exception("window failed")
        _message_box(f"The app window could not be opened ({e}).\n\nMicrosoft Edge WebView2 is required; it is "
                     "included with Windows 11 and can be installed from microsoft.com for Windows 10.")
        return 1
    finally:
        _shutdown(httpd)
    return 0


def _style_window(window, dark: bool) -> None:
    """App icon (instead of python's) and a dark title bar when Windows uses dark mode."""
    try:
        from System import Action  # pythonnet, loaded by pywebview's WinForms backend

        form = window.native

        def apply():
            if ICON is not None:
                from System.Drawing import Icon

                form.Icon = Icon(str(ICON))
            if dark:
                hwnd = ctypes.c_void_p(form.Handle.ToInt64())
                on = ctypes.c_int(1)
                ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), ctypes.sizeof(on))
                ctypes.windll.user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0027)  # NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED

        form.Invoke(Action(apply))
    except Exception:
        log.debug("could not style the window", exc_info=True)


def _shutdown(httpd) -> None:
    log.info("closing")
    try:
        from . import server

        mgr = server.manager_if_started()
        if mgr is not None:
            for j in mgr.list():
                if j["status"] in ("queued", "running"):
                    mgr.cancel(j["id"])
    except Exception:
        pass
    httpd.should_exit = True
    time.sleep(0.3)
    logging.shutdown()
    os._exit(0)  # do not wait for the GPU worker thread
