"use client";

import { PointerEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { UploadedVideo } from "./VideoUploader";

export type DisplayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VideoRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VideoMetadata = {
  width: number;
  height: number;
  duration: number;
};

type Props = {
  video: UploadedVideo;
  videoUrl: string;
  outputUrl: string | null;
  maskPreviewUrl: string | null;
  showMaskOverlay: boolean;
  repairPreview: RepairPreview | null;
  displayRect: DisplayRect | null;
  videoRect: VideoRect | null;
  onSelectionChange: (displayRect: DisplayRect | null, videoRect: VideoRect | null) => void;
  onVideoMetadata: (metadata: VideoMetadata) => void;
  onTimeChange: (time: number) => void;
  onToggleMaskOverlay: () => void;
};

export type RepairPreview = {
  before_url: string;
  after_url: string;
  engine: string;
  mask_coverage: number;
};

type DragMode = "draw" | "move" | "resize";
type ResizeHandle = "nw" | "ne" | "sw" | "se";

type Interaction = {
  mode: DragMode;
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  originRect: DisplayRect | null;
  draftRect: DisplayRect;
};

export function VideoAnnotator({
  video,
  videoUrl,
  outputUrl,
  maskPreviewUrl,
  showMaskOverlay,
  repairPreview,
  displayRect,
  videoRect,
  onSelectionChange,
  onVideoMetadata,
  onTimeChange,
  onToggleMaskOverlay
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(video.duration || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [checkpointTime, setCheckpointTime] = useState(0);
  const [comparisonPosition, setComparisonPosition] = useState(50);

  const naturalWidth = video.width || 16;
  const naturalHeight = video.height || 9;
  const activeRect = interaction?.draftRect ?? displayRect;
  const orientation = naturalHeight > naturalWidth ? "竖屏" : "横屏";
  const aspectRatio = `${naturalWidth} / ${naturalHeight}`;
  const maxFrameWidth = `min(100%, calc(70vh * ${naturalWidth / naturalHeight}))`;

  useEffect(() => {
    setCurrentTime(0);
    setDuration(video.duration || 0);
    setIsPlaying(false);
    setCheckpointTime(0);
  }, [video.video_id, video.duration]);

  const timeLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }, [currentTime, duration]);

  function emitSelection(nextDisplayRect: DisplayRect | null) {
    if (!nextDisplayRect || !videoRef.current) {
      onSelectionChange(null, null);
      return;
    }

    const nextVideoRect = displayRectToVideoRect(nextDisplayRect, videoRef.current);
    if (nextVideoRect.width <= 0 || nextVideoRect.height <= 0) {
      onSelectionChange(null, null);
      return;
    }

    onSelectionChange(roundDisplayRect(nextDisplayRect), nextVideoRect);
  }

  function handleLoadedMetadata() {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    const metadata = {
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration || 0
    };
    setDuration(metadata.duration);
    onVideoMetadata(metadata);
  }

  function handleTimeUpdate() {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    setCurrentTime(element.currentTime);
    onTimeChange(element.currentTime);
  }

  function togglePlayback() {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    if (element.paused) {
      void element.play();
    } else {
      element.pause();
    }
  }

  function seekTo(value: number) {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    element.currentTime = clamp(value, 0, duration || 0);
    setCurrentTime(element.currentTime);
    onTimeChange(element.currentTime);
  }

  function stepFrame(direction: -1 | 1) {
    const fps = video.fps || 25;
    seekTo(currentTime + direction / fps);
  }

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const bounds = videoRef.current?.getBoundingClientRect();
    if (!bounds) {
      return { x: 0, y: 0 };
    }
    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height)
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    const hit = hitTest(point, displayRect);
    const originRect = displayRect ? { ...displayRect } : null;
    const draftRect = originRect ?? normalizeRect(point.x, point.y, point.x, point.y);

    event.currentTarget.setPointerCapture(event.pointerId);
    setInteraction({
      mode: hit.mode,
      handle: hit.handle,
      startX: point.x,
      startY: point.y,
      originRect,
      draftRect
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!interaction) {
      return;
    }

    const bounds = videoRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const point = pointFromEvent(event);
    const nextRect = rectForInteraction(interaction, point, bounds.width, bounds.height);
    setInteraction({ ...interaction, draftRect: nextRect });
    emitSelection(nextRect);
  }

  function handlePointerUp() {
    if (!interaction) {
      return;
    }

    const movedX = Math.abs(interaction.draftRect.x - (interaction.originRect?.x ?? interaction.startX));
    const movedY = Math.abs(interaction.draftRect.y - (interaction.originRect?.y ?? interaction.startY));
    const isClick = interaction.mode === "draw" && interaction.draftRect.width < 4 && interaction.draftRect.height < 4 && movedX < 4 && movedY < 4;

    if (isClick) {
      setInteraction(null);
      togglePlayback();
      return;
    }

    if (interaction.draftRect.width < 6 || interaction.draftRect.height < 6) {
      setInteraction(null);
      return;
    }

    setCheckpointTime(videoRef.current?.currentTime ?? currentTime);
    emitSelection(interaction.draftRect);
    setInteraction(null);
  }

  return (
    <section className="video-workbench">
      <div className="video-toolbar">
        <div>
          <strong>视频预览与字幕框选</strong>
          <span>{orientation} · 当前帧 {formatTime(currentTime)}</span>
        </div>
        <div className="video-badges">
          <span>{naturalWidth}×{naturalHeight}</span>
          {videoRect ? <span>真实坐标 {videoRect.x},{videoRect.y},{videoRect.width},{videoRect.height}</span> : null}
        </div>
      </div>

      <div className="video-canvas-shell">
        <div className="video-frame" style={{ aspectRatio, maxWidth: maxFrameWidth }}>
          <video
            ref={videoRef}
            className="preview-video"
            src={videoUrl}
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />
          <div
            className="annotation-layer"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setInteraction(null)}
          >
            {activeRect ? (
              <div className="selection-box" style={rectStyle(activeRect)}>
                <span className="selection-label">字幕区域</span>
                <span className="resize-handle nw" data-handle="nw" />
                <span className="resize-handle ne" data-handle="ne" />
                <span className="resize-handle sw" data-handle="sw" />
                <span className="resize-handle se" data-handle="se" />
              </div>
            ) : null}
            {maskPreviewUrl && showMaskOverlay ? (
              <img className="mask-preview-overlay" src={maskPreviewUrl} alt="mask preview overlay" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="custom-controls">
        <button type="button" className="control-button" onClick={togglePlayback}>
          {isPlaying ? "暂停" : "播放"}
        </button>
        <button type="button" className="control-button" onClick={() => seekTo(0)}>
          回到开头
        </button>
        <button type="button" className="control-button" onClick={() => seekTo(checkpointTime)}>
          跳到字幕检查点
        </button>
        <button type="button" className="control-button" onClick={() => stepFrame(-1)}>
          前一帧
        </button>
        <button type="button" className="control-button" onClick={() => stepFrame(1)}>
          下一帧
        </button>
        <button type="button" className={`control-button ${showMaskOverlay ? "active" : ""}`} onClick={onToggleMaskOverlay}>
          Mask 叠加
        </button>
        <span className="time-readout">{timeLabel}</span>
        <input
          className="timeline"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          aria-label="视频进度"
        />
      </div>

      {repairPreview ? (
        <div className="repair-compare">
          <div className="compare-title">
            <strong>当前帧修复预览</strong>
            <span>{repairPreview.engine} · mask {(repairPreview.mask_coverage * 100).toFixed(1)}%</span>
          </div>
          <div className="before-after" style={{ "--split": `${comparisonPosition}%` } as CSSProperties}>
            <img src={repairPreview.before_url} alt="repair preview before" />
            <img className="after-image" src={repairPreview.after_url} alt="repair preview after" />
            <div className="split-line" />
          </div>
          <input
            className="timeline"
            type="range"
            min={0}
            max={100}
            value={comparisonPosition}
            onChange={(event) => setComparisonPosition(Number(event.target.value))}
            aria-label="before after comparison"
          />
        </div>
      ) : null}

      <div className="comparison-strip">
        <div>
          <span>处理前</span>
          <video src={videoUrl} muted preload="metadata" />
        </div>
        <div>
          <span>处理后</span>
          {outputUrl ? <video src={outputUrl} muted controls preload="metadata" /> : <div className="result-placeholder">等待处理结果</div>}
        </div>
      </div>
    </section>
  );
}

export function displayRectToVideoRect(displayRect: DisplayRect, videoElement: HTMLVideoElement): VideoRect {
  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;
  const bounds = videoElement.getBoundingClientRect();

  if (videoWidth <= 0 || videoHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const videoAspect = videoWidth / videoHeight;
  const boundsAspect = bounds.width / bounds.height;
  let displayedWidth = bounds.width;
  let displayedHeight = bounds.height;
  let offsetX = 0;
  let offsetY = 0;

  if (boundsAspect > videoAspect) {
    displayedHeight = bounds.height;
    displayedWidth = displayedHeight * videoAspect;
    offsetX = (bounds.width - displayedWidth) / 2;
  } else {
    displayedWidth = bounds.width;
    displayedHeight = displayedWidth / videoAspect;
    offsetY = (bounds.height - displayedHeight) / 2;
  }

  const left = clamp((displayRect.x - offsetX) / displayedWidth, 0, 1);
  const top = clamp((displayRect.y - offsetY) / displayedHeight, 0, 1);
  const right = clamp((displayRect.x + displayRect.width - offsetX) / displayedWidth, 0, 1);
  const bottom = clamp((displayRect.y + displayRect.height - offsetY) / displayedHeight, 0, 1);

  const x = Math.round(left * videoWidth);
  const y = Math.round(top * videoHeight);
  const width = Math.round((right - left) * videoWidth);
  const height = Math.round((bottom - top) * videoHeight);

  return {
    x: clampInt(x, 0, videoWidth),
    y: clampInt(y, 0, videoHeight),
    width: clampInt(width, 0, videoWidth - x),
    height: clampInt(height, 0, videoHeight - y)
  };
}

function hitTest(point: { x: number; y: number }, rect: DisplayRect | null): { mode: DragMode; handle?: ResizeHandle } {
  if (!rect) {
    return { mode: "draw" };
  }

  const handles: Array<{ handle: ResizeHandle; x: number; y: number }> = [
    { handle: "nw", x: rect.x, y: rect.y },
    { handle: "ne", x: rect.x + rect.width, y: rect.y },
    { handle: "sw", x: rect.x, y: rect.y + rect.height },
    { handle: "se", x: rect.x + rect.width, y: rect.y + rect.height }
  ];

  for (const item of handles) {
    if (Math.abs(point.x - item.x) <= 14 && Math.abs(point.y - item.y) <= 14) {
      return { mode: "resize", handle: item.handle };
    }
  }

  if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
    return { mode: "move" };
  }

  return { mode: "draw" };
}

function rectForInteraction(interaction: Interaction, point: { x: number; y: number }, maxWidth: number, maxHeight: number): DisplayRect {
  if (interaction.mode === "draw") {
    return clampDisplayRect(normalizeRect(interaction.startX, interaction.startY, point.x, point.y), maxWidth, maxHeight);
  }

  const origin = interaction.originRect ?? interaction.draftRect;
  if (interaction.mode === "move") {
    const dx = point.x - interaction.startX;
    const dy = point.y - interaction.startY;
    return clampDisplayRect({ ...origin, x: origin.x + dx, y: origin.y + dy }, maxWidth, maxHeight);
  }

  const left = origin.x;
  const top = origin.y;
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  switch (interaction.handle) {
    case "nw":
      return clampDisplayRect(normalizeRect(point.x, point.y, right, bottom), maxWidth, maxHeight);
    case "ne":
      return clampDisplayRect(normalizeRect(left, point.y, point.x, bottom), maxWidth, maxHeight);
    case "sw":
      return clampDisplayRect(normalizeRect(point.x, top, right, point.y), maxWidth, maxHeight);
    case "se":
    default:
      return clampDisplayRect(normalizeRect(left, top, point.x, point.y), maxWidth, maxHeight);
  }
}

function clampDisplayRect(rect: DisplayRect, maxWidth: number, maxHeight: number): DisplayRect {
  const width = Math.min(rect.width, maxWidth);
  const height = Math.min(rect.height, maxHeight);
  return {
    x: clamp(rect.x, 0, maxWidth - width),
    y: clamp(rect.y, 0, maxHeight - height),
    width,
    height
  };
}

function normalizeRect(startX: number, startY: number, currentX: number, currentY: number): DisplayRect {
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  return {
    x,
    y,
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY)
  };
}

function roundDisplayRect(rect: DisplayRect): DisplayRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function rectStyle(rect: DisplayRect) {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number) {
  return Math.round(clamp(value, min, max));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
