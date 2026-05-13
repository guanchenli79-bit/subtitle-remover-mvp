from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import cv2
import numpy as np


ProgressCallback = Callable[[str, float, str], None]


@dataclass
class EngineResult:
    engine: str
    requested_mode: str
    output_path: Path
    message: str


def get_engine_capabilities() -> dict:
    propainter_path = Path(os.getenv("PROPAINTER_PATH", "/app/models/propainter"))
    lama_model_path = Path(os.getenv("LAMA_MODEL_PATH", "/app/models/lama"))
    propainter_device = os.getenv("PROPAINTER_DEVICE", "cpu")
    lama_device = os.getenv("LAMA_DEVICE", "cpu")
    propainter_device_available = propainter_device != "cuda" or shutil.which("nvidia-smi") is not None
    lama_device_available = lama_device != "cuda" or shutil.which("nvidia-smi") is not None
    propainter_enabled = _truthy(os.getenv("ENABLE_PROPAINTER", "false")) and propainter_path.exists() and propainter_device_available
    lama_enabled = _truthy(os.getenv("ENABLE_LAMA", "false")) and lama_model_path.exists() and lama_device_available
    return {
        "propainter": {
            "enabled": propainter_enabled,
            "configured": _truthy(os.getenv("ENABLE_PROPAINTER", "false")),
            "path": str(propainter_path),
            "device": propainter_device,
            "device_available": propainter_device_available,
        },
        "lama": {
            "enabled": lama_enabled,
            "configured": _truthy(os.getenv("ENABLE_LAMA", "false")),
            "path": str(lama_model_path),
            "device": lama_device,
            "device_available": lama_device_available,
        },
        "fallback_engine": "Temporal OpenCV",
    }


def choose_engine(mode: str) -> str:
    requested = (mode or "balanced").lower()
    capabilities = get_engine_capabilities()
    if requested == "fast":
        return "OpenCV"
    if requested == "balanced":
        return "Temporal OpenCV"
    if requested == "high_quality":
        if capabilities["propainter"]["enabled"]:
            return "ProPainter"
        if capabilities["lama"]["enabled"]:
            return "LaMa"
        return "Temporal OpenCV"
    return "Temporal OpenCV"


def repair_video(
    *,
    input_path: Path,
    output_path: Path,
    frames: Sequence[np.ndarray],
    mask_sequence: Sequence[np.ndarray],
    fps: float,
    mode: str,
    keep_audio: bool,
    options: dict,
    work_dir: Path,
    progress_callback: ProgressCallback,
) -> EngineResult:
    engine = choose_engine(mode)
    if engine == "ProPainter":
        try:
            return _repair_with_propainter(
                input_path=input_path,
                output_path=output_path,
                frames=frames,
                mask_sequence=mask_sequence,
                fps=fps,
                keep_audio=keep_audio,
                work_dir=work_dir,
                progress_callback=progress_callback,
            )
        except Exception as exc:
            progress_callback("repairing_frames", 0.52, f"ProPainter unavailable, falling back: {exc}")
            engine = "LaMa" if get_engine_capabilities()["lama"]["enabled"] else "Temporal OpenCV"

    if engine == "LaMa":
        try:
            return _repair_with_lama_fallback(
                input_path=input_path,
                output_path=output_path,
                frames=frames,
                mask_sequence=mask_sequence,
                fps=fps,
                keep_audio=keep_audio,
                options=options,
                work_dir=work_dir,
                progress_callback=progress_callback,
            )
        except Exception as exc:
            progress_callback("repairing_frames", 0.56, f"LaMa unavailable, falling back: {exc}")
            engine = "Temporal OpenCV"

    if engine == "OpenCV":
        repaired = repair_frames_fast(frames, mask_sequence, options, progress_callback)
    else:
        repaired = repair_frames_temporal(frames, mask_sequence, options, progress_callback)
        engine = "Temporal OpenCV"

    silent_video = work_dir / "repaired_no_audio.mp4"
    write_frames_to_video(repaired, silent_video, fps)
    mux_audio(input_path, silent_video, output_path, keep_audio=keep_audio)
    return EngineResult(engine=engine, requested_mode=mode, output_path=output_path, message=f"completed with {engine}")


def repair_frame(
    frame: np.ndarray,
    mask: np.ndarray,
    *,
    previous_frame: np.ndarray | None = None,
    next_frame: np.ndarray | None = None,
    mode: str = "balanced",
    options: dict | None = None,
) -> tuple[np.ndarray, str]:
    opts = options or {}
    engine = choose_engine(mode)
    if engine in {"ProPainter", "LaMa"}:
        # The preview path intentionally uses the stable CPU fallback unless optional
        # model inference is explicitly wired for this deployment.
        engine = "Temporal OpenCV"
    if engine == "OpenCV":
        return _opencv_repair(frame, mask, opts), "OpenCV"
    repaired = _temporal_repair_single(frame, mask, previous_frame, next_frame, opts)
    return repaired, "Temporal OpenCV"


def repair_frames_fast(
    frames: Sequence[np.ndarray],
    masks: Sequence[np.ndarray],
    options: dict,
    progress_callback: ProgressCallback,
) -> list[np.ndarray]:
    repaired: list[np.ndarray] = []
    total = max(1, len(frames))
    for index, (frame, mask) in enumerate(zip(frames, masks)):
        repaired.append(_opencv_repair(frame, mask, options))
        if index % 5 == 0:
            progress_callback("repairing_frames", 0.55 + (index / total) * 0.3, f"OpenCV repairing {index + 1}/{total}")
    return repaired


def repair_frames_temporal(
    frames: Sequence[np.ndarray],
    masks: Sequence[np.ndarray],
    options: dict,
    progress_callback: ProgressCallback,
) -> list[np.ndarray]:
    repaired: list[np.ndarray] = []
    total = max(1, len(frames))
    window = int(np.clip(options.get("temporal_window", 3), 0, 8))
    use_neighbors = bool(options.get("use_neighbor_frames", True))
    for index, frame in enumerate(frames):
        mask = masks[index]
        prev_frame = frames[max(0, index - window)] if use_neighbors and window > 0 and index > 0 else None
        next_frame = frames[min(len(frames) - 1, index + window)] if use_neighbors and window > 0 and index < len(frames) - 1 else None
        repaired.append(_temporal_repair_single(frame, mask, prev_frame, next_frame, options))
        if index % 5 == 0:
            progress_callback("repairing_frames", 0.55 + (index / total) * 0.3, f"Temporal repairing {index + 1}/{total}")
    return repaired


def _temporal_repair_single(
    frame: np.ndarray,
    mask: np.ndarray,
    previous_frame: np.ndarray | None,
    next_frame: np.ndarray | None,
    options: dict,
) -> np.ndarray:
    if cv2.countNonZero(mask) == 0:
        return frame.copy()
    candidate = frame.copy()
    contributors: list[np.ndarray] = []
    for neighbor in (previous_frame, next_frame):
        if neighbor is None:
            continue
        aligned = _align_neighbor(frame, neighbor)
        clean_pixels = cv2.bitwise_and(mask, _low_motion_confidence(frame, aligned))
        if cv2.countNonZero(clean_pixels) > 0:
            fill = frame.copy()
            fill[clean_pixels > 0] = aligned[clean_pixels > 0]
            contributors.append(fill)
    if contributors:
        stacked = np.stack(contributors, axis=0).astype(np.float32)
        candidate = np.median(stacked, axis=0).astype(np.uint8)
        candidate[mask == 0] = frame[mask == 0]

    edge_closed = _opencv_repair(candidate, mask, options)
    feather = int(np.clip(options.get("feather_radius", 4), 0, 30))
    alpha = _soft_alpha(mask, feather)
    blended = frame.astype(np.float32) * (1.0 - alpha) + edge_closed.astype(np.float32) * alpha
    return np.clip(blended, 0, 255).astype(np.uint8)


def _opencv_repair(frame: np.ndarray, mask: np.ndarray, options: dict) -> np.ndarray:
    if cv2.countNonZero(mask) == 0:
        return frame.copy()
    strength = str(options.get("inpaint_strength", "medium")).lower()
    radius = int(options.get("inpaint_radius") or {"low": 2, "medium": 4, "high": 7}.get(strength, 4))
    method_name = str(options.get("method", "TELEA")).upper()
    method = cv2.INPAINT_NS if method_name == "NS" else cv2.INPAINT_TELEA
    return cv2.inpaint(frame, mask, max(1, radius), method)


def _align_neighbor(frame: np.ndarray, neighbor: np.ndarray) -> np.ndarray:
    try:
        frame_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        neighbor_gray = cv2.cvtColor(neighbor, cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(neighbor_gray, frame_gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        height, width = frame_gray.shape
        grid_x, grid_y = np.meshgrid(np.arange(width), np.arange(height))
        map_x = (grid_x + flow[..., 0]).astype(np.float32)
        map_y = (grid_y + flow[..., 1]).astype(np.float32)
        return cv2.remap(neighbor, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    except Exception:
        return neighbor


def _low_motion_confidence(frame: np.ndarray, aligned: np.ndarray) -> np.ndarray:
    diff = cv2.absdiff(frame, aligned)
    diff_gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    return cv2.threshold(diff_gray, 42, 255, cv2.THRESH_BINARY_INV)[1]


def _soft_alpha(mask: np.ndarray, feather_radius: int) -> np.ndarray:
    radius = int(np.clip(feather_radius, 0, 30))
    alpha = mask.astype(np.float32) / 255.0
    if radius > 0:
        kernel = radius * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (kernel, kernel), 0)
    return np.clip(alpha[..., None], 0.0, 1.0)


def write_frames_to_video(frames: Sequence[np.ndarray], output_path: Path, fps: float) -> None:
    if not frames:
        raise RuntimeError("No frames to encode")
    height, width = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(output_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Could not create output video writer")
    try:
        for frame in frames:
            writer.write(frame)
    finally:
        writer.release()


def mux_audio(original_path: Path, processed_video_path: Path, output_path: Path, *, keep_audio: bool) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("FFmpeg was not found in PATH; output video cannot be finalized")
    command = [ffmpeg, "-y", "-i", str(processed_video_path)]
    if keep_audio:
        command.extend(["-i", str(original_path), "-map", "0:v:0", "-map", "1:a?"])
    else:
        command.extend(["-map", "0:v:0"])
    command.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"])
    if keep_audio:
        command.extend(["-c:a", "aac", "-b:a", "192k", "-shortest"])
    else:
        command.append("-an")
    command.extend(["-movflags", "+faststart", str(output_path)])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"FFmpeg failed: {detail[-1200:]}")


def _repair_with_propainter(
    *,
    input_path: Path,
    output_path: Path,
    frames: Sequence[np.ndarray],
    mask_sequence: Sequence[np.ndarray],
    fps: float,
    keep_audio: bool,
    work_dir: Path,
    progress_callback: ProgressCallback,
) -> EngineResult:
    propainter_path = Path(os.getenv("PROPAINTER_PATH", "/app/models/propainter"))
    script_path = propainter_path / "inference_propainter.py"
    if not script_path.exists():
        raise RuntimeError("ProPainter inference script not found")
    frames_dir = work_dir / "propainter_frames"
    masks_dir = work_dir / "propainter_masks"
    result_dir = work_dir / "propainter_result"
    frames_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)
    result_dir.mkdir(parents=True, exist_ok=True)
    progress_callback("extracting_frames", 0.50, "extracting frames")
    for index, (frame, mask) in enumerate(zip(frames, mask_sequence)):
        cv2.imwrite(str(frames_dir / f"{index:06d}.png"), frame)
        cv2.imwrite(str(masks_dir / f"{index:06d}.png"), mask)
    progress_callback("running_propainter", 0.58, "running propainter")
    command = [
        "python",
        str(script_path),
        "--video",
        str(frames_dir),
        "--mask",
        str(masks_dir),
        "--output",
        str(result_dir),
        "--device",
        os.getenv("PROPAINTER_DEVICE", "cpu"),
    ]
    result = subprocess.run(command, cwd=str(propainter_path), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout)[-1000:])
    output_frames = sorted(result_dir.glob("*.png"))
    if not output_frames:
        raise RuntimeError("ProPainter produced no frames")
    repaired = [frame for frame in (cv2.imread(str(path)) for path in output_frames) if frame is not None]
    if not repaired:
        raise RuntimeError("ProPainter output frames could not be read")
    silent_video = work_dir / "propainter_no_audio.mp4"
    write_frames_to_video(repaired, silent_video, fps)
    progress_callback("muxing_audio", 0.92, "muxing audio")
    mux_audio(input_path, silent_video, output_path, keep_audio=keep_audio)
    return EngineResult(engine="ProPainter", requested_mode="high_quality", output_path=output_path, message="completed with ProPainter")


def _repair_with_lama_fallback(
    *,
    input_path: Path,
    output_path: Path,
    frames: Sequence[np.ndarray],
    mask_sequence: Sequence[np.ndarray],
    fps: float,
    keep_audio: bool,
    options: dict,
    work_dir: Path,
    progress_callback: ProgressCallback,
) -> EngineResult:
    # This hook is deliberately optional. When a deployment provides a LaMa
    # wrapper script, use it; otherwise raise and let high_quality fallback.
    lama_path = Path(os.getenv("LAMA_MODEL_PATH", "/app/models/lama"))
    script_path = lama_path / "run_lama.py"
    if not script_path.exists():
        raise RuntimeError("LaMa wrapper not found")
    input_dir = work_dir / "lama_input"
    mask_dir = work_dir / "lama_masks"
    output_dir = work_dir / "lama_output"
    input_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    for index, (frame, mask) in enumerate(zip(frames, mask_sequence)):
        cv2.imwrite(str(input_dir / f"{index:06d}.png"), frame)
        cv2.imwrite(str(mask_dir / f"{index:06d}.png"), mask)
    progress_callback("running_lama", 0.60, "running lama")
    command = [
        "python",
        str(script_path),
        "--input",
        str(input_dir),
        "--mask",
        str(mask_dir),
        "--output",
        str(output_dir),
        "--device",
        os.getenv("LAMA_DEVICE", "cpu"),
    ]
    result = subprocess.run(command, cwd=str(lama_path), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout)[-1000:])
    output_frames = sorted(output_dir.glob("*.png"))
    if not output_frames:
        raise RuntimeError("LaMa produced no frames")
    repaired = [frame for frame in (cv2.imread(str(path)) for path in output_frames) if frame is not None]
    if not repaired:
        raise RuntimeError("LaMa output frames could not be read")
    silent_video = work_dir / "lama_no_audio.mp4"
    write_frames_to_video(repaired, silent_video, fps)
    progress_callback("muxing_audio", 0.92, "muxing audio")
    mux_audio(input_path, silent_video, output_path, keep_audio=keep_audio)
    return EngineResult(engine="LaMa", requested_mode="high_quality", output_path=output_path, message="completed with LaMa")


def _truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}
