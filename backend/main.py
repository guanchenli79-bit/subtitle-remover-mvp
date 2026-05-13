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
from video_processor import engine_status_for_mode, preview_mask, preview_repair_frame, probe_video, process_video


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
    video_width: int | None = Field(default=None, gt=0)
    video_height: int | None = Field(default=None, gt=0)


class ProcessOptions(BaseModel):
    threshold: int = Field(default=180, ge=0, le=255)
    dilate_iter: int = Field(default=2, ge=0, le=8)
    inpaint_radius: int | None = Field(default=None, ge=1, le=20)
    inpaint_strength: Literal["low", "medium", "high"] = "medium"
    repair_mode: Literal["fast", "balanced", "high_quality"] = "balanced"
    detection_sensitivity: float = Field(default=0.62, ge=0.15, le=1.0)
    min_component_area: int = Field(default=4, ge=1, le=10000)
    max_component_area: int = Field(default=5000, ge=4, le=250000)
    mask_dilate: int = Field(default=8, ge=0, le=30)
    feather_radius: int = Field(default=4, ge=0, le=20)
    temporal_window: int = Field(default=3, ge=0, le=8)
    use_neighbor_frames: bool = True
    preserve_edges: bool = True
    keep_audio: bool = True
    method: Literal["TELEA", "NS"] = "TELEA"


class ProcessRequest(BaseModel):
    video_id: str
    rect: Rect | None = None
    x: int | None = Field(default=None, ge=0)
    y: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    video_width: int | None = Field(default=None, gt=0)
    video_height: int | None = Field(default=None, gt=0)
    options: ProcessOptions = Field(default_factory=ProcessOptions)

    def normalized_rect(self) -> dict:
        if self.rect is not None:
            payload = self.rect.model_dump(exclude_none=True)
        else:
            if self.x is None or self.y is None or self.width is None or self.height is None:
                raise ValueError("Rect is required")
            payload = {
                "x": self.x,
                "y": self.y,
                "width": self.width,
                "height": self.height,
            }
        if self.video_width is not None:
            payload["video_width"] = self.video_width
        if self.video_height is not None:
            payload["video_height"] = self.video_height
        return payload


class PreviewRequest(ProcessRequest):
    time: float = Field(default=0.0, ge=0)


@app.on_event("startup")
def on_startup() -> None:
    storage.ensure_dirs()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/engine-status")
def engine_status(mode: Literal["fast", "balanced", "high_quality"] = "balanced") -> dict:
    return engine_status_for_mode(mode)


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
        "width": video_info["width"],
        "height": video_info["height"],
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

    try:
        rect = request.normalized_rect()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if rect["x"] >= metadata["width"] or rect["y"] >= metadata["height"]:
        raise HTTPException(status_code=400, detail="Rect is outside video bounds")

    job = jobs.create_job("任务已提交")
    background_tasks.add_task(
        process_video,
        job_id=job.job_id,
        video_id=request.video_id,
        rect=rect,
        options=request.options.model_dump(),
    )
    return {
        "job_id": job.job_id,
        "status": "processing",
        "engine": engine_status_for_mode(request.options.repair_mode)["actual_engine"],
    }


@app.get("/api/progress/{job_id}")
def progress(job_id: str) -> dict:
    try:
        job = jobs.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc
    return {
        "status": job["status"],
        "step": job["step"],
        "progress": job["progress"],
        "message": job["message"],
        "download_url": job["download_url"],
        "engine": job.get("engine"),
    }


@app.post("/api/cancel/{job_id}")
def cancel(job_id: str) -> dict:
    try:
        job = jobs.request_cancel(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc
    return {
        "status": job["status"],
        "step": job["step"],
        "progress": job["progress"],
        "message": job["message"],
        "download_url": job["download_url"],
        "engine": job.get("engine"),
    }


@app.post("/api/preview-mask")
def preview_mask_endpoint(request: PreviewRequest) -> dict:
    try:
        storage.read_video_metadata(request.video_id)
        rect = request.normalized_rect()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Video not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return preview_mask(
        video_id=request.video_id,
        time_seconds=request.time,
        rect=rect,
        options=request.options.model_dump(),
    )


@app.post("/api/preview-repair-frame")
def preview_repair_frame_endpoint(request: PreviewRequest) -> dict:
    try:
        storage.read_video_metadata(request.video_id)
        rect = request.normalized_rect()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Video not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return preview_repair_frame(
        video_id=request.video_id,
        time_seconds=request.time,
        rect=rect,
        options=request.options.model_dump(),
    )


@app.get("/api/preview-file/{filename}")
def preview_file(filename: str) -> FileResponse:
    safe_name = Path(filename).name
    path = storage.preview_path(safe_name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preview file not found")
    return FileResponse(path)


@app.get("/api/download/{job_id}")
def download(job_id: str) -> FileResponse:
    try:
        job = jobs.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc

    if job["status"] != "done":
        raise HTTPException(status_code=409, detail="Job is not complete")

    path = storage.output_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"subtitle_removed_{job_id}.mp4",
    )


FRONTEND_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "out"
if FRONTEND_DIST_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=FRONTEND_DIST_DIR, html=True),
        name="frontend",
    )
