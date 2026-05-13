from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import UploadFile


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
WORK_DIR = DATA_DIR / "work"
PREVIEW_DIR = DATA_DIR / "previews"

MAX_UPLOAD_SIZE = 500 * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}


class StorageError(ValueError):
    pass


def ensure_dirs() -> None:
    for directory in (UPLOAD_DIR, OUTPUT_DIR, WORK_DIR, PREVIEW_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def sanitize_filename(filename: str) -> str:
    safe = Path(filename).name.strip()
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", safe)
    return safe or "video"


def validate_upload_filename(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise StorageError(f"Unsupported video format. Allowed: {allowed}")
    return ext


def metadata_path(video_id: str) -> Path:
    return UPLOAD_DIR / f"{video_id}.json"


def output_path(job_id: str) -> Path:
    return OUTPUT_DIR / f"{job_id}.mp4"


def preview_path(filename: str) -> Path:
    ensure_dirs()
    return PREVIEW_DIR / filename


def work_path(job_id: str) -> Path:
    return WORK_DIR / job_id


def write_video_metadata(video_id: str, metadata: dict[str, Any]) -> None:
    ensure_dirs()
    metadata_path(video_id).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def read_video_metadata(video_id: str) -> dict[str, Any]:
    path = metadata_path(video_id)
    if not path.exists():
        raise FileNotFoundError(f"Video metadata not found: {video_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def get_upload_path(video_id: str) -> Path:
    metadata = read_video_metadata(video_id)
    path = Path(metadata["path"])
    if not path.exists():
        raise FileNotFoundError(f"Video file not found: {video_id}")
    return path


async def save_upload(upload_file: UploadFile) -> dict[str, Any]:
    ensure_dirs()

    original_filename = sanitize_filename(upload_file.filename or "video")
    ext = validate_upload_filename(original_filename)
    video_id = uuid4().hex
    destination = UPLOAD_DIR / f"{video_id}{ext}"

    size = 0
    try:
        with destination.open("wb") as out_file:
            while True:
                chunk = await upload_file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise StorageError("Uploaded file exceeds the 500MB limit")
                out_file.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload_file.close()

    return {
        "video_id": video_id,
        "filename": original_filename,
        "path": str(destination),
        "extension": ext,
        "size": size,
    }


def create_work_dir(job_id: str) -> Path:
    ensure_dirs()
    path = work_path(job_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def cleanup_work_dir(job_id: str) -> None:
    shutil.rmtree(work_path(job_id), ignore_errors=True)
