"""Keytrace desktop app: the interface in a native window (Edge WebView2 via pywebview).

The backend (server.py) runs on a background thread, bound to 127.0.0.1 on a random port and
locked to this window with a per-launch token.
"""
from __future__ import annotations

import ctypes
import faulthandler
import functools
import html
import json
import logging
import logging.handlers
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import APP_NAME, __version__, paths
from .paths import APP_DIR, data_dir

APP_USER_MODEL_ID = "Keytrace.Desktop"  # the same in the installer's shortcuts
MUTEX_NAME = "Keytrace.SingleInstance"  # the same as the installer's AppMutex
ICON = next((p for p in (APP_DIR.parent / "assets" / "Keytrace.ico",  # installed layout
                         *sorted((APP_DIR / "installer").rglob("Keytrace.ico"))) if p.exists()), None)
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


def _windows_dark() -> bool:
    """True when Windows apps use the dark theme (Settings > Personalization > Colors)."""
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def _appearance() -> str:
    """The theme chosen in the app: settings.appearance in settings.json ('light' unless set)."""
    try:
        value = json.loads((data_dir() / "settings.json").read_text(encoding="utf-8")).get("appearance")
    except (OSError, ValueError, AttributeError):
        value = None
    return value if value in ("light", "system", "dark") else "light"


def _effective_dark(appearance: str) -> bool:
    return appearance == "dark" or (appearance == "system" and _windows_dark())


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
        self._dark = None  # the theme applied to the window frame
        self._theme_lock = threading.Lock()  # keeps the last call last
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

    def set_theme(self, dark) -> bool:
        """Match the title bar and the window background to the page's theme (called by the page
        at startup and whenever its effective theme changes)."""
        dark = dark.strip().lower() in ("1", "true", "dark") if isinstance(dark, str) else bool(dark)
        with self._theme_lock:
            if self._window is not None and dark != self._dark:
                self._dark = dark
                _style_window(self._window, dark, set_icon=False)
        return dark


# ---------------------------------------------------------------------------- pages
# The interface's "Essential" palette (web/styles.css), light and dark: keep in step. The wordmark is
# "Key" in wm_key and "trace" in wm_trace, in Sitka Display Semibold (as in web/index.html).
PALETTE = {
    False: {"bg": "#F6F8F7", "ink": "#1B2523", "ink2": "#394542", "muted": "#5D6966", "accent": "#2C7567",
            "tint": "#EAF3F0", "danger": "#B03A3A", "wm_key": "#1B2523", "wm_trace": "#2C7567"},
    True: {"bg": "#0F1513", "ink": "#E4ECE9", "ink2": "#C2CDCA", "muted": "#8F9D99", "accent": "#5FC0A9",
           "tint": "#1A2C28", "danger": "#F0938B", "wm_key": "#E4ECE9", "wm_trace": "#5FC0A9"},
}
MARK_SVG = paths.WEB_DIR / "brand" / "keytrace-mark.svg"  # the mark's master for sizes above 24 px


@functools.lru_cache(maxsize=1)
def _mark() -> str:
    """The Keytrace mark as inline SVG of class "mark": the master file itself, so these pages show the
    artwork of the web header and the app icon, in its own colours in both themes. Empty (no mark) if
    the file cannot be read."""
    try:
        svg = MARK_SVG.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("Cannot read the mark %s: %s", MARK_SVG, e)
        return ""
    svg = re.sub(r">\s+<", "><", re.sub(r"<!--.*?-->", "", svg, flags=re.S).strip())
    return svg.replace("<svg ", '<svg class="mark" aria-hidden="true" ', 1)


def _logo() -> str:
    return f'<div class="logo">{_mark()}<div class="wm">Key<span>trace</span></div></div>'  # mark + wordmark


def _page(dark: bool, body: str) -> str:
    c = PALETTE[dark]
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
:root{{color-scheme:{"dark" if dark else "light"}}}
html,body{{margin:0;height:100%;background:{c["bg"]};color:{c["ink"]};
font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;cursor:default}}
.c{{box-sizing:border-box;height:100%;padding:32px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
.mark{{width:60px;height:60px;margin-bottom:24px}}
.t{{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-weight:350;font-size:34px;line-height:1.15;letter-spacing:-.015em;max-width:640px}}
.logo{{display:flex;align-items:center;gap:16px}}
.logo .mark{{width:52px;height:52px;margin:0}}
.wm{{font-family:"Sitka Display",Sitka,Georgia,serif;font-weight:600;font-size:46px;line-height:1;letter-spacing:-.01em;color:{c["wm_key"]}}}
.wm span{{color:{c["wm_trace"]}}}
.b{{margin-top:28px;width:180px;height:4px;border-radius:2px;background:{c["tint"]};overflow:hidden}}
.b i{{display:block;width:36%;height:100%;border-radius:2px;background:{c["accent"]};animation:s 1.2s ease-in-out -.45s infinite}}
@keyframes s{{from{{transform:translateX(-100%)}}to{{transform:translateX(280%)}}}}
.m{{margin-top:14px;color:{c["muted"]};font-size:14px}}
.e{{margin-top:12px;color:{c["ink2"]};font-size:16px;max-width:640px}}
.d{{margin-top:22px;color:{c["muted"]};font-size:13px;max-width:640px;overflow-wrap:anywhere}}
.d code{{font:12.5px "Cascadia Mono",Consolas,monospace;color:{c["ink2"]};user-select:all;cursor:text}}
.x{{display:inline-block;width:8px;height:8px;border-radius:50%;background:{c["danger"]};margin-right:8px;vertical-align:1px}}
</style></head><body><div class="c">{body}</div></body></html>"""


def _loading_html(dark: bool) -> str:
    return _page(dark, f'{_logo()}<div class="b"><i></i></div><div class="m" id="m">Starting…</div>')


def _error_html(dark: bool, message: str, log_path: Path) -> str:
    return _page(dark, f'{_mark()}<div class="t">{html.escape(APP_NAME)} couldn’t start</div>'
                       f'<div class="e"><span class="x"></span>{html.escape(message)}</div>'
                       f'<div class="d">Details are in the log:<br><code>{html.escape(str(log_path))}</code></div>')


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
    for line in paths.migration_log:  # what the first data_dir() call did with the old "MIDI Converter" folder
        log.info("%s", line)
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass

    try:
        import webview
    except Exception as e:  # pragma: no cover
        log.exception("pywebview unavailable")
        _message_box(f"The app window component could not be loaded ({e}).\n\nRe-run the {APP_NAME} setup to repair it.")
        return 1

    from . import server

    token = secrets.token_urlsafe(32)
    port = _free_port()
    server.configure(token)
    httpd = server.make_server(port)
    threading.Thread(target=httpd.run, name="http", daemon=True).start()
    if os.environ.get("MIDICONV_DEBUG"):
        log.info("debug URL: http://127.0.0.1:%d/?token=%s", port, token)

    appearance = _appearance()
    dark = _effective_dark(appearance)
    log.info("appearance %s (%s)", appearance, "dark" if dark else "light")
    api = DesktopApi()
    window = webview.create_window(APP_NAME, html=_loading_html(dark), js_api=api, width=1240, height=880,
                                   min_size=(820, 600), background_color=PALETTE[dark]["bg"])
    api._window = window
    api._dark = dark

    def before_show():  # on the UI thread, before the window appears: no flash of the other theme
        form = window.native
        try:  # pywebview re-themes the title bar from the Windows theme on every UserPreferenceChanged
            form.update_title_bar_theme = lambda: _set_title_bar(form.Handle.ToInt64(), bool(api._dark))
        except Exception:
            log.debug("could not take over the title bar theme", exc_info=True)
        _style_window(window, dark)

    window.events.before_show += before_show

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
        deadline = time.time() + 60
        while not httpd.started and time.time() < deadline:
            time.sleep(0.05)
        if not httpd.started:
            log.error("backend did not start")
            window.load_html(_error_html(api._dark, "The converter engine did not start. Close the window and "
                                                   f"open {APP_NAME} again.", log_path))
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


def _colorref(hex_color: str) -> int:
    r, g, b = (int(hex_color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    return r | (g << 8) | (b << 16)  # 0x00BBGGRR


def _set_title_bar(hwnd_value: int, dark: bool) -> None:
    """Light or dark title bar; on Windows 11 also in the page's background colour, so the window
    reads as one surface."""
    dwm = ctypes.windll.dwmapi
    hwnd = ctypes.c_void_p(hwnd_value)
    flag = ctypes.c_int(1 if dark else 0)
    if dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(flag), ctypes.sizeof(flag)) != 0:  # USE_IMMERSIVE_DARK_MODE
        dwm.DwmSetWindowAttribute(hwnd, 19, ctypes.byref(flag), ctypes.sizeof(flag))  # its id before Windows 10 20H1
    caption = ctypes.c_uint(_colorref(PALETTE[dark]["bg"]))
    dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(caption), ctypes.sizeof(caption))  # CAPTION_COLOR (Windows 11)
    backdrop = ctypes.c_int(1)  # SYSTEMBACKDROP_TYPE = none: pywebview turns on Mica in dark mode
    dwm.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(backdrop), ctypes.sizeof(backdrop))
    # Redraw the frame: NOSIZE | NOMOVE | NOZORDER | NOACTIVATE | FRAMECHANGED
    ctypes.windll.user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0037)


def _style_window(window, dark: bool, set_icon: bool = True) -> None:
    """App icon (instead of python's), the title bar and the window background for the light or dark
    theme. Runs on the UI thread (marshalled with Invoke when called from another thread)."""
    try:
        from System import Action  # pythonnet, loaded by pywebview's WinForms backend
        from System.Drawing import ColorTranslator

        form = window.native

        def apply():
            if set_icon and ICON is not None:
                from System.Drawing import Icon

                form.Icon = Icon(str(ICON))
            _set_title_bar(form.Handle.ToInt64(), dark)
            try:  # what shows while the window resizes or the page loads
                color = ColorTranslator.FromHtml(PALETTE[dark]["bg"])
                form.BackColor = color
                browser = getattr(form, "webview", None)
                if browser is not None:
                    browser.DefaultBackgroundColor = color
            except Exception:
                log.debug("could not set the window background", exc_info=True)

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
