"""Install MIDI Converter's Python packages into the app's runtime venv (standard library only).

Run by the installer's setup window, with the freshly created venv's python:
  runtime\\Scripts\\python.exe app\\scripts\\setup_runtime.py --uv tools\\uv.exe [--with-aria]

Progress protocol on stdout (parsed by the setup window; any other line is log detail):
  @@STATUS <text>        what is happening, shown to the user
  @@PROGRESS <0..1>      overall progress
  @@DONE <text>          success summary
  @@ERROR <text>         failure, shown to the user (exit code 1)
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent  # ...\app
INSTALL = APP.parent  # install root
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
TORCH = ["torch==2.11.0+cu128", "torchaudio==2.11.0+cu128"]
TORCH_WHEELS = [  # used only to size the progress bar
    f"{TORCH_INDEX}/torch-2.11.0%2Bcu128-cp313-cp313-win_amd64.whl",
    f"{TORCH_INDEX}/torchaudio-2.11.0%2Bcu128-cp313-cp313-win_amd64.whl",
]
NO_DEPS = ["transkun==2.0.1", "moduleconf==0.1.4"]

# (weight of the step in the progress bar, user-facing status)
STEPS = {
    "torch": (0.80, "Installing PyTorch for your graphics card (a 2.7 GB download the first time)"),
    "packages": (0.10, "Installing audio and app components"),
    "transkun": (0.03, "Installing the piano transcription model"),
    "aria": (0.12, "Installing the Aria-AMT engine (about 450 MB)"),
    "verify": (0.02, "Checking the installation"),
}


def say(kind: str, text: str = "") -> None:
    print(f"@@{kind} {text}".rstrip(), flush=True)


class Bar:
    def __init__(self, steps: list[str]):
        total = sum(STEPS[s][0] for s in steps)
        self.weights = {s: STEPS[s][0] / total for s in steps}
        self.done = 0.0
        self.current = None

    def start(self, step: str) -> None:
        self.current = step
        say("STATUS", STEPS[step][1])
        say("PROGRESS", f"{self.done:.4f}")

    def inner(self, frac: float) -> None:
        frac = max(0.0, min(1.0, frac))
        say("PROGRESS", f"{self.done + frac * self.weights[self.current]:.4f}")

    def finish(self) -> None:
        self.done += self.weights[self.current]
        say("PROGRESS", f"{self.done:.4f}")


def dir_size(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def remote_size(url: str) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as r:
            return int(r.headers.get("Content-Length", 0))
    except Exception:
        return 0


def run(cmd: list[str], env: dict, watch: Path | None = None, expected: int = 0, bar: Bar | None = None) -> None:
    print("> " + " ".join(cmd), flush=True)
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stop = threading.Event()
    if watch is not None and expected and bar is not None:
        base = dir_size(watch) if watch.exists() else 0

        def poll():
            while not stop.wait(1.0):
                grown = (dir_size(watch) if watch.exists() else 0) - base
                bar.inner(0.95 * grown / expected)

        threading.Thread(target=poll, daemon=True).start()
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(line, flush=True)
    code = proc.wait()
    stop.set()
    if code != 0:
        raise RuntimeError(f"A download or install step failed (exit code {code}). Check the internet connection "
                           "and click Retry; 'Show details' has the full log.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uv", required=True)
    ap.add_argument("--with-aria", action="store_true")
    args = ap.parse_args()

    uv = str(Path(args.uv).resolve())
    py = sys.executable
    cache = Path(os.environ.get("MIDICONV_UV_CACHE") or INSTALL / ".uv-cache")
    env = dict(os.environ, UV_CACHE_DIR=str(cache), UV_NO_CONFIG="1", UV_PYTHON_PREFERENCE="only-managed",
               UV_HTTP_TIMEOUT="300", UV_CONCURRENT_DOWNLOADS="4", PYTHONUTF8="1")
    pip = [uv, "pip", "install", "--python", py]

    steps = ["torch", "packages", "transkun"] + (["aria"] if args.with_aria else []) + ["verify"]
    bar = Bar(steps)
    try:
        bar.start("torch")
        # uv unpacks wheels into its cache while downloading: the cache grows ~1.5x the wheel size
        expected = int(1.5 * (sum(remote_size(u) for u in TORCH_WHEELS) or 2_760_000_000))
        run(pip + TORCH + ["--index-url", TORCH_INDEX], env, watch=cache, expected=expected, bar=bar)
        bar.finish()

        bar.start("packages")
        run(pip + ["-r", str(APP / "requirements-runtime.txt")], env)
        bar.finish()

        bar.start("transkun")
        run(pip + ["--no-deps"] + NO_DEPS, env)
        bar.finish()

        if args.with_aria:
            bar.start("aria")
            aria = APP / "scripts" / "install_aria.py"
            if not aria.exists():
                raise RuntimeError("install_aria.py is missing from this installation.")
            run([py, str(aria), "--uv", uv], env, watch=APP / "models" / "aria-amt", expected=446_577_344, bar=bar)
            bar.finish()

        bar.start("verify")
        probe = ("import torch, transkun, webview, av, soxr, fastapi;"
                 + ("import amt, ariautils, safetensors;" if args.with_aria else "")
                 + "print('CUDA' if torch.cuda.is_available() else 'CPU', torch.__version__)")
        out = subprocess.run([py, "-c", probe], env=env, capture_output=True, text=True,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        print(out.stdout + out.stderr, flush=True)
        if out.returncode != 0:
            raise RuntimeError("The installed components could not be loaded.")
        (INSTALL / "runtime" / "midiconv-ready.txt").write_text(out.stdout.strip(), encoding="utf-8")
        bar.finish()
    except Exception as e:  # report and fail
        say("ERROR", str(e))
        return 1
    finally:
        if not os.environ.get("MIDICONV_UV_CACHE"):
            shutil.rmtree(cache, ignore_errors=True)

    device = "your NVIDIA GPU" if out.stdout.startswith("CUDA") else "the CPU (no compatible NVIDIA GPU found)"
    say("DONE", f"MIDI Converter is ready and will run on {device}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
