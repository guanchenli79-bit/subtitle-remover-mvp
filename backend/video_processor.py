from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

import jobs
import storage
from inpaint_engines import choose_engine, get_engine_capabilities, repair_frame, repair_video
from mask_detector import MaskDetectionResult, detect_subtitle_mask, mask_to_full_frame


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


def engine_status_for_mode(mode: str) -> dict:
    return {
        "requested_mode": mode,
        "actual_engine": choose_engine(mode),
        "capabilities": get_engine_capabilities(),
    }


def process_video(
    *,
    job_id: str,
    video_id: str,
    rect: dict,
    options: dict,
) -> None:
    work_dir: Path | None = None

    try:
        jobs.update_job(
            job_id,
            step="probing",
            progress=0.03,
            message="读取视频",
            engine=choose_engine(options.get("repair_mode", "balanced")),
        )
        original_path = storage.get_upload_path(video_id)
        metadata = storage.read_video_metadata(video_id)
        capture = cv2.VideoCapture(str(original_path))
        if not capture.isOpened():
            raise RuntimeError("Could not open uploaded video")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or metadata["fps"] or 25)
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or metadata.get("frame_count") or 0)
        frames: list[np.ndarray] = []
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frames.append(frame)
        capture.release()

        if not frames:
            raise RuntimeError("No frames were decoded from the uploaded video")

        mode = str(options.get("repair_mode", "balanced")).lower()
        keep_audio = bool(options.get("keep_audio", True))
        work_dir = storage.create_work_dir(job_id)

        masks: list[np.ndarray] = []
        detections: list[MaskDetectionResult] = []
        total = max(1, len(frames))
        reference_mask: np.ndarray | None = None
        jobs.update_job(job_id, step="detecting_masks", progress=0.08, message="生成字幕 mask")
        for index, frame in enumerate(frames):
            if jobs.is_cancel_requested(job_id):
                _mark_cancelled(job_id)
                return
            detection = detect_subtitle_mask(
                frame,
                rect,
                detection_sensitivity=float(options.get("detection_sensitivity", 0.62)),
                min_component_area=int(options.get("min_component_area", 4)),
                max_component_area=int(options.get("max_component_area", 5000)),
                mask_dilate=int(options.get("mask_dilate", 4)),
                temporal_window=int(options.get("temporal_window", 3)),
                feather_radius=int(options.get("feather_radius", 3)),
                reference_mask=reference_mask,
            )
            reference_mask = detection.binary_mask if detection.mask_coverage >= 0.01 else reference_mask
            full_mask = mask_to_full_frame(detection.binary_mask, rect, frame.shape)
            masks.append(full_mask)
            detections.append(detection)
            if index % 5 == 0 or index == len(frames) - 1:
                jobs.update_job(
                    job_id,
                    step="detecting_masks",
                    progress=0.08 + (index + 1) / total * 0.38,
                    message=f"生成字幕 mask {index + 1}/{total}",
                )

        if jobs.is_cancel_requested(job_id):
            _mark_cancelled(job_id)
            return

        output_path = storage.output_path(job_id)

        def progress_callback(step: str, progress: float, message: str) -> None:
            jobs.update_job(job_id, step=step, progress=progress, message=message)

        result = repair_video(
            input_path=original_path,
            output_path=output_path,
            frames=frames,
            mask_sequence=masks,
            fps=fps,
            mode=mode,
            keep_audio=keep_audio,
            options=options,
            work_dir=work_dir,
            progress_callback=progress_callback,
        )

        avg_coverage = sum(item.mask_coverage for item in detections) / max(1, len(detections))
        jobs.update_job(
            job_id,
            status="done",
            step="completed",
            progress=1.0,
            message=f"输出完成，实际引擎：{result.engine}，平均 mask 覆盖率 {avg_coverage:.2%}",
            download_url=f"/api/download/{job_id}",
            engine=result.engine,
        )
    except Exception as exc:
        jobs.update_job(
            job_id,
            status="failed",
            step="failed",
            progress=0.0,
            message=str(exc),
        )
    finally:
        if work_dir is not None:
            storage.cleanup_work_dir(job_id)


def preview_mask(
    *,
    video_id: str,
    time_seconds: float,
    rect: dict,
    options: dict,
) -> dict:
    frame = read_frame_at_time(storage.get_upload_path(video_id), time_seconds)
    detection = detect_subtitle_mask(
        frame,
        rect,
        detection_sensitivity=float(options.get("detection_sensitivity", 0.62)),
        min_component_area=int(options.get("min_component_area", 4)),
        max_component_area=int(options.get("max_component_area", 5000)),
        mask_dilate=int(options.get("mask_dilate", 4)),
        temporal_window=int(options.get("temporal_window", 3)),
        feather_radius=int(options.get("feather_radius", 3)),
    )
    mask_name = f"mask_{uuid4().hex}.png"
    debug_name = f"mask_debug_{uuid4().hex}.jpg"
    mask_path = storage.preview_path(mask_name)
    debug_path = storage.preview_path(debug_name)
    transparent = np.zeros((frame.shape[0], frame.shape[1], 4), dtype=np.uint8)
    full_mask = mask_to_full_frame(detection.binary_mask, rect, frame.shape)
    transparent[:, :, 2] = 255
    transparent[:, :, 3] = np.clip(full_mask.astype(np.float32) * 0.62, 0, 255).astype(np.uint8)
    cv2.imwrite(str(mask_path), transparent)
    cv2.imwrite(str(debug_path), detection.debug_overlay, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return {
        "mask_preview_url": f"/api/preview-file/{mask_name}",
        "debug_overlay_url": f"/api/preview-file/{debug_name}",
        "mask_coverage": detection.mask_coverage,
        "components_count": len(detection.component_boxes),
        "warning": detection.warning,
        "components": detection.component_boxes,
    }


def preview_repair_frame(
    *,
    video_id: str,
    time_seconds: float,
    rect: dict,
    options: dict,
) -> dict:
    video_path = storage.get_upload_path(video_id)
    frame = read_frame_at_time(video_path, time_seconds)
    prev_frame = read_frame_at_time(video_path, max(0.0, time_seconds - 0.2))
    next_frame = read_frame_at_time(video_path, time_seconds + 0.2)
    detection = detect_subtitle_mask(
        frame,
        rect,
        detection_sensitivity=float(options.get("detection_sensitivity", 0.62)),
        min_component_area=int(options.get("min_component_area", 4)),
        max_component_area=int(options.get("max_component_area", 5000)),
        mask_dilate=int(options.get("mask_dilate", 4)),
        temporal_window=int(options.get("temporal_window", 3)),
        feather_radius=int(options.get("feather_radius", 3)),
    )
    mask = mask_to_full_frame(detection.binary_mask, rect, frame.shape)
    repaired, engine = repair_frame(
        frame,
        mask,
        previous_frame=prev_frame,
        next_frame=next_frame,
        mode=str(options.get("repair_mode", "balanced")),
        options=options,
    )
    before_name = f"repair_before_{uuid4().hex}.jpg"
    after_name = f"repair_after_{uuid4().hex}.jpg"
    before_path = storage.preview_path(before_name)
    after_path = storage.preview_path(after_name)
    cv2.imwrite(str(before_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    cv2.imwrite(str(after_path), repaired, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    return {
        "before_url": f"/api/preview-file/{before_name}",
        "after_url": f"/api/preview-file/{after_name}",
        "mask_coverage": detection.mask_coverage,
        "components_count": len(detection.component_boxes),
        "warning": detection.warning,
        "engine": engine,
    }


def read_frame_at_time(video_path: Path, time_seconds: float) -> np.ndarray:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Could not open video")
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 25)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        target = int(max(0.0, time_seconds) * fps)
        if frame_count > 0:
            target = min(target, frame_count - 1)
        capture.set(cv2.CAP_PROP_POS_FRAMES, target)
        ok, frame = capture.read()
        if not ok:
            raise RuntimeError("Could not decode preview frame")
        return frame
    finally:
        capture.release()


def _mark_cancelled(job_id: str) -> None:
    jobs.update_job(
        job_id,
        status="cancelled",
        step="cancelled",
        progress=0.0,
        message="任务已取消",
    )
