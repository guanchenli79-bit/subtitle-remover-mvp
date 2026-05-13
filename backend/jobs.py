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
    warning: str | None = None
    error: str | None = None
    output_url: str | None = None
    download_url: str | None = None
    engine: str | None = None
    cancel_requested: bool = False
    created_at: float = 0.0
    updated_at: float = 0.0
    last_progress_at: float = 0.0


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
        last_progress_at=now,
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
    warning: str | None = None,
    error: str | None = None,
    output_url: str | None = None,
    download_url: str | None = None,
    engine: str | None = None,
) -> None:
    with _lock:
        job = _jobs[job_id]
        now = time()
        previous_frame = job.current_frame
        previous_step = job.step
        previous_progress = job.progress
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
        if warning is not None:
            job.warning = warning
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
        if status == "failed":
            job.warning = None
        if status in {"processing", "completed", "done", "cancelled"}:
            job.error = None
        progressed = (
            (current_frame is not None and job.current_frame != previous_frame)
            or (step is not None and job.step != previous_step)
            or (progress is not None and job.progress > previous_progress)
        )
        if progressed:
            job.last_progress_at = now
            if warning is None:
                job.warning = None
        if status in {"failed", "completed", "done", "cancelled"}:
            job.last_progress_at = now
        job.updated_at = now


def request_cancel(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        job.cancel_requested = True
        if job.status == "processing":
            job.message = "Cancel requested"
            job.warning = "任务正在取消，将在当前处理片段结束后停止。"
            now = time()
            job.updated_at = now
            job.last_progress_at = now
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
        _apply_stall_policy(job)
        return _snapshot(job)


def _snapshot(job: JobState) -> dict:
    payload = asdict(job)
    payload["stage"] = job.step
    payload["output_url"] = job.output_url or job.download_url
    payload["download_url"] = job.download_url or job.output_url
    payload["last_update"] = job.updated_at
    return payload


def _apply_stall_policy(job: JobState) -> None:
    if job.status != "processing":
        return

    now = time()
    stalled_seconds = now - job.last_progress_at
    if stalled_seconds >= 180:
        job.status = "failed"
        job.step = "failed"
        job.cancel_requested = True
        job.error = "处理超过 180 秒无进展，请尝试更短视频或速度优先模式。"
        job.message = job.error
        job.warning = None
        job.updated_at = now
        return

    if stalled_seconds >= 60:
        job.warning = "处理可能卡住，请尝试更短视频或速度优先模式。"
