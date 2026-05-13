from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from time import time
from uuid import uuid4


@dataclass
class JobState:
    job_id: str
    status: str
    step: str
    progress: float
    message: str
    current_frame: int = 0
    total_frames: int = 0
    error: str | None = None
    output_url: str | None = None
    download_url: str | None = None
    engine: str | None = None
    cancel_requested: bool = False
    created_at: float = 0.0
    updated_at: float = 0.0


_jobs: dict[str, JobState] = {}
_lock = Lock()


def create_job(message: str = "Waiting to start") -> JobState:
    job_id = uuid4().hex
    now = time()
    job = JobState(
        job_id=job_id,
        status="processing",
        step="uploaded",
        progress=0.0,
        message=message,
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _jobs[job_id] = job
    return job


def update_job(
    job_id: str,
    *,
    status: str | None = None,
    step: str | None = None,
    progress: float | None = None,
    message: str | None = None,
    current_frame: int | None = None,
    total_frames: int | None = None,
    error: str | None = None,
    output_url: str | None = None,
    download_url: str | None = None,
    engine: str | None = None,
) -> None:
    with _lock:
        job = _jobs[job_id]
        if status is not None:
            job.status = status
        if step is not None:
            job.step = step
        if progress is not None:
            job.progress = max(0.0, min(1.0, progress))
        if message is not None:
            job.message = message
        if current_frame is not None:
            job.current_frame = max(0, current_frame)
        if total_frames is not None:
            job.total_frames = max(0, total_frames)
        if error is not None:
            job.error = error
        if output_url is not None:
            job.output_url = output_url
            job.download_url = output_url
        if download_url is not None:
            job.download_url = download_url
            job.output_url = download_url
        if engine is not None:
            job.engine = engine
        if status == "failed" and job.error is None:
            job.error = job.message
        if status in {"processing", "completed", "done", "cancelled"}:
            job.error = None
        job.updated_at = time()


def request_cancel(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        job.cancel_requested = True
        if job.status == "processing":
            job.message = "Cancel requested"
            job.updated_at = time()
        return _snapshot(job)


def is_cancel_requested(job_id: str) -> bool:
    with _lock:
        job = _jobs.get(job_id)
        return bool(job and job.cancel_requested)


def get_job(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return _snapshot(job)


def _snapshot(job: JobState) -> dict:
    payload = asdict(job)
    payload["stage"] = job.step
    payload["output_url"] = job.output_url or job.download_url
    payload["download_url"] = job.download_url or job.output_url
    return payload
