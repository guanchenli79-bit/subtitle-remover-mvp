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
InpaintStrength = Literal["low", "medium", "high"]

STRENGTH_RADIUS: dict[str, int] = {
    "low": 2,
    "medium": 3,
    "high": 5,
}

FALLBACK_ALPHA: dict[str, float] = {
    "low": 0.18,
    "medium": 0.28,
    "high": 0.4,
}


class ProcessingCanceled(RuntimeError):
    pass


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
    mask_dilate: int,
) -> np.ndarray:
    if roi.size == 0:
        return np.zeros((0, 0), dtype=np.uint8)

    threshold = int(np.clip(threshold, 0, 255))
    mask_dilate = int(np.clip(mask_dilate, 0, 30))

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    _, bright_mask = cv2.threshold(blur, threshold, 255, cv2.THRESH_BINARY)
    white_mask = cv2.inRange(
        hsv,
        np.array([0, 0, max(145, threshold - 35)], dtype=np.uint8),
        np.array([179, 96, 255], dtype=np.uint8),
    )
    yellow_mask = cv2.inRange(
        hsv,
        np.array([15, 45, max(90, threshold - 80)], dtype=np.uint8),
        np.array([45, 255, 255], dtype=np.uint8),
    )

    edges = cv2.Canny(blur, 48, 150)
    edge_band = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)

    adaptive_text = np.zeros_like(gray)
    dark_adaptive_text = np.zeros_like(gray)
    min_dim = min(gray.shape[:2])
    if min_dim >= 3:
        block_size = min(41, min_dim if min_dim % 2 == 1 else min_dim - 1)
        block_size = max(3, block_size)
        adaptive = cv2.adaptiveThreshold(
            blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            block_size,
            -2,
        )
        dark_adaptive = cv2.adaptiveThreshold(
            blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            block_size,
            4,
        )
        adaptive_text = cv2.bitwise_and(adaptive, edge_band)
        dark_adaptive_text = cv2.bitwise_and(dark_adaptive, edge_band)

    text_seed = cv2.bitwise_or(cv2.bitwise_or(bright_mask, white_mask), yellow_mask)
    nearby_text = cv2.dilate(text_seed, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)), iterations=1)
    edge_mask = cv2.bitwise_and(edges, nearby_text)

    mask = cv2.bitwise_or(text_seed, adaptive_text)
    mask = cv2.bitwise_or(mask, dark_adaptive_text)
    mask = cv2.bitwise_or(mask, edge_mask)
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        iterations=1,
    )
    mask = filter_text_components(mask, roi.shape[:2])

    if mask_dilate > 0 and cv2.countNonZero(mask) > 0:
        kernel_size = mask_dilate * 2 + 1
        mask = cv2.dilate(
            mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size)),
            iterations=1,
        )

    return mask


def filter_text_components(mask: np.ndarray, roi_shape: tuple[int, int]) -> np.ndarray:
    if cv2.countNonZero(mask) == 0:
        return mask

    roi_height, roi_width = roi_shape
    roi_area = max(1, roi_height * roi_width)
    min_area = max(3, int(roi_area * 0.000015))
    max_area = max(32, int(roi_area * 0.32))

    label_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)

    for label in range(1, label_count):
        x, y, width, height, area = stats[label]
        if area < min_area or area > max_area:
            continue
        if width > roi_width * 0.98 and height > roi_height * 0.9:
            continue
        fill_ratio = area / max(1, width * height)
        if fill_ratio > 0.92 and area > roi_area * 0.015:
            continue
        clean[labels == label] = 255

    return clean if cv2.countNonZero(clean) > 0 else mask


def repair_roi(
    roi: np.ndarray,
    mask: np.ndarray,
    *,
    inpaint_radius: int,
    feather_radius: int,
    inpaint_method: int,
    blend_alpha: float = 1.0,
) -> np.ndarray:
    if roi.size == 0 or mask.size == 0 or cv2.countNonZero(mask) == 0:
        return roi

    inpaint_radius = int(np.clip(inpaint_radius, 1, 20))
    feather_radius = int(np.clip(feather_radius, 0, 20))
    blend_alpha = float(np.clip(blend_alpha, 0.0, 1.0))

    repaired = cv2.inpaint(roi, mask, inpaint_radius, inpaint_method)
    if feather_radius > 0:
        kernel_size = feather_radius * 2 + 1
        blurred = cv2.GaussianBlur(mask, (kernel_size, kernel_size), 0)
        alpha = np.maximum(mask, blurred).astype(np.float32) / 255.0
    else:
        alpha = (mask > 0).astype(np.float32)

    alpha = np.clip(alpha * blend_alpha, 0.0, 1.0)[..., None]
    blended = repaired.astype(np.float32) * alpha + roi.astype(np.float32) * (1.0 - alpha)
    return np.clip(blended, 0, 255).astype(np.uint8)


def clip_rect(rect: dict, width: int, height: int) -> tuple[int, int, int, int]:
    x = max(0, min(width - 1, int(round(rect["x"]))))
    y = max(0, min(height - 1, int(round(rect["y"]))))
    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    w = min(w, width - x)
    h = min(h, height - y)
    return x, y, w, h


def mux_audio(original_path: Path, processed_video_path: Path, output_path: Path, *, keep_audio: bool) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("FFmpeg was not found in PATH; audio muxing cannot be completed")

    video_args = [
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]

    if keep_audio:
        command = [
            ffmpeg,
            "-y",
            "-i",
            str(processed_video_path),
            "-i",
            str(original_path),
            *video_args,
            "-map",
            "1:a?",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            str(output_path),
        ]
    else:
        command = [
            ffmpeg,
            "-y",
            "-i",
            str(processed_video_path),
            *video_args,
            "-an",
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
    capture: cv2.VideoCapture | None = None
    writer: cv2.VideoWriter | None = None

    try:
        jobs.update_job(job_id, status="probing", progress=0.03, message="正在读取视频信息")
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
        threshold = int(options.get("threshold") or 180)
        legacy_dilate = options.get("dilate_iter")
        mask_dilate = options.get("mask_dilate")
        if mask_dilate is None:
            mask_dilate = int(legacy_dilate) * 3 if legacy_dilate is not None else 8
        mask_dilate = int(np.clip(mask_dilate, 0, 30))

        strength = str(options.get("inpaint_strength") or "medium").lower()
        if strength not in STRENGTH_RADIUS:
            strength = "medium"

        inpaint_radius = options.get("inpaint_radius")
        inpaint_radius = int(inpaint_radius) if inpaint_radius is not None else STRENGTH_RADIUS[strength]
        feather_radius = int(options.get("feather_radius") if options.get("feather_radius") is not None else 6)
        keep_audio = bool(options.get("keep_audio", True))
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

        jobs.update_job(job_id, status="processing_frames", progress=0.1, message="开始逐帧处理")
        frame_index = 0
        fallback_frames = 0
        min_mask_pixels = max(5, int(w * h * 0.0002))

        while True:
            if is_canceled(job_id):
                raise ProcessingCanceled("任务已取消")

            ok, frame = capture.read()
            if not ok:
                break

            roi = frame[y : y + h, x : x + w]
            mask = build_text_mask(roi, threshold=threshold, mask_dilate=mask_dilate)
            use_fallback = cv2.countNonZero(mask) < min_mask_pixels

            if use_fallback:
                fallback_frames += 1
                mask = np.full((h, w), 255, dtype=np.uint8)
                repaired_roi = repair_roi(
                    roi,
                    mask,
                    inpaint_radius=max(1, min(2, inpaint_radius)),
                    feather_radius=max(feather_radius, 10),
                    inpaint_method=inpaint_method,
                    blend_alpha=FALLBACK_ALPHA[strength],
                )
            else:
                repaired_roi = repair_roi(
                    roi,
                    mask,
                    inpaint_radius=inpaint_radius,
                    feather_radius=feather_radius,
                    inpaint_method=inpaint_method,
                )

            frame[y : y + h, x : x + w] = repaired_roi
            writer.write(frame)
            frame_index += 1

            if frame_index % 5 == 0 or frame_index == total_frames:
                if total_frames > 0:
                    progress = 0.1 + (frame_index / total_frames) * 0.78
                    message = f"已处理 {frame_index}/{total_frames} 帧"
                else:
                    progress = min(0.88, 0.1 + frame_index * 0.002)
                    message = f"已处理 {frame_index} 帧"
                if fallback_frames:
                    message = f"{message}，{fallback_frames} 帧使用轻度兜底修复"
                jobs.update_job(job_id, status="processing_frames", progress=progress, message=message)

        capture.release()
        writer.release()

        if frame_index == 0:
            raise RuntimeError("No frames were decoded from the uploaded video")

        if is_canceled(job_id):
            raise ProcessingCanceled("任务已取消")

        jobs.update_job(
            job_id,
            status="muxing_audio",
            progress=0.93,
            message="正在合成原音频" if keep_audio else "正在导出 MP4",
        )
        mux_audio(original_path, silent_video_path, output_path, keep_audio=keep_audio)

        jobs.update_job(
            job_id,
            status="completed",
            progress=1.0,
            message="处理完成",
            download_url=f"/api/download/{job_id}",
        )
    except ProcessingCanceled as exc:
        jobs.update_job(
            job_id,
            status="canceled",
            message=str(exc),
        )
    except Exception as exc:
        jobs.update_job(
            job_id,
            status="failed",
            progress=0.0,
            message=str(exc),
        )
    finally:
        if capture is not None:
            capture.release()
        if writer is not None:
            writer.release()
        if work_dir is not None:
            storage.cleanup_work_dir(job_id)


def is_canceled(job_id: str) -> bool:
    try:
        return jobs.get_job(job_id)["status"] == "canceled"
    except KeyError:
        return False
