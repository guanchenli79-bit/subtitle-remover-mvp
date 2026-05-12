from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from time import time
from uuid import uuid4


@dataclass
class JobState:
    job_id: str
    status: str
    progress: float
    message: str
    download_url: str | None = None
    stage: str = "upload"
    stage_progress: float = 0.0
    current_frame: int = 0
    total_frames: int = 0
    eta_seconds: float | None = None
    started_at: float = 0.0
    updated_at: float = 0.0


_jobs: dict[str, JobState] = {}
_lock = Lock()


def create_job(message: str = "Waiting to start", status: str = "uploaded") -> JobState:
    job_id = uuid4().hex
    now = time()
    job = JobState(
        job_id=job_id,
        status=status,
        progress=0.0,
        message=message,
        stage=_stage_from_status(status),
        started_at=now,
        updated_at=now,
    )
    with _lock:
        _jobs[job_id] = job
    return job


def update_job(
    job_id: str,
    *,
    status: str | None = None,
    progress: float | None = None,
    message: str | None = None,
    download_url: str | None = None,
    stage: str | None = None,
    stage_progress: float | None = None,
    current_frame: int | None = None,
    total_frames: int | None = None,
    eta_seconds: float | None = None,
) -> None:
    with _lock:
        job = _jobs[job_id]
        if job.status == "canceled" and status != "canceled":
            return
        if status is not None:
            job.status = status
            job.stage = stage or _stage_from_status(status)
        if progress is not None:
            job.progress = max(0.0, min(1.0, progress))
        if message is not None:
            job.message = message
        if download_url is not None:
            job.download_url = download_url
        if stage is not None:
            job.stage = stage
        if stage_progress is not None:
            job.stage_progress = max(0.0, min(1.0, stage_progress))
        if current_frame is not None:
            job.current_frame = max(0, current_frame)
        if total_frames is not None:
            job.total_frames = max(0, total_frames)
        if eta_seconds is not None:
            job.eta_seconds = max(0.0, eta_seconds)
        job.updated_at = time()


def get_job(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return asdict(job)


def _stage_from_status(status: str) -> str:
    aliases = {
        "uploaded": "upload",
        "probing": "analyze",
        "processing": "repair",
        "processing_frames": "repair",
        "muxing_audio": "merge",
        "completed": "done",
        "done": "done",
        "failed": "failed",
        "canceled": "canceled",
    }
    return aliases.get(status, status)
