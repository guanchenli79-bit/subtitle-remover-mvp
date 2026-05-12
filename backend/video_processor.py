from __future__ import annotations

import shutil
import subprocess
from collections import deque
from pathlib import Path
from time import monotonic
from typing import Literal

import cv2
import numpy as np

import jobs
import storage


InpaintMethod = Literal["TELEA", "NS"]
InpaintStrength = Literal["low", "medium", "high"]
RepairMode = Literal["fast", "balanced", "high_quality"]

STRENGTH_RADIUS: dict[str, int] = {
    "low": 2,
    "medium": 3,
    "high": 5,
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
    detection_sensitivity: float,
    min_component_area: int | None,
    max_component_area: int | None,
    mask_dilate: int,
    ocr_confirm: bool,
) -> np.ndarray:
    if roi.size == 0:
        return np.zeros((0, 0), dtype=np.uint8)

    sensitivity = float(np.clip(detection_sensitivity, 0.1, 1.0))
    threshold = int(np.clip(threshold, 0, 255))
    mask_dilate = int(np.clip(mask_dilate, 0, 30))

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0 + sensitivity * 1.8, tileGridSize=(8, 8)).apply(gray)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    bright_threshold = int(np.clip(min(threshold, 226 - sensitivity * 72), 112, 242))
    _, bright_mask = cv2.threshold(blur, bright_threshold, 255, cv2.THRESH_BINARY)
    white_mask = cv2.inRange(
        hsv,
        np.array([0, 0, max(120, bright_threshold - 32)], dtype=np.uint8),
        np.array([179, int(118 - sensitivity * 42), 255], dtype=np.uint8),
    )
    yellow_mask = cv2.inRange(
        hsv,
        np.array([12, 35, max(86, bright_threshold - 88)], dtype=np.uint8),
        np.array([48, 255, 255], dtype=np.uint8),
    )

    min_dim = min(gray.shape[:2])
    adaptive_text = np.zeros_like(gray)
    dark_outline = np.zeros_like(gray)
    if min_dim >= 3:
        block_size = min(45, min_dim if min_dim % 2 == 1 else min_dim - 1)
        block_size = max(3, block_size)
        c_value = int(10 - sensitivity * 8)
        adaptive_text = cv2.adaptiveThreshold(
            blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            block_size,
            c_value,
        )
        dark_outline = cv2.adaptiveThreshold(
            blur,
            255,
            cv2.ADAPTIVE_THRESH_MEAN_C,
            cv2.THRESH_BINARY_INV,
            block_size,
            max(2, c_value + 4),
        )

    low_edge = int(72 - sensitivity * 34)
    high_edge = int(172 - sensitivity * 56)
    edges = cv2.Canny(blur, max(22, low_edge), max(70, high_edge))
    gradient = cv2.morphologyEx(blur, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    _, gradient_mask = cv2.threshold(gradient, int(22 - sensitivity * 10), 255, cv2.THRESH_BINARY)

    text_seed = cv2.bitwise_or(cv2.bitwise_or(bright_mask, white_mask), yellow_mask)
    adaptive_edge = cv2.bitwise_and(adaptive_text, cv2.dilate(edges, kernel(3, "rect"), iterations=1))
    outline_band = cv2.bitwise_and(dark_outline, cv2.dilate(text_seed, kernel(5, "rect"), iterations=1))
    edge_near_text = cv2.bitwise_and(
        cv2.bitwise_or(edges, gradient_mask),
        cv2.dilate(cv2.bitwise_or(text_seed, adaptive_text), kernel(5, "rect"), iterations=1),
    )

    mask = cv2.bitwise_or(text_seed, adaptive_edge)
    mask = cv2.bitwise_or(mask, outline_band)
    mask = cv2.bitwise_or(mask, edge_near_text)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel(3, "rect"), iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel(2, "rect"), iterations=1)
    mask = filter_text_components(
        mask,
        roi.shape[:2],
        sensitivity=sensitivity,
        min_component_area=min_component_area,
        max_component_area=max_component_area,
    )

    if ocr_confirm:
        mask = apply_optional_ocr_support(roi, mask)

    if mask_dilate > 0 and cv2.countNonZero(mask) > 0:
        kernel_size = mask_dilate if mask_dilate % 2 == 1 else mask_dilate + 1
        kernel_size = max(3, kernel_size)
        mask = cv2.dilate(mask, kernel(kernel_size, "ellipse"), iterations=1)

    return mask


def filter_text_components(
    mask: np.ndarray,
    roi_shape: tuple[int, int],
    *,
    sensitivity: float,
    min_component_area: int | None,
    max_component_area: int | None,
) -> np.ndarray:
    if cv2.countNonZero(mask) == 0:
        return mask

    roi_height, roi_width = roi_shape
    roi_area = max(1, roi_height * roi_width)
    min_area = min_component_area or max(3, int(roi_area * (0.00001 + (1.0 - sensitivity) * 0.00003)))
    max_area = max_component_area or max(32, int(roi_area * (0.18 + sensitivity * 0.08)))

    label_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)

    for label in range(1, label_count):
        _, _, width, height, area = stats[label]
        if area < min_area or area > max_area:
            continue
        if width <= 1 or height <= 1:
            continue
        if width > roi_width * 0.98 and height > roi_height * 0.72:
            continue
        fill_ratio = area / max(1, width * height)
        if fill_ratio > 0.9 and area > roi_area * 0.01:
            continue
        clean[labels == label] = 255

    if cv2.countNonZero(clean) == 0:
        return mask
    return clean


def apply_optional_ocr_support(roi: np.ndarray, mask: np.ndarray) -> np.ndarray:
    try:
        import pytesseract  # type: ignore
    except Exception:
        return mask

    try:
        data = pytesseract.image_to_data(roi, output_type=pytesseract.Output.DICT)
    except Exception:
        return mask

    ocr_mask = np.zeros(mask.shape, dtype=np.uint8)
    for index, text in enumerate(data.get("text", [])):
        if not str(text).strip():
            continue
        try:
            confidence = float(data.get("conf", [0])[index])
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 18:
            continue
        x = int(data["left"][index])
        y = int(data["top"][index])
        width = int(data["width"][index])
        height = int(data["height"][index])
        cv2.rectangle(ocr_mask, (x, y), (x + width, y + height), 255, -1)

    if cv2.countNonZero(ocr_mask) == 0:
        return mask

    supported = cv2.bitwise_and(cv2.dilate(mask, kernel(9, "rect"), iterations=1), ocr_mask)
    return cv2.bitwise_or(mask, supported)


def stabilize_temporal_masks(
    raw_masks: list[np.ndarray],
    *,
    temporal_window: int,
    min_mask_pixels: int,
) -> tuple[list[np.ndarray], int]:
    if not raw_masks:
        return [], 0

    window = int(np.clip(temporal_window, 0, 3))
    stabilized: list[np.ndarray] = []
    last_good: np.ndarray | None = None
    hold_frames = 0
    recovered_frames = 0

    for index, current in enumerate(raw_masks):
        start = max(0, index - window)
        end = min(len(raw_masks), index + window + 1)
        neighbors = raw_masks[start:end]
        current_pixels = cv2.countNonZero(current)

        votes = np.zeros(current.shape, dtype=np.uint16)
        for neighbor in neighbors:
            votes += (neighbor > 0).astype(np.uint16)

        vote_threshold = 2 if len(neighbors) >= 3 else 1
        voted = np.where(votes >= vote_threshold, 255, 0).astype(np.uint8)

        if current_pixels >= min_mask_pixels:
            stable = cv2.bitwise_or(current, voted)
            last_good = stable
            hold_frames = window + 1
        elif cv2.countNonZero(voted) >= min_mask_pixels:
            stable = voted
            last_good = stable
            hold_frames = window
            recovered_frames += 1
        elif last_good is not None and hold_frames > 0:
            stable = last_good.copy()
            hold_frames -= 1
            recovered_frames += 1
        else:
            stable = current

        stable = cv2.morphologyEx(stable, cv2.MORPH_CLOSE, kernel(3, "ellipse"), iterations=1)
        stabilized.append(stable)

    return stabilized, recovered_frames


def repair_roi_with_temporal_sources(
    roi: np.ndarray,
    mask: np.ndarray,
    neighbors: list[tuple[np.ndarray, np.ndarray, float]],
    *,
    repair_mode: str,
    inpaint_radius: int,
    feather_radius: int,
    inpaint_method: int,
) -> np.ndarray:
    if roi.size == 0 or mask.size == 0 or cv2.countNonZero(mask) == 0:
        return roi

    mask_bool = mask > 0
    temporal_roi = roi.copy()
    weight_sum = np.zeros(mask.shape, dtype=np.float32)
    accum = np.zeros(roi.shape, dtype=np.float32)

    for neighbor_roi, neighbor_mask, weight in neighbors:
        aligned_roi, map_x, map_y = align_neighbor_to_current(neighbor_roi, roi, repair_mode)
        if map_x is not None and map_y is not None:
            aligned_mask = cv2.remap(neighbor_mask, map_x, map_y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_REFLECT)
        else:
            aligned_mask = neighbor_mask

        valid = mask_bool & (aligned_mask < 16)
        if cv2.countNonZero(valid.astype(np.uint8)) < max(4, int(cv2.countNonZero(mask) * 0.03)):
            continue
        accum[valid] += aligned_roi[valid].astype(np.float32) * weight
        weight_sum[valid] += weight

    temporal_pixels = weight_sum > 0
    if cv2.countNonZero(temporal_pixels.astype(np.uint8)) > 0:
        temporal_roi[temporal_pixels] = np.clip(
            accum[temporal_pixels] / weight_sum[temporal_pixels][..., None],
            0,
            255,
        ).astype(np.uint8)

    remaining_mask = np.where(mask_bool & ~temporal_pixels, 255, 0).astype(np.uint8)
    if cv2.countNonZero(remaining_mask) > 0:
        temporal_roi = cv2.inpaint(
            temporal_roi,
            remaining_mask,
            int(np.clip(inpaint_radius, 1, 20)),
            inpaint_method,
        )

    return feather_blend(roi, temporal_roi, mask, feather_radius)


def align_neighbor_to_current(
    neighbor_roi: np.ndarray,
    current_roi: np.ndarray,
    repair_mode: str,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    if repair_mode == "fast" or neighbor_roi.shape != current_roi.shape:
        return neighbor_roi, None, None

    try:
        neighbor_gray = cv2.cvtColor(neighbor_roi, cv2.COLOR_BGR2GRAY)
        current_gray = cv2.cvtColor(current_roi, cv2.COLOR_BGR2GRAY)
        if repair_mode == "high_quality":
            flow = cv2.calcOpticalFlowFarneback(neighbor_gray, current_gray, None, 0.5, 4, 25, 5, 7, 1.5, 0)
        else:
            flow = cv2.calcOpticalFlowFarneback(neighbor_gray, current_gray, None, 0.5, 3, 17, 3, 5, 1.2, 0)
        height, width = current_gray.shape
        grid_x, grid_y = np.meshgrid(np.arange(width), np.arange(height))
        map_x = (grid_x - flow[..., 0]).astype(np.float32)
        map_y = (grid_y - flow[..., 1]).astype(np.float32)
        aligned = cv2.remap(neighbor_roi, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        return aligned, map_x, map_y
    except Exception:
        return neighbor_roi, None, None


def feather_blend(original: np.ndarray, repaired: np.ndarray, mask: np.ndarray, feather_radius: int) -> np.ndarray:
    feather_radius = int(np.clip(feather_radius, 0, 20))
    if feather_radius > 0:
        blur_size = feather_radius * 2 + 1
        alpha = cv2.GaussianBlur(mask, (blur_size, blur_size), 0).astype(np.float32) / 255.0
        alpha = np.maximum(alpha, (mask > 0).astype(np.float32) * 0.72)
    else:
        alpha = (mask > 0).astype(np.float32)

    alpha = np.clip(alpha, 0.0, 1.0)[..., None]
    blended = repaired.astype(np.float32) * alpha + original.astype(np.float32) * (1.0 - alpha)
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
    started_at = monotonic()

    try:
        jobs.update_job(
            job_id,
            status="analyze",
            progress=0.03,
            stage_progress=0.15,
            message="正在分析视频参数",
        )
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
        repair_mode = str(options.get("repair_mode") or "balanced").lower()
        if repair_mode not in {"fast", "balanced", "high_quality"}:
            repair_mode = "balanced"

        inpaint_radius = options.get("inpaint_radius")
        inpaint_radius = int(inpaint_radius) if inpaint_radius is not None else STRENGTH_RADIUS[strength]
        feather_radius = int(options.get("feather_radius") if options.get("feather_radius") is not None else 8)
        detection_sensitivity = float(options.get("detection_sensitivity") or 0.68)
        temporal_window = int(np.clip(options.get("temporal_window") or 0, 0, 3))
        if repair_mode == "high_quality":
            temporal_window = max(temporal_window, 2)
        elif repair_mode == "fast":
            temporal_window = min(temporal_window, 1)
        min_component_area = options.get("min_component_area")
        max_component_area = options.get("max_component_area")
        keep_audio = bool(options.get("keep_audio", True))
        ocr_confirm = bool(options.get("ocr_confirm", False))
        method_name = str(options.get("method", "TELEA")).upper()
        inpaint_method = cv2.INPAINT_NS if method_name == "NS" else cv2.INPAINT_TELEA

        work_dir = storage.create_work_dir(job_id)
        silent_video_path = work_dir / "processed_no_audio.mp4"
        output_path = storage.output_path(job_id)

        raw_masks: list[np.ndarray] = []
        frame_index = 0
        detected_frames = 0
        min_mask_pixels = max(4, int(w * h * 0.00015))

        jobs.update_job(
            job_id,
            status="detect",
            progress=0.08,
            stage_progress=0.0,
            total_frames=total_frames,
            message="正在检测字幕 mask",
        )
        while True:
            if is_canceled(job_id):
                raise ProcessingCanceled("任务已取消")

            ok, frame = capture.read()
            if not ok:
                break

            roi = frame[y : y + h, x : x + w]
            mask = build_text_mask(
                roi,
                threshold=threshold,
                detection_sensitivity=detection_sensitivity,
                min_component_area=int(min_component_area) if min_component_area is not None else None,
                max_component_area=int(max_component_area) if max_component_area is not None else None,
                mask_dilate=mask_dilate,
                ocr_confirm=ocr_confirm,
            )
            raw_masks.append(mask)
            if cv2.countNonZero(mask) >= min_mask_pixels:
                detected_frames += 1

            frame_index += 1
            if frame_index % 5 == 0 or frame_index == total_frames:
                update_progress(
                    job_id,
                    status="detect",
                    stage_start=0.08,
                    stage_span=0.4,
                    stage_frame=frame_index,
                    total_frames=total_frames,
                    started_at=started_at,
                    message=f"检测字幕 {frame_index}/{total_frames or '?'} 帧，命中 {detected_frames} 帧",
                )

        capture.release()
        capture = None

        if frame_index == 0:
            raise RuntimeError("No frames were decoded from the uploaded video")

        jobs.update_job(
            job_id,
            status="analyze",
            progress=0.5,
            stage_progress=0.75,
            current_frame=frame_index,
            total_frames=frame_index,
            message="正在做时序投票和短暂漏检补偿",
        )
        stable_masks, recovered_frames = stabilize_temporal_masks(
            raw_masks,
            temporal_window=temporal_window,
            min_mask_pixels=min_mask_pixels,
        )

        capture = cv2.VideoCapture(str(original_path))
        if not capture.isOpened():
            raise RuntimeError("Could not reopen uploaded video for repair")

        writer = cv2.VideoWriter(
            str(silent_video_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (width, height),
        )
        if not writer.isOpened():
            raise RuntimeError("Could not create temporary output video")

        jobs.update_job(
            job_id,
            status="repair",
            progress=0.52,
            stage_progress=0.0,
            current_frame=0,
            total_frames=frame_index,
            message="正在使用相邻帧恢复背景",
        )

        lookahead: deque[tuple[int, np.ndarray]] = deque()
        history: deque[tuple[int, np.ndarray]] = deque(maxlen=temporal_window)
        next_index = 0

        def read_next_frame() -> bool:
            nonlocal next_index
            ok, next_frame = capture.read() if capture is not None else (False, None)
            if not ok or next_frame is None:
                return False
            lookahead.append((next_index, next_frame))
            next_index += 1
            return True

        for _ in range(temporal_window + 1):
            if not read_next_frame():
                break

        repaired_frames = 0
        while lookahead:
            if is_canceled(job_id):
                raise ProcessingCanceled("任务已取消")

            current_index, current_frame = lookahead[0]
            original_frame = current_frame.copy()
            current_roi = current_frame[y : y + h, x : x + w]
            current_mask = stable_masks[current_index]

            neighbor_records = build_neighbor_records(
                current_index=current_index,
                history=list(history),
                future=list(lookahead)[1:],
                stable_masks=stable_masks,
                rect=(x, y, w, h),
                repair_mode=repair_mode,
            )
            repaired_roi = repair_roi_with_temporal_sources(
                current_roi,
                current_mask,
                neighbor_records,
                repair_mode=repair_mode,
                inpaint_radius=inpaint_radius,
                feather_radius=feather_radius,
                inpaint_method=inpaint_method,
            )
            current_frame[y : y + h, x : x + w] = repaired_roi
            writer.write(current_frame)

            history.append((current_index, original_frame))
            lookahead.popleft()
            read_next_frame()
            repaired_frames += 1

            if repaired_frames % 5 == 0 or repaired_frames == frame_index:
                update_progress(
                    job_id,
                    status="repair",
                    stage_start=0.52,
                    stage_span=0.38,
                    stage_frame=repaired_frames,
                    total_frames=frame_index,
                    started_at=started_at,
                    message=(
                        f"修复画面 {repaired_frames}/{frame_index} 帧，"
                        f"时序补偿 {recovered_frames} 帧"
                    ),
                )

        capture.release()
        capture = None
        writer.release()
        writer = None

        if is_canceled(job_id):
            raise ProcessingCanceled("任务已取消")

        jobs.update_job(
            job_id,
            status="merge",
            progress=0.94,
            stage_progress=0.25,
            current_frame=frame_index,
            total_frames=frame_index,
            message="正在合成原音频" if keep_audio else "正在导出 MP4",
        )
        mux_audio(original_path, silent_video_path, output_path, keep_audio=keep_audio)

        jobs.update_job(
            job_id,
            status="done",
            progress=1.0,
            stage_progress=1.0,
            current_frame=frame_index,
            total_frames=frame_index,
            eta_seconds=0.0,
            message="处理完成",
            download_url=f"/api/download/{job_id}",
        )
    except ProcessingCanceled as exc:
        jobs.update_job(
            job_id,
            status="canceled",
            stage="canceled",
            message=str(exc),
        )
    except Exception as exc:
        jobs.update_job(
            job_id,
            status="failed",
            progress=0.0,
            stage="failed",
            message=str(exc),
        )
    finally:
        if capture is not None:
            capture.release()
        if writer is not None:
            writer.release()
        if work_dir is not None:
            storage.cleanup_work_dir(job_id)


def build_neighbor_records(
    *,
    current_index: int,
    history: list[tuple[int, np.ndarray]],
    future: list[tuple[int, np.ndarray]],
    stable_masks: list[np.ndarray],
    rect: tuple[int, int, int, int],
    repair_mode: str,
) -> list[tuple[np.ndarray, np.ndarray, float]]:
    x, y, w, h = rect
    if repair_mode == "fast":
        candidates = history[-1:] + future[:1]
    elif repair_mode == "high_quality":
        candidates = history + future
    else:
        candidates = history[-2:] + future[:2]

    records: list[tuple[np.ndarray, np.ndarray, float]] = []
    for neighbor_index, frame in candidates:
        if neighbor_index < 0 or neighbor_index >= len(stable_masks):
            continue
        distance = max(1, abs(neighbor_index - current_index))
        weight = 1.0 / distance
        records.append((frame[y : y + h, x : x + w], stable_masks[neighbor_index], weight))
    return records


def update_progress(
    job_id: str,
    *,
    status: str,
    stage_start: float,
    stage_span: float,
    stage_frame: int,
    total_frames: int,
    started_at: float,
    message: str,
) -> None:
    denominator = max(1, total_frames)
    stage_progress = min(1.0, stage_frame / denominator)
    progress = stage_start + stage_progress * stage_span
    elapsed = max(0.001, monotonic() - started_at)
    eta_seconds = (elapsed / max(progress, 0.001)) * (1.0 - progress)
    jobs.update_job(
        job_id,
        status=status,
        progress=progress,
        stage_progress=stage_progress,
        current_frame=stage_frame,
        total_frames=total_frames,
        eta_seconds=eta_seconds,
        message=message,
    )


def kernel(size: int, shape: Literal["rect", "ellipse"]) -> np.ndarray:
    size = max(1, int(size))
    if shape == "ellipse":
        return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    return cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))


def is_canceled(job_id: str) -> bool:
    try:
        return jobs.get_job(job_id)["status"] == "canceled"
    except KeyError:
        return False
