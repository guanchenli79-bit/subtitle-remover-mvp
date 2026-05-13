from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from uuid import uuid4


@dataclass
class JobState:
    job_id: str
    status: str
    step: str
    progress: float
    message: str
    download_url: str | None = None
    engine: str | None = None
    cancel_requested: bool = False


_jobs: dict[str, JobState] = {}
_lock = Lock()


def create_job(message: str = "Waiting to start") -> JobState:
    job_id = uuid4().hex
    job = JobState(
        job_id=job_id,
        status="processing",
        step="uploaded",
        progress=0.0,
        message=message,
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
        if download_url is not None:
            job.download_url = download_url
        if engine is not None:
            job.engine = engine


def request_cancel(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        job.cancel_requested = True
        if job.status == "processing":
            job.message = "Cancel requested"
        return asdict(job)


def is_cancel_requested(job_id: str) -> bool:
    with _lock:
        job = _jobs.get(job_id)
        return bool(job and job.cancel_requested)


def get_job(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return asdict(job)
