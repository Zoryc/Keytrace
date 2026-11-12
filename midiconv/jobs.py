"""Job queue: one GPU worker thread processes conversions in order; state is kept in memory and
mirrored to data/jobs/<id>/job.json so recent conversions survive a restart."""
from __future__ import annotations

import json
import queue
import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

from . import engines, pipeline
from .audio import AudioError
from .engines.base import Cancelled, Progress, coerce_options
from .postprocess import OUTPUT_OPTIONS

TERMINAL = {"done", "error", "cancelled"}
KEEP_JOBS = 50


def safe_stem(filename: str) -> str:
    stem = Path(filename or "audio").stem
    stem = re.sub(r"[^\w\-. ()\[\]]+", "_", stem, flags=re.UNICODE).strip(" ._") or "audio"
    return stem[:120]


class Job:
    def __init__(self, job_id: str, workdir: Path, filename: str, instrument: str, engine: str,
                 engine_options: dict, output_options: dict):
        self.id = job_id
        self.workdir = workdir
        self.filename = filename
        self.instrument = instrument
        self.engine = engine
        self.engine_options = engine_options
        self.output_options = output_options
        self.status = "queued"
        self.progress = 0.0
        self.message = "Waiting in line"
        self.error: str | None = None
        self.stats: dict = {}
        self.created = time.time()
        self.finished: float | None = None
        self.version = 0
        self.cancel_event = threading.Event()
        self.input_path: Path | None = None
        self.export_lock = threading.Lock()

    @property
    def midi_name(self) -> str:
        return safe_stem(self.filename) + ".mid"

    def to_json(self) -> dict:
        return {
            "id": self.id, "filename": self.filename, "midi_name": self.midi_name,
            "instrument": self.instrument, "engine": self.engine,
            "engine_options": self.engine_options, "output_options": self.output_options,
            "status": self.status, "progress": round(self.progress, 4), "message": self.message,
            "error": self.error, "stats": self.stats, "created": self.created, "finished": self.finished,
            "version": self.version,
        }

    def save(self) -> None:
        d = self.to_json()
        d["input_path"] = str(self.input_path) if self.input_path else None
        (self.workdir / "job.json").write_text(json.dumps(d), encoding="utf-8")


class JobManager:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._load_history()
        self._worker = threading.Thread(target=self._run, name="gpu-worker", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------------ public
    def create(self, filename: str, instrument: str, engine: str | None, engine_options: dict,
               output_options: dict) -> Job:
        eng = engines.get_engine(instrument, engine)  # raises KeyError for bad ids
        ok, why = eng.availability()
        if not ok:
            raise ValueError(why)
        job_id = uuid.uuid4().hex[:12]
        workdir = self.root / job_id
        workdir.mkdir(parents=True)
        job = Job(job_id, workdir, filename, instrument, eng.id,
                  coerce_options(eng.options, engine_options), coerce_options(OUTPUT_OPTIONS, output_options))
        return job

    def submit(self, job: Job, input_path: Path) -> None:
        job.input_path = input_path
        with self._lock:
            self._jobs[job.id] = job
            job.save()
            self._bump(job)
        self._queue.put(job.id)
        self._prune()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created, reverse=True)
            return [j.to_json() for j in jobs]

    def queue_position(self, job: Job) -> int:
        with self._lock:
            waiting = sorted((j for j in self._jobs.values() if j.status == "queued"), key=lambda j: j.created)
            return next((i for i, j in enumerate(waiting) if j.id == job.id), -1)

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None:
            return None
        job.cancel_event.set()
        with self._lock:
            if job.status == "queued":
                self._finish(job, "cancelled", "Cancelled")
        return job

    def delete(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None:
            return False
        job.cancel_event.set()
        with self._lock:
            self._jobs.pop(job_id, None)
            running = job.status == "running"  # the worker removes it when it notices
            self._changed.notify_all()
        if not running:
            shutil.rmtree(job.workdir, ignore_errors=True)
        return True

    def wait_for_change(self, job: Job, seen_version: int, timeout: float) -> int:
        with self._lock:
            if job.version == seen_version:
                self._changed.wait(timeout)
            return job.version

    def reexport(self, job_id: str, output_options: dict) -> Job:
        job = self.get(job_id)
        if job is None or job.status != "done":
            raise KeyError("This conversion is not finished.")
        opts = coerce_options(OUTPUT_OPTIONS, output_options)
        with job.export_lock:
            raw = pipeline.load_raw(job.workdir / pipeline.RAW_FILE)
            stats = pipeline.export(raw, opts, job.workdir, job.stats)
            with self._lock:
                job.output_options, job.stats = opts, stats
                job.save()
                self._bump(job)
        return job

    # ------------------------------------------------------------------ worker
    def _run(self) -> None:
        self._warm_up()
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if job is None or job.status != "queued":
                continue
            self._process(job)

    def _warm_up(self) -> None:
        """Load the default engine of every instrument so the first conversion starts fast."""
        for inst in engines.instruments():
            eng = inst.engines.get(inst.default_engine)
            if eng is not None and eng.availability()[0] and hasattr(eng, "_load"):
                try:
                    eng._load()
                except Exception:
                    traceback.print_exc()

    def _process(self, job: Job) -> None:
        def report(frac: float, msg: str | None) -> None:
            with self._lock:
                job.progress = frac
                if msg:
                    job.message = msg
                self._bump(job)

        with self._lock:
            job.status, job.message = "running", "Starting"
            self._bump(job)
        try:
            stats = pipeline.run(job.input_path, job.workdir, instrument=job.instrument, engine=job.engine,
                                 engine_options=job.engine_options, output_options=job.output_options,
                                 progress=Progress(report, job.cancel_event))
            with self._lock:
                job.stats = stats
                self._finish(job, "done", "Done")
        except Cancelled:
            with self._lock:
                self._finish(job, "cancelled", "Cancelled")
        except AudioError as e:
            with self._lock:
                self._finish(job, "error", "Failed", str(e))
        except Exception as e:  # keep the worker alive whatever happens
            traceback.print_exc()
            msg = str(e) or e.__class__.__name__
            if "out of memory" in msg.lower():
                msg = "The GPU ran out of memory. Close other GPU apps or choose fewer analysis views."
            with self._lock:
                self._finish(job, "error", "Failed", msg)
        finally:
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        if self.get(job.id) is None:  # deleted while running
            shutil.rmtree(job.workdir, ignore_errors=True)

    # ------------------------------------------------------------------ helpers
    def _bump(self, job: Job) -> None:  # caller holds the lock
        job.version += 1
        self._changed.notify_all()

    def _finish(self, job: Job, status: str, message: str, error: str | None = None) -> None:
        job.status, job.message, job.error = status, message, error
        job.progress = 1.0 if status == "done" else job.progress
        job.finished = time.time()
        try:
            job.save()
        except OSError:
            pass
        self._bump(job)

    def _load_history(self) -> None:
        for p in sorted(self.root.glob("*/job.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if d.get("status") not in TERMINAL:
                d["status"], d["message"], d["error"] = "error", "Interrupted", "The app was closed during this conversion."
            job = Job(d["id"], p.parent, d["filename"], d["instrument"], d["engine"],
                      d.get("engine_options", {}), d.get("output_options", {}))
            for k in ("status", "progress", "message", "error", "stats", "created", "finished"):
                setattr(job, k, d.get(k, getattr(job, k)))
            job.input_path = Path(d["input_path"]) if d.get("input_path") else None
            self._jobs[job.id] = job

    def _prune(self) -> None:
        with self._lock:
            done = sorted((j for j in self._jobs.values() if j.status in TERMINAL), key=lambda j: j.created)
            extra = done[: max(0, len(done) - KEEP_JOBS)]
            for j in extra:
                self._jobs.pop(j.id, None)
        for j in extra:
            shutil.rmtree(j.workdir, ignore_errors=True)

