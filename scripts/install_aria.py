"""Install the optional Aria-AMT engine into the app's runtime (standard library only).

Called by setup_runtime.py with --with-aria:
  runtime\\Scripts\\python.exe app\\scripts\\install_aria.py --uv tools\\uv.exe

Installs aria-amt and ariautils (pinned commits, from GitHub archives so git is not needed) without
their dependencies (their pins conflict with the CUDA 12.8 PyTorch build), plus the few small
packages they need, then downloads the 447 MB model weights (CC BY-NC-SA 4.0, non-commercial).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGES = [
    "ariautils @ https://github.com/EleutherAI/aria-utils/archive/7c815755c6889a784b6a1b3343e9e8daa3e7d128.zip",
    "aria-amt @ https://github.com/EleutherAI/aria-amt/archive/a1ab73fc901d1759ec3bc173c146b3c6a3040261.zip",
    "safetensors==0.8.0",
    "orjson==3.13.0",
    "tqdm==4.70.1",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uv", required=True)
    args = ap.parse_args()
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    cmd = [args.uv, "pip", "install", "--python", sys.executable, "--no-deps", *PACKAGES]
    print("> " + " ".join(cmd), flush=True)
    if subprocess.call(cmd, creationflags=flags) != 0:
        print("Could not install the Aria-AMT packages.", flush=True)
        return 1
    weights = HERE / "get_aria_weights.py"
    print(f"> {weights.name}", flush=True)
    return subprocess.call([sys.executable, str(weights)], creationflags=flags)


if __name__ == "__main__":
    sys.exit(main())
