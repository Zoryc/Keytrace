"""Local web server: REST API + Server-Sent Events + the static front end in web/."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import shutil
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import APP_NAME, __version__, engines, pipeline
from .jobs import TERMINAL, JobManager
from .postprocess import OUTPUT_OPTIONS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
MAX_UPLOAD_BYTES = 2 * 1024 ** 3

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
        _manager = JobManager(DATA / "jobs")
    return _manager


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


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


def run(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    import uvicorn

    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"
    print(f"{APP_NAME} {__version__} running at {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port, log_level="warning", timeout_graceful_shutdown=2)
