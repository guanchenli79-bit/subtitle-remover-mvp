from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np


@dataclass
class MaskDetectionResult:
    binary_mask: np.ndarray
    soft_mask: np.ndarray
    debug_overlay: np.ndarray
    component_boxes: list[dict[str, int]]
    mask_coverage: float
    warning: str | None = None


def clip_rect(rect: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    x = max(0, min(width - 1, int(round(rect["x"]))))
    y = max(0, min(height - 1, int(round(rect["y"]))))
    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    return x, y, min(w, width - x), min(h, height - y)


def detect_subtitle_mask(
    frame: np.ndarray,
    rect: dict[str, Any],
    *,
    detection_sensitivity: float = 0.62,
    min_component_area: int = 4,
    max_component_area: int = 5000,
    mask_dilate: int = 4,
    temporal_window: int = 3,
    feather_radius: int = 3,
    reference_mask: np.ndarray | None = None,
) -> MaskDetectionResult:
    height, width = frame.shape[:2]
    x, y, w, h = clip_rect(rect, width, height)
    roi = frame[y : y + h, x : x + w]
    if roi.size == 0:
        empty = np.zeros((0, 0), dtype=np.uint8)
        return MaskDetectionResult(empty, empty, frame.copy(), [], 0.0, "empty_roi")

    sensitivity = float(np.clip(detection_sensitivity, 0.15, 1.0))
    raw_mask = _build_raw_text_mask(roi, sensitivity)
    raw_mask = _morphology_cleanup(raw_mask, sensitivity)
    component_mask, boxes = _filter_components(
        raw_mask,
        min_component_area=max(1, min_component_area),
        max_component_area=max(4, max_component_area),
    )

    if reference_mask is not None and reference_mask.shape == component_mask.shape:
        component_mask = cv2.bitwise_or(component_mask, cv2.bitwise_and(reference_mask, raw_mask))

    component_mask, boxes = _control_coverage(
        roi,
        component_mask,
        boxes,
        sensitivity=sensitivity,
        min_component_area=min_component_area,
        max_component_area=max_component_area,
    )

    if cv2.countNonZero(component_mask) > 0 and mask_dilate > 0:
        dilate_px = int(np.clip(mask_dilate, 0, 30))
        kernel_size = max(3, dilate_px * 2 + 1)
        component_mask = cv2.dilate(
            component_mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size)),
            iterations=1,
        )
        component_mask = _limit_dilate_growth(component_mask, raw_mask, max_coverage=0.28)
        boxes = _boxes_from_mask(component_mask, min_component_area, max_component_area)

    coverage = _coverage(component_mask)
    warning: str | None = None
    if coverage > 0.32:
        component_mask = _shrink_large_mask(component_mask)
        boxes = _boxes_from_mask(component_mask, min_component_area, max_component_area)
        coverage = _coverage(component_mask)
        warning = "当前 mask 过大，可能导致画面模糊，请降低强度或缩小框选范围。"
    elif coverage > 0.25:
        warning = "当前 mask 过大，可能导致画面模糊，请降低强度或缩小框选范围。"
    elif coverage < 0.01:
        retry_mask = _build_raw_text_mask(roi, min(1.0, sensitivity + 0.2))
        retry_mask = _morphology_cleanup(retry_mask, min(1.0, sensitivity + 0.2))
        retry_mask, retry_boxes = _filter_components(
            retry_mask,
            min_component_area=max(1, min_component_area // 2),
            max_component_area=max_component_area,
        )
        if _coverage(retry_mask) > coverage:
            component_mask = retry_mask
            boxes = retry_boxes
            coverage = _coverage(component_mask)
        if coverage < 0.01:
            warning = "字幕识别不足，请提高强度或重新框选。"

    soft_mask = feather_mask(component_mask, feather_radius)
    debug_overlay = draw_debug_overlay(frame, (x, y, w, h), component_mask, boxes)
    translated_boxes = [
        {
            "x": int(box["x"] + x),
            "y": int(box["y"] + y),
            "width": int(box["width"]),
            "height": int(box["height"]),
        }
        for box in boxes
    ]
    return MaskDetectionResult(
        binary_mask=component_mask,
        soft_mask=soft_mask,
        debug_overlay=debug_overlay,
        component_boxes=translated_boxes,
        mask_coverage=coverage,
        warning=warning,
    )


def feather_mask(mask: np.ndarray, feather_radius: int) -> np.ndarray:
    if mask.size == 0:
        return mask
    radius = int(np.clip(feather_radius, 0, 30))
    if radius <= 0:
        return mask.copy()
    kernel_size = radius * 2 + 1
    return cv2.GaussianBlur(mask, (kernel_size, kernel_size), 0)


def mask_to_full_frame(mask: np.ndarray, rect: dict[str, Any], frame_shape: tuple[int, int, int] | tuple[int, int]) -> np.ndarray:
    height, width = frame_shape[:2]
    x, y, w, h = clip_rect(rect, width, height)
    full_mask = np.zeros((height, width), dtype=np.uint8)
    if mask.size:
        full_mask[y : y + h, x : x + w] = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
    return full_mask


def draw_debug_overlay(
    frame: np.ndarray,
    roi_rect: tuple[int, int, int, int],
    mask: np.ndarray,
    boxes: list[dict[str, int]],
) -> np.ndarray:
    overlay = frame.copy()
    x, y, w, h = roi_rect
    if mask.size:
        red = np.zeros((h, w, 3), dtype=np.uint8)
        red[:, :, 2] = 255
        roi = overlay[y : y + h, x : x + w]
        alpha = (mask.astype(np.float32) / 255.0 * 0.55)[..., None]
        overlay[y : y + h, x : x + w] = np.clip(roi * (1.0 - alpha) + red * alpha, 0, 255).astype(np.uint8)
    cv2.rectangle(overlay, (x, y), (x + w, y + h), (80, 180, 255), 2)
    for box in boxes:
        bx, by, bw, bh = box["x"], box["y"], box["width"], box["height"]
        cv2.rectangle(overlay, (x + bx, y + by), (x + bx + bw, y + by + bh), (0, 255, 255), 1)
    return overlay


def _build_raw_text_mask(roi: np.ndarray, sensitivity: float) -> np.ndarray:
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB)
    clahe = cv2.createCLAHE(clipLimit=2.4, tileGridSize=(8, 8)).apply(gray)

    white_v = int(np.interp(sensitivity, [0.15, 1.0], [245, 160]))
    white_s = int(np.interp(sensitivity, [0.15, 1.0], [45, 115]))
    white_mask = cv2.inRange(hsv, np.array([0, 0, white_v], dtype=np.uint8), np.array([180, white_s, 255], dtype=np.uint8))

    yellow_v = int(np.interp(sensitivity, [0.15, 1.0], [205, 110]))
    yellow_s = int(np.interp(sensitivity, [0.15, 1.0], [55, 25]))
    yellow_mask = cv2.inRange(
        hsv,
        np.array([14, yellow_s, yellow_v], dtype=np.uint8),
        np.array([52, 255, 255], dtype=np.uint8),
    )

    highlight_threshold = int(np.interp(sensitivity, [0.15, 1.0], [238, 150]))
    _, gray_highlight = cv2.threshold(clahe, highlight_threshold, 255, cv2.THRESH_BINARY)

    min_dim = min(gray.shape[:2])
    if min_dim >= 3:
        block = _adaptive_block_size(min_dim)
        adaptive = cv2.adaptiveThreshold(
            clahe,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            block,
            int(np.interp(sensitivity, [0.15, 1.0], [-2, -10])),
        )
    else:
        adaptive = np.zeros_like(gray)

    edges = cv2.Canny(clahe, int(np.interp(sensitivity, [0.15, 1.0], [85, 35])), 170)
    edge_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edge_mask = cv2.dilate(edges, edge_kernel, iterations=1)

    dark_outline = cv2.inRange(lab[:, :, 0], 0, int(np.interp(sensitivity, [0.15, 1.0], [55, 105])))
    bright_seed = cv2.bitwise_or(cv2.bitwise_or(white_mask, yellow_mask), gray_highlight)
    outline_near_text = cv2.bitwise_and(dark_outline, cv2.dilate(bright_seed, edge_kernel, iterations=2))
    edge_near_text = cv2.bitwise_and(edge_mask, cv2.dilate(bright_seed, edge_kernel, iterations=2))
    adaptive_near_edges = cv2.bitwise_and(adaptive, cv2.dilate(edge_mask, edge_kernel, iterations=1))

    mask = cv2.bitwise_or(bright_seed, outline_near_text)
    mask = cv2.bitwise_or(mask, edge_near_text)
    mask = cv2.bitwise_or(mask, adaptive_near_edges)
    return mask


def _morphology_cleanup(mask: np.ndarray, sensitivity: float) -> np.ndarray:
    small = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    wide = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2))
    cleaned = cv2.morphologyEx(mask, cv2.MORPH_OPEN, small, iterations=1)
    close_iter = 1 if sensitivity < 0.8 else 2
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, wide, iterations=close_iter)
    return cleaned


def _filter_components(
    mask: np.ndarray,
    *,
    min_component_area: int,
    max_component_area: int,
) -> tuple[np.ndarray, list[dict[str, int]]]:
    height, width = mask.shape[:2]
    roi_area = max(1, height * width)
    max_area = min(max_component_area, int(roi_area * 0.18))
    filtered = np.zeros_like(mask)
    boxes: list[dict[str, int]] = []
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)

    for index in range(1, count):
        x, y, w, h, area = stats[index]
        if area < min_component_area or area > max_area:
            continue
        if w <= 1 or h <= 1:
            continue
        aspect = w / max(1, h)
        density = area / max(1, w * h)
        if aspect > 24 or aspect < 0.05:
            continue
        if density < 0.025 or density > 0.92:
            continue
        if h > height * 0.72 or w > width * 0.92:
            continue
        filtered[labels == index] = 255
        boxes.append({"x": int(x), "y": int(y), "width": int(w), "height": int(h)})

    filtered, boxes = _keep_subtitle_like_rows(filtered, boxes)
    return filtered, boxes


def _keep_subtitle_like_rows(mask: np.ndarray, boxes: list[dict[str, int]]) -> tuple[np.ndarray, list[dict[str, int]]]:
    if len(boxes) <= 1:
        return mask, boxes
    centers = np.array([box["y"] + box["height"] / 2 for box in boxes])
    median = float(np.median(centers))
    heights = np.array([box["height"] for box in boxes])
    tolerance = max(10.0, float(np.median(heights)) * 2.8)
    kept = [box for box in boxes if abs((box["y"] + box["height"] / 2) - median) <= tolerance]
    if not kept:
        return mask, boxes
    row_mask = np.zeros_like(mask)
    for box in kept:
        x, y, w, h = box["x"], box["y"], box["width"], box["height"]
        row_mask[y : y + h, x : x + w] = mask[y : y + h, x : x + w]
    return row_mask, kept


def _control_coverage(
    roi: np.ndarray,
    mask: np.ndarray,
    boxes: list[dict[str, int]],
    *,
    sensitivity: float,
    min_component_area: int,
    max_component_area: int,
) -> tuple[np.ndarray, list[dict[str, int]]]:
    coverage = _coverage(mask)
    if coverage <= 0.45:
        return mask, boxes

    stricter = max(0.15, sensitivity - 0.25)
    retry = _build_raw_text_mask(roi, stricter)
    retry = _morphology_cleanup(retry, stricter)
    retry, retry_boxes = _filter_components(
        retry,
        min_component_area=min_component_area,
        max_component_area=max_component_area,
    )
    if 0 < _coverage(retry) < coverage:
        return retry, retry_boxes
    return _shrink_large_mask(mask), _boxes_from_mask(_shrink_large_mask(mask), min_component_area, max_component_area)


def _limit_dilate_growth(mask: np.ndarray, raw_mask: np.ndarray, *, max_coverage: float) -> np.ndarray:
    if _coverage(mask) <= max_coverage:
        return mask
    limited = cv2.bitwise_and(mask, cv2.dilate(raw_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1))
    return limited if cv2.countNonZero(limited) > 0 else _shrink_large_mask(mask)


def _shrink_large_mask(mask: np.ndarray) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    shrunk = cv2.erode(mask, kernel, iterations=2)
    return shrunk if cv2.countNonZero(shrunk) > 0 else cv2.erode(mask, kernel, iterations=1)


def _boxes_from_mask(mask: np.ndarray, min_component_area: int, max_component_area: int) -> list[dict[str, int]]:
    _, boxes = _filter_components(
        mask,
        min_component_area=min_component_area,
        max_component_area=max_component_area,
    )
    return boxes


def _adaptive_block_size(min_dim: int) -> int:
    if min_dim < 3:
        return 3
    block = min(31, min_dim if min_dim % 2 == 1 else min_dim - 1)
    return max(3, block)


def _coverage(mask: np.ndarray) -> float:
    if mask.size == 0:
        return 0.0
    return float(cv2.countNonZero(mask)) / float(mask.shape[0] * mask.shape[1])
