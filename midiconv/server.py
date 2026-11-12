"""In-process HTTP backend for the desktop window: REST API + Server-Sent Events + the UI files.

It listens on 127.0.0.1 only, on a random port, and every request must carry the per-launch
session token that the desktop window receives (see desktop.py). It is not meant to be opened
in a browser.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import secrets
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import APP_NAME, __version__, engines, pipeline
from .jobs import TERMINAL, JobManager
from .paths import WEB_DIR, data_dir
from .postprocess import OUTPUT_OPTIONS

MAX_UPLOAD_BYTES = 2 * 1024 ** 3
SESSION_COOKIE = "mc_session"
_token: str | None = None

# The Windows registry can map .js to text/plain, which breaks ES modules.
for ext, mt in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
                (".svg", "image/svg+xml"), (".flac", "audio/flac"), (".mid", "audio/midi")):
    mimetypes.add_type(mt, ext)

@asynccontextmanager
async def _lifespan(_app):
    manager()  # starts the GPU worker, which preloads the default models
    yield


app = FastAPI(title=APP_NAME, version=__version__, docs_url=None, redoc_url=None, lifespan=_lifespan)
_manager: JobManager | None = None
_device_info: dict | None = None


def manager() -> JobManager:
    global _manager
    if _manager is None:
        _manager = JobManager(data_dir() / "jobs")
    return _manager


def manager_if_started() -> JobManager | None:
    return _manager


def configure(token: str) -> None:
    """Require this per-launch token (set by the desktop window) on every request."""
    global _token
    _token = token


@app.middleware("http")
async def _guard(request: Request, call_next):
    if _token is None:
        return PlainTextResponse("Not configured.", status_code=503)
    host = request.headers.get("host", "")
    if not (host.startswith("127.0.0.1:") or host.startswith("localhost:")):
        return PlainTextResponse("Forbidden.", status_code=403)  # DNS-rebinding guard
    given = request.query_params.get("token")
    if given is not None and secrets.compare_digest(given, _token):
        resp = RedirectResponse(request.url.path or "/", status_code=303)
        resp.set_cookie(SESSION_COOKIE, _token, httponly=True, samesite="strict")
        return resp
    if not secrets.compare_digest(request.cookies.get(SESSION_COOKIE, ""), _token):
        return PlainTextResponse("MIDI Converter is a desktop app: open it from the Start menu.", status_code=403)
    return await call_next(request)


def device_info() -> dict:
    global _device_info
    if _device_info is None:
        try:
            import torch

            if torch.cuda.is_available():
                _device_info = {"kind": "gpu", "name": torch.cuda.get_device_name(0)}
            else:
                _device_info = {"kind": "cpu", "name": "CPU"}
        except Exception:
            _device_info = {"kind": "cpu", "name": "CPU"}
    return _device_info


def _job_or_404(job_id: str):
    job = manager().get(job_id)
    if job is None:
        raise HTTPException(404, "Conversion not found.")
    return job


def _job_json(job) -> dict:
    d = job.to_json()
    d["queue_position"] = manager().queue_position(job) if job.status == "queued" else -1
    return d


@app.get("/api/info")
def info():
    return {"app": APP_NAME, "version": __version__, "device": device_info(),
            "instruments": [i.to_json() for i in engines.instruments()],
            "output_options": [o.to_json() for o in OUTPUT_OPTIONS]}


def _settings_path() -> Path:
    return data_dir() / "settings.json"


@app.get("/api/settings")
def get_settings():
    """UI settings live here, not in the window's localStorage: the window's origin (random port)
    changes on every launch, so localStorage would start empty each time."""
    try:
        d = json.loads(_settings_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


@app.put("/api/settings")
async def put_settings(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Settings must be a JSON object.")
    if not isinstance(body, dict) or len(json.dumps(body)) > 200_000:
        raise HTTPException(400, "Settings must be a small JSON object.")
    tmp = _settings_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(body), encoding="utf-8")
    tmp.replace(_settings_path())
    return {"ok": True}


@app.get("/api/jobs")
def list_jobs():
    return manager().list()


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...), instrument: str = Form("piano"), engine: str = Form(""),
                     engine_options: str = Form("{}"), output_options: str = Form("{}")):
    try:
        e_opts = json.loads(engine_options or "{}")
        o_opts = json.loads(output_options or "{}")
        if not isinstance(e_opts, dict) or not isinstance(o_opts, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "Options must be JSON objects.")
    try:
        job = manager().create(file.filename or "audio", instrument, engine or None, e_opts, o_opts)
    except KeyError as e:
        raise HTTPException(400, str(e.args[0] if e.args else e))
    except ValueError as e:
        raise HTTPException(503, str(e))

    suffix = Path(file.filename or "").suffix.lower()[:10] or ".bin"
    dest = job.workdir / f"input{suffix}"
    size = 0
    with dest.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                fh.close()
                shutil.rmtree(job.workdir, ignore_errors=True)
                raise HTTPException(413, "This file is larger than 2 GB.")
            fh.write(chunk)
    if size == 0:
        shutil.rmtree(job.workdir, ignore_errors=True)
        raise HTTPException(400, "The file is empty.")
    manager().submit(job, dest)
    return _job_json(job)


@app.post("/api/jobs/local")
async def create_local_job(request: Request):
    """Convert a file already on this computer (Open with / right-click 'Convert to MIDI')."""
    try:
        body = await request.json()
        src = Path(str(body["path"]))
    except Exception:
        raise HTTPException(400, "Missing file path.")
    if not src.is_file():
        raise HTTPException(404, f"File not found: {src.name}")
    try:
        job = manager().create(src.name, body.get("instrument") or "piano", body.get("engine") or None,
                               body.get("engine_options") or {}, body.get("output_options") or {})
    except KeyError as e:
        raise HTTPException(400, str(e.args[0] if e.args else e))
    except ValueError as e:
        raise HTTPException(503, str(e))
    dest = job.workdir / f"input{src.suffix.lower()[:10] or '.bin'}"
    try:
        await asyncio.to_thread(shutil.copyfile, src, dest)
    except OSError as e:
        shutil.rmtree(job.workdir, ignore_errors=True)
        raise HTTPException(400, f"Could not read {src.name}: {e.strerror or e}")
    manager().submit(job, dest)
    return _job_json(job)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _job_json(_job_or_404(job_id))


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    job = _job_or_404(job_id)
    mgr = manager()

    async def stream():
        seen = -1
        while True:
            if await request.is_disconnected():
                return
            version = await asyncio.to_thread(mgr.wait_for_change, job, seen, 10.0)
            if mgr.get(job.id) is None:  # deleted
                yield "event: end\ndata: {}\n\n"
                return
            if version != seen:
                seen = version
                yield f"event: job\ndata: {json.dumps(_job_json(job))}\n\n"
                if job.status in TERMINAL:
                    yield "event: end\ndata: {}\n\n"
                    return
            else:
                yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = manager().cancel(job_id)
    if job is None:
        raise HTTPException(404, "Conversion not found.")
    return _job_json(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    if not manager().delete(job_id):
        raise HTTPException(404, "Conversion not found.")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/export")
async def reexport(job_id: str, request: Request):
    _job_or_404(job_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        job = await asyncio.to_thread(manager().reexport, job_id, body.get("output_options", {}))
    except KeyError as e:
        raise HTTPException(409, str(e.args[0] if e.args else e))
    return _job_json(job)


@app.post("/api/jobs/{job_id}/rerun")
async def rerun(job_id: str, request: Request):
    """Convert the same input again with different settings (creates a new job)."""
    src = _job_or_404(job_id)
    if not src.input_path or not src.input_path.exists():
        raise HTTPException(409, "The original file is no longer available.")
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        job = manager().create(src.filename, body.get("instrument") or src.instrument, body.get("engine") or None,
                               body.get("engine_options") or {}, body.get("output_options") or {})
    except KeyError as e:
        raise HTTPException(400, str(e.args[0] if e.args else e))
    except ValueError as e:
        raise HTTPException(503, str(e))
    dest = job.workdir / src.input_path.name
    await asyncio.to_thread(shutil.copyfile, src.input_path, dest)
    manager().submit(job, dest)
    return _job_json(job)


def _done_file(job_id: str, name: str) -> Path:
    job = _job_or_404(job_id)
    p = job.workdir / name
    if job.status != "done" or not p.exists():
        raise HTTPException(404, "Not available.")
    return p


@app.get("/api/jobs/{job_id}/midi")
def download_midi(job_id: str):
    job = _job_or_404(job_id)
    return FileResponse(_done_file(job_id, pipeline.MIDI_FILE), media_type="audio/midi",
                        filename=job.midi_name, headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{job_id}/notes")
def notes(job_id: str):
    return FileResponse(_done_file(job_id, pipeline.NOTES_FILE), media_type="application/json",
                        headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{job_id}/audio")
def preview_audio(job_id: str):
    return FileResponse(_done_file(job_id, pipeline.PREVIEW_FILE), media_type="audio/flac")


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):  # pragma: no cover
    return JSONResponse({"detail": "Unexpected server error."}, status_code=500)


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="ui")


def make_server(port: int):
    """A uvicorn server for 127.0.0.1:<port>, to be run on a background thread."""
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", log_config=None,
                            timeout_graceful_shutdown=1, access_log=False)
    return uvicorn.Server(config)
