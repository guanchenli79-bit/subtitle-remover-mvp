from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

import storage


@dataclass
class RegionCandidate:
    x: int
    y: int
    width: int
    height: int
    score: float
    frame_index: int
    time_seconds: float


def auto_detect_subtitle_region(video_path: Path, metadata: dict, *, sample_count: int = 10) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Could not open video for subtitle region detection")

    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or metadata.get("width") or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or metadata.get("height") or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or metadata.get("fps") or 25)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or metadata.get("frame_count") or 0)

        if width <= 0 or height <= 0:
            raise RuntimeError("Video dimensions are unavailable")

        frame_indices = _sample_indices(frame_count, sample_count)
        candidates: list[RegionCandidate] = []
        sample_frames: list[dict] = []

        for index in frame_indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = capture.read()
            if not ok:
                continue
            time_seconds = index / fps if fps > 0 else 0.0
            candidate = _detect_frame_region(frame, index, time_seconds)
            preview_url = _write_sample_preview(frame, candidate)
            sample_frames.append(
                {
                    "frame_index": index,
                    "time": round(time_seconds, 3),
                    "preview_url": preview_url,
                    "detected": candidate is not None,
                }
            )
            if candidate is not None:
                candidates.append(candidate)

        if not candidates:
            return _fallback_region(width, height, sample_frames, "未稳定识别到字幕，请切换到手动框选。")

        rect, confidence, reason = _merge_candidates(candidates, width, height, len(frame_indices))
        warning = None
        if confidence < 0.45:
            warning = "自动识别置信度较低，建议手动微调或重新框选。"

        return {
            "recommended_rect": rect,
            "confidence": confidence,
            "sample_frames": sample_frames,
            "reason": reason,
            "warning": warning,
        }
    finally:
        capture.release()


def _sample_indices(frame_count: int, sample_count: int) -> list[int]:
    if frame_count <= 1:
        return [0]
    anchor_ratios = [0.15, 0.22, 0.32, 0.40, 0.50, 0.62, 0.70, 0.78, 0.90, 0.96]
    ratios = anchor_ratios[: max(8, min(12, sample_count))]
    return sorted({min(frame_count - 1, max(0, int(frame_count * ratio))) for ratio in ratios})


def _detect_frame_region(frame: np.ndarray, frame_index: int, time_seconds: float) -> RegionCandidate | None:
    height, width = frame.shape[:2]
    mask = _text_candidate_mask(frame)
    boxes = _component_boxes(mask, width, height)
    if not boxes:
        return None

    bands = _group_boxes_into_bands(boxes, width, height)
    if not bands:
        return None

    band = max(bands, key=lambda item: item["score"])
    if band["height"] > height * 0.24 or band["width"] > width * 0.96:
        return None

    return RegionCandidate(
        x=int(band["x"]),
        y=int(band["y"]),
        width=int(band["width"]),
        height=int(band["height"]),
        score=float(band["score"]),
        frame_index=frame_index,
        time_seconds=time_seconds,
    )


def _text_candidate_mask(frame: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(gray)

    white = cv2.inRange(hsv, np.array([0, 0, 170], dtype=np.uint8), np.array([180, 120, 255], dtype=np.uint8))
    yellow = cv2.inRange(hsv, np.array([14, 35, 120], dtype=np.uint8), np.array([52, 255, 255], dtype=np.uint8))
    _, bright = cv2.threshold(clahe, 172, 255, cv2.THRESH_BINARY)
    edges = cv2.Canny(clahe, 48, 150)
    edge_near_text = cv2.bitwise_and(
        cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1),
        cv2.dilate(cv2.bitwise_or(white, yellow), cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)), iterations=1),
    )

    mask = cv2.bitwise_or(cv2.bitwise_or(white, yellow), bright)
    mask = cv2.bitwise_or(mask, edge_near_text)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2)), iterations=1)
    return mask


def _component_boxes(mask: np.ndarray, width: int, height: int) -> list[dict[str, int]]:
    boxes: list[dict[str, int]] = []
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    frame_area = max(1, width * height)
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        if area < max(3, frame_area * 0.000003):
            continue
        if area > frame_area * 0.025:
            continue
        if w <= 1 or h <= 1:
            continue
        aspect = w / max(1, h)
        density = area / max(1, w * h)
        if aspect < 0.06 or aspect > 18:
            continue
        if density < 0.02 or density > 0.9:
            continue
        if h > height * 0.12 or w > width * 0.78:
            continue
        boxes.append({"x": int(x), "y": int(y), "width": int(w), "height": int(h), "area": int(area)})
    return boxes


def _group_boxes_into_bands(boxes: list[dict[str, int]], width: int, height: int) -> list[dict[str, float]]:
    sorted_boxes = sorted(boxes, key=lambda box: box["y"] + box["height"] / 2)
    bands: list[list[dict[str, int]]] = []
    for box in sorted_boxes:
        center_y = box["y"] + box["height"] / 2
        placed = False
        for band in bands:
            band_center = np.median([item["y"] + item["height"] / 2 for item in band])
            band_height = np.median([item["height"] for item in band])
            if abs(center_y - band_center) <= max(18, band_height * 2.8):
                band.append(box)
                placed = True
                break
        if not placed:
            bands.append([box])

    result: list[dict[str, float]] = []
    for band in bands:
        if len(band) < 2:
            continue
        x1 = min(item["x"] for item in band)
        y1 = min(item["y"] for item in band)
        x2 = max(item["x"] + item["width"] for item in band)
        y2 = max(item["y"] + item["height"] for item in band)
        band_width = x2 - x1
        band_height = y2 - y1
        if band_width < width * 0.10 or band_height < 6:
            continue
        horizontal_span = band_width / max(1, width)
        row_position = (y1 + band_height / 2) / max(1, height)
        bottom_prior = 1.18 if row_position > 0.55 else 1.0
        middle_penalty = 0.86 if 0.28 < row_position < 0.55 else 1.0
        density_score = sum(item["area"] for item in band) / max(1, band_width * band_height)
        score = (len(band) * 0.13 + horizontal_span + density_score * 1.6) * bottom_prior * middle_penalty
        result.append({"x": x1, "y": y1, "width": band_width, "height": band_height, "score": float(score)})
    return result


def _merge_candidates(candidates: list[RegionCandidate], width: int, height: int, attempted_samples: int) -> tuple[dict, float, str]:
    clusters: list[list[RegionCandidate]] = []
    for candidate in sorted(candidates, key=lambda item: item.y + item.height / 2):
        center = candidate.y + candidate.height / 2
        placed = False
        for cluster in clusters:
            cluster_center = np.median([item.y + item.height / 2 for item in cluster])
            if abs(center - cluster_center) <= height * 0.10:
                cluster.append(candidate)
                placed = True
                break
        if not placed:
            clusters.append([candidate])

    best = max(clusters, key=lambda cluster: len(cluster) * 2 + sum(item.score for item in cluster))
    x1 = min(item.x for item in best)
    y1 = min(item.y for item in best)
    x2 = max(item.x + item.width for item in best)
    y2 = max(item.y + item.height for item in best)

    margin_x = int(width * 0.035)
    margin_y = int(height * 0.025)
    x1 = max(0, x1 - margin_x)
    x2 = min(width, x2 + margin_x)
    y1 = max(0, y1 - margin_y)
    y2 = min(height, y2 + margin_y)

    target_min_h = int(height * 0.08)
    target_max_h = int(height * 0.18)
    current_h = y2 - y1
    if current_h < target_min_h:
        pad = (target_min_h - current_h) // 2
        y1 = max(0, y1 - pad)
        y2 = min(height, y2 + pad)
    if y2 - y1 > target_max_h:
        center = int(np.median([item.y + item.height / 2 for item in best]))
        half = target_max_h // 2
        y1 = max(0, center - half)
        y2 = min(height, y1 + target_max_h)
        y1 = max(0, y2 - target_max_h)

    if x2 - x1 < width * 0.42:
        center_x = (x1 + x2) // 2
        half_w = int(width * 0.28)
        x1 = max(0, center_x - half_w)
        x2 = min(width, center_x + half_w)

    rect = {"x": int(x1), "y": int(y1), "width": int(x2 - x1), "height": int(y2 - y1)}
    stability = len(best) / max(1, attempted_samples)
    score = float(np.clip(np.mean([item.score for item in best]) / 3.4, 0.0, 1.0))
    confidence = round(float(np.clip(stability * 0.65 + score * 0.35, 0.05, 0.98)), 3)
    reason = f"在 {attempted_samples} 个采样帧中，有 {len(best)} 帧出现稳定横向字幕候选区域。"
    return rect, confidence, reason


def _fallback_region(width: int, height: int, sample_frames: list[dict], warning: str) -> dict:
    rect_h = int(height * 0.16)
    rect_y = int(height * 0.76)
    rect = {
        "x": int(width * 0.08),
        "y": min(height - rect_h, rect_y),
        "width": int(width * 0.84),
        "height": rect_h,
    }
    return {
        "recommended_rect": rect,
        "confidence": 0.18,
        "sample_frames": sample_frames,
        "reason": "未检测到足够稳定的文字候选，已给出常见底部字幕区域作为起点。",
        "warning": warning,
    }


def _write_sample_preview(frame: np.ndarray, candidate: RegionCandidate | None) -> str:
    preview = frame.copy()
    if candidate is not None:
        cv2.rectangle(
            preview,
            (candidate.x, candidate.y),
            (candidate.x + candidate.width, candidate.y + candidate.height),
            (80, 180, 255),
            2,
        )
    name = f"auto_region_{uuid4().hex}.jpg"
    path = storage.preview_path(name)
    cv2.imwrite(str(path), preview, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    return f"/api/preview-file/{name}"
