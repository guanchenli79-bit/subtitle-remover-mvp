from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import jobs
import storage
from video_processor import probe_video, process_video


app = FastAPI(title="Video Subtitle Remover MVP")

configured_cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins
    or [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"(http://(localhost|127\.0\.0\.1):\d+|https://.*\.up\.railway\.app)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Rect(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class ProcessOptions(BaseModel):
    threshold: int = Field(default=180, ge=0, le=255)
    dilate_iter: int | None = Field(default=None, ge=0, le=8)
    inpaint_radius: int | None = Field(default=None, ge=1, le=20)
    method: Literal["TELEA", "NS"] = "TELEA"
    inpaint_strength: Literal["low", "medium", "high"] = "medium"
    mask_dilate: int | None = Field(default=None, ge=0, le=30)
    feather_radius: int = Field(default=6, ge=0, le=20)
    keep_audio: bool = True


class ProcessRequest(BaseModel):
    video_id: str
    rect: Rect | None = None
    x: int | None = Field(default=None, ge=0)
    y: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    video_width: int | None = Field(default=None, gt=0)
    video_height: int | None = Field(default=None, gt=0)
    inpaint_strength: Literal["low", "medium", "high"] | None = None
    mask_dilate: int | None = Field(default=None, ge=0, le=30)
    feather_radius: int | None = Field(default=None, ge=0, le=20)
    keep_audio: bool | None = None
    options: ProcessOptions = Field(default_factory=ProcessOptions)


@app.on_event("startup")
def on_startup() -> None:
    storage.ensure_dirs()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_video(request: Request, file: UploadFile = File(...)) -> dict:
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > storage.MAX_UPLOAD_SIZE + 1024 * 1024:
        raise HTTPException(status_code=413, detail="Uploaded file exceeds the 500MB limit")

    try:
        saved = await storage.save_upload(file)
        video_info = probe_video(Path(saved["path"]))
    except storage.StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if "saved" in locals():
            Path(saved["path"]).unlink(missing_ok=True)
            storage.metadata_path(saved["video_id"]).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    metadata = {
        **saved,
        **video_info,
    }
    storage.write_video_metadata(saved["video_id"], metadata)

    return {
        "video_id": saved["video_id"],
        "filename": saved["filename"],
        "size": saved["size"],
        "extension": saved["extension"],
        "width": video_info["width"],
        "height": video_info["height"],
        "video_width": video_info["width"],
        "video_height": video_info["height"],
        "duration": video_info["duration"],
        "fps": video_info["fps"],
    }


@app.get("/api/video/{video_id}")
def preview_video(video_id: str) -> FileResponse:
    try:
        path = storage.get_upload_path(video_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Video not found") from exc
    return FileResponse(path)


@app.post("/api/process")
def process(request: ProcessRequest, background_tasks: BackgroundTasks) -> dict:
    try:
        metadata = storage.read_video_metadata(request.video_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Video not found") from exc

    rect = resolve_process_rect(request)
    if rect.x >= metadata["width"] or rect.y >= metadata["height"]:
        raise HTTPException(status_code=400, detail="Rect is outside video bounds")

    options = request.options.model_dump()
    for field_name in ("inpaint_strength", "mask_dilate", "feather_radius", "keep_audio"):
        value = getattr(request, field_name)
        if value is not None:
            options[field_name] = value

    job = jobs.create_job("视频已上传，等待读取", status="uploaded")
    background_tasks.add_task(
        process_video,
        job_id=job.job_id,
        video_id=request.video_id,
        rect=rect.model_dump(),
        options=options,
    )
    return {"job_id": job.job_id, "status": job.status}


@app.get("/api/progress/{job_id}")
def progress(job_id: str) -> dict:
    try:
        job = jobs.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc
    return {
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
        "download_url": job["download_url"],
    }


@app.post("/api/cancel/{job_id}")
def cancel(job_id: str) -> dict:
    try:
        job = jobs.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc

    if job["status"] in {"completed", "done", "failed", "canceled"}:
        return job

    jobs.update_job(job_id, status="canceled", message="任务已取消")
    return jobs.get_job(job_id)


@app.get("/api/download/{job_id}")
def download(job_id: str) -> FileResponse:
    try:
        job = jobs.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc

    if job["status"] not in {"completed", "done"}:
        raise HTTPException(status_code=409, detail="Job is not complete")

    path = storage.output_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"subtitle_removed_{job_id}.mp4",
    )


def resolve_process_rect(request: ProcessRequest) -> Rect:
    if request.rect is not None:
        return request.rect

    if None in (request.x, request.y, request.width, request.height):
        raise HTTPException(status_code=400, detail="Rect coordinates are required")

    return Rect(
        x=int(request.x),
        y=int(request.y),
        width=int(request.width),
        height=int(request.height),
    )


FRONTEND_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "out"
if FRONTEND_DIST_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=FRONTEND_DIST_DIR, html=True),
        name="frontend",
    )
