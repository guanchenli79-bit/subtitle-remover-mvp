from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Literal

import cv2
import numpy as np

import jobs
import storage


InpaintMethod = Literal["TELEA", "NS"]


def probe_video(video_path: Path) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("Could not open uploaded video")

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    capture.release()

    if width <= 0 or height <= 0:
        raise ValueError("Uploaded file is not a readable video")

    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0
    return {
        "width": width,
        "height": height,
        "fps": round(fps, 3) if fps > 0 else 25,
        "duration": round(duration, 3),
        "frame_count": frame_count,
    }


def build_text_mask(
    roi: np.ndarray,
    *,
    threshold: int,
    dilate_iter: int,
) -> np.ndarray:
    threshold = int(np.clip(threshold, 0, 255))
    dilate_iter = int(np.clip(dilate_iter, 0, 8))

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    _, white_mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)

    yellow_min_value = max(90, threshold - 70)
    yellow_mask = cv2.inRange(
        hsv,
        np.array([15, 45, yellow_min_value], dtype=np.uint8),
        np.array([45, 255, 255], dtype=np.uint8),
    )

    edges = cv2.Canny(gray, 60, 180)
    nearby_text = cv2.dilate(
        cv2.bitwise_or(white_mask, yellow_mask),
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        iterations=1,
    )
    edge_mask = cv2.bitwise_and(edges, nearby_text)

    mask = cv2.bitwise_or(cv2.bitwise_or(white_mask, yellow_mask), edge_mask)
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        iterations=1,
    )

    if dilate_iter > 0:
        mask = cv2.dilate(
            mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=dilate_iter,
        )

    return mask


def clip_rect(rect: dict, width: int, height: int) -> tuple[int, int, int, int]:
    x = max(0, min(width - 1, int(round(rect["x"]))))
    y = max(0, min(height - 1, int(round(rect["y"]))))
    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    w = min(w, width - x)
    h = min(h, height - y)
    return x, y, w, h


def mux_audio(original_path: Path, processed_video_path: Path, output_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("FFmpeg was not found in PATH; audio muxing cannot be completed")

    command = [
        ffmpeg,
        "-y",
        "-i",
        str(processed_video_path),
        "-i",
        str(original_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"FFmpeg failed: {detail[-1200:]}")


def process_video(
    *,
    job_id: str,
    video_id: str,
    rect: dict,
    options: dict,
) -> None:
    work_dir: Path | None = None

    try:
        jobs.update_job(job_id, progress=0.01, message="正在读取视频")
        original_path = storage.get_upload_path(video_id)
        metadata = storage.read_video_metadata(video_id)

        capture = cv2.VideoCapture(str(original_path))
        if not capture.isOpened():
            raise RuntimeError("Could not open uploaded video")

        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or metadata["width"])
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or metadata["height"])
        fps = float(capture.get(cv2.CAP_PROP_FPS) or metadata["fps"] or 25)
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or metadata.get("frame_count") or 0)

        x, y, w, h = clip_rect(rect, width, height)
        threshold = int(options.get("threshold", 180))
        dilate_iter = int(options.get("dilate_iter", 2))
        inpaint_radius = int(options.get("inpaint_radius", 3))
        method_name = str(options.get("method", "TELEA")).upper()
        inpaint_method = cv2.INPAINT_NS if method_name == "NS" else cv2.INPAINT_TELEA

        work_dir = storage.create_work_dir(job_id)
        silent_video_path = work_dir / "processed_no_audio.mp4"
        output_path = storage.output_path(job_id)

        writer = cv2.VideoWriter(
            str(silent_video_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (width, height),
        )
        if not writer.isOpened():
            raise RuntimeError("Could not create temporary output video")

        frame_index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            roi = frame[y : y + h, x : x + w]
            mask = build_text_mask(roi, threshold=threshold, dilate_iter=dilate_iter)
            if cv2.countNonZero(mask) > 0:
                repaired_roi = cv2.inpaint(
                    roi,
                    mask,
                    max(1, inpaint_radius),
                    inpaint_method,
                )
                frame[y : y + h, x : x + w] = repaired_roi

            writer.write(frame)
            frame_index += 1

            if frame_index % 5 == 0 or frame_index == total_frames:
                if total_frames > 0:
                    progress = 0.02 + (frame_index / total_frames) * 0.88
                    message = f"已处理 {frame_index}/{total_frames} 帧"
                else:
                    progress = min(0.9, 0.02 + frame_index * 0.002)
                    message = f"已处理 {frame_index} 帧"
                jobs.update_job(job_id, progress=progress, message=message)

        capture.release()
        writer.release()

        if frame_index == 0:
            raise RuntimeError("No frames were decoded from the uploaded video")

        jobs.update_job(job_id, progress=0.93, message="正在合成原音频")
        mux_audio(original_path, silent_video_path, output_path)

        jobs.update_job(
            job_id,
            status="done",
            progress=1.0,
            message="处理完成",
            download_url=f"/api/download/{job_id}",
        )
    except Exception as exc:
        jobs.update_job(
            job_id,
            status="failed",
            progress=0.0,
            message=str(exc),
        )
    finally:
        try:
            capture.release()  # type: ignore[name-defined]
        except Exception:
            pass
        try:
            writer.release()  # type: ignore[name-defined]
        except Exception:
            pass
        if work_dir is not None:
            storage.cleanup_work_dir(job_id)
