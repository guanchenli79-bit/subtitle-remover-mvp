"use client";

import { PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

export type SelectionState = {
  displayRect: DisplayRect;
  videoRect: VideoRect;
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
  selection: SelectionState | null;
  onSelectionChange: (selection: SelectionState | null) => void;
  onVideoMetadata: (metadata: VideoMetadata) => void;
};

type PreviewMode = "before" | "after" | "mask" | "repair";

type Point = {
  x: number;
  y: number;
};

type DragHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

type Interaction =
  | { mode: "draw"; pointerId: number; start: Point; current: Point }
  | { mode: "move"; pointerId: number; start: Point; startRect: DisplayRect }
  | { mode: "resize"; pointerId: number; handle: DragHandle; start: Point; startRect: DisplayRect };

type ContainedVideoRect = {
  offsetX: number;
  offsetY: number;
  displayedWidth: number;
  displayedHeight: number;
  elementWidth: number;
  elementHeight: number;
};

const MIN_SELECTION_SIZE = 8;
const RESIZE_HANDLES: DragHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function VideoAnnotator({
  video,
  videoUrl,
  outputUrl,
  selection,
  onSelectionChange,
  onVideoMetadata
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [draftRect, setDraftRect] = useState<DisplayRect | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(video.duration || 0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("before");
  const [metadata, setMetadata] = useState<VideoMetadata>({
    width: video.width,
    height: video.height,
    duration: video.duration || 0
  });
  const [checkpointTime, setCheckpointTime] = useState(0);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => syncSelectionFromVideoRect());
    observer.observe(element);
    return () => observer.disconnect();
  }, [selection?.videoRect?.x, selection?.videoRect?.y, selection?.videoRect?.width, selection?.videoRect?.height]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(video.duration || 0);
    setMetadata({
      width: video.width,
      height: video.height,
      duration: video.duration || 0
    });
    setCheckpointTime(0);
    setInteraction(null);
    setDraftRect(null);
  }, [video.video_id, video.width, video.height, video.duration]);

  const videoRatio = useMemo(() => {
    const width = metadata.width || video.width || 16;
    const height = metadata.height || video.height || 9;
    return width / height;
  }, [metadata.width, metadata.height, video.width, video.height]);
  const aspectRatio = useMemo(() => {
    const width = metadata.width || video.width || 16;
    const height = metadata.height || video.height || 9;
    return `${width} / ${height}`;
  }, [metadata.width, metadata.height, video.width, video.height]);

  const activeRect = draftRect ?? selection?.displayRect ?? null;
  const usesOutputPreview = (previewMode === "after" || previewMode === "repair") && Boolean(outputUrl);
  const activeVideoUrl = usesOutputPreview && outputUrl ? outputUrl : videoUrl;
  const canEditSelection = previewMode === "before" || previewMode === "mask";

  function handleLoadedMetadata() {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    const nextMetadata = {
      width: element.videoWidth || video.width,
      height: element.videoHeight || video.height,
      duration: Number.isFinite(element.duration) ? element.duration : video.duration || 0
    };
    setDuration(nextMetadata.duration);
    setMetadata(nextMetadata);
    onVideoMetadata(nextMetadata);
    window.requestAnimationFrame(syncSelectionFromVideoRect);
  }

  function syncSelectionFromVideoRect() {
    const element = videoRef.current;
    if (!element || !selection?.videoRect || element.videoWidth <= 0 || element.videoHeight <= 0) {
      return;
    }

    const nextDisplayRect = videoRectToDisplayRect(selection.videoRect, element);
    if (!rectsNearlyEqual(nextDisplayRect, selection.displayRect)) {
      onSelectionChange({
        displayRect: roundDisplayRect(nextDisplayRect),
        videoRect: selection.videoRect
      });
    }
  }

  async function togglePlayback() {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    if (element.paused) {
      await element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }

  function seekTo(value: number) {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    const nextTime = clamp(value, 0, duration || 0);
    element.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function restart() {
    seekTo(0);
  }

  function stepFrame(direction: -1 | 1) {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    element.pause();
    const fps = Math.max(1, video.fps || 25);
    seekTo(element.currentTime + direction / fps);
  }

  function jumpToCheckpoint() {
    seekTo(checkpointTime || Math.min(duration, duration * 0.82));
  }

  function pointFromEvent(event: PointerEvent<HTMLElement>): Point | null {
    const element = videoRef.current;
    if (!element) {
      return null;
    }

    const bounds = element.getBoundingClientRect();
    const contained = getContainedVideoRect(element);
    const rawX = event.clientX - bounds.left;
    const rawY = event.clientY - bounds.top;
    return {
      x: clamp(rawX, contained.offsetX, contained.offsetX + contained.displayedWidth),
      y: clamp(rawY, contained.offsetY, contained.offsetY + contained.displayedHeight)
    };
  }

  function handleLayerPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setInteraction({
      mode: "draw",
      pointerId: event.pointerId,
      start: point,
      current: point
    });
    setDraftRect(null);
  }

  function handleSelectionPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !selection) {
      return;
    }
    event.stopPropagation();
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    overlayRef.current?.setPointerCapture(event.pointerId);
    setInteraction({
      mode: "move",
      pointerId: event.pointerId,
      start: point,
      startRect: selection.displayRect
    });
  }

  function handleResizePointerDown(handle: DragHandle, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !selection) {
      return;
    }
    event.stopPropagation();
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    overlayRef.current?.setPointerCapture(event.pointerId);
    setInteraction({
      mode: "resize",
      pointerId: event.pointerId,
      handle,
      start: point,
      startRect: selection.displayRect
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const point = pointFromEvent(event);
    const element = videoRef.current;
    if (!point || !element) {
      return;
    }

    let nextRect: DisplayRect;
    if (interaction.mode === "draw") {
      nextRect = constrainRectToVideo(normalizeRect(interaction.start, point), element);
      setInteraction({ ...interaction, current: point });
    } else if (interaction.mode === "move") {
      nextRect = moveRect(interaction.startRect, point.x - interaction.start.x, point.y - interaction.start.y, element);
    } else {
      nextRect = resizeRect(
        interaction.startRect,
        interaction.handle,
        point.x - interaction.start.x,
        point.y - interaction.start.y,
        element
      );
    }

    setDraftRect(nextRect);
    if (nextRect.width >= MIN_SELECTION_SIZE && nextRect.height >= MIN_SELECTION_SIZE) {
      commitDisplayRect(nextRect, false);
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const nextRect = draftRect;
    const wasClick =
      interaction.mode === "draw" &&
      Math.abs(interaction.current.x - interaction.start.x) < 3 &&
      Math.abs(interaction.current.y - interaction.start.y) < 3;

    setInteraction(null);
    setDraftRect(null);

    if (wasClick) {
      void togglePlayback();
      return;
    }

    if (nextRect && nextRect.width >= MIN_SELECTION_SIZE && nextRect.height >= MIN_SELECTION_SIZE) {
      commitDisplayRect(nextRect, true);
    }
  }

  function commitDisplayRect(displayRect: DisplayRect, updateCheckpoint: boolean) {
    const element = videoRef.current;
    if (!element || element.videoWidth <= 0 || element.videoHeight <= 0) {
      return;
    }

    const constrained = roundDisplayRect(constrainRectToVideo(displayRect, element));
    const videoRect = displayRectToVideoRect(constrained, element);
    onSelectionChange({
      displayRect: constrained,
      videoRect
    });
    if (updateCheckpoint) {
      setCheckpointTime(videoRef.current?.currentTime ?? 0);
    }
  }

  return (
    <>
      <section className="viewer-panel">
        <div className="viewer-toolbar">
          <div>
            <span className="eyebrow">Preview</span>
            <h1>{video.filename}</h1>
          </div>
          <div className="time-readout">当前帧 {formatTime(currentTime)}</div>
        </div>

        <div className="preview-tabs" aria-label="预览模式">
          <PreviewTab active={previewMode === "before"} label="Before" onClick={() => setPreviewMode("before")} />
          <PreviewTab active={previewMode === "after"} label="After" onClick={() => setPreviewMode("after")} />
          <PreviewTab active={previewMode === "mask"} label="Mask" onClick={() => setPreviewMode("mask")} />
          <PreviewTab active={previewMode === "repair"} label="Frame Repair" onClick={() => setPreviewMode("repair")} />
        </div>

        <div className="video-shell">
          <div className="video-canvas" style={{ aspectRatio, maxWidth: `min(100%, ${Math.min(160, Math.max(32, 70 * videoRatio))}vh)` }}>
            <video
              ref={videoRef}
              className="preview-video"
              src={activeVideoUrl}
              controls={false}
              playsInline
              preload="metadata"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
            <div
              ref={overlayRef}
              className="annotation-layer"
              onPointerDown={canEditSelection ? handleLayerPointerDown : undefined}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => {
                setInteraction(null);
                setDraftRect(null);
              }}
            >
              {activeRect && previewMode !== "after" ? (
                <div
                  className={`selection-box ${previewMode === "mask" ? "mask-preview" : ""}`}
                  style={rectStyle(activeRect)}
                  onPointerDown={canEditSelection ? handleSelectionPointerDown : undefined}
                >
                  {previewMode === "mask" ? <div className="mask-fill" /> : null}
                  {canEditSelection
                    ? RESIZE_HANDLES.map((handle) => (
                        <div
                          key={handle}
                          className={`resize-handle ${handle}`}
                          onPointerDown={(event) => handleResizePointerDown(handle, event)}
                        />
                      ))
                    : null}
                </div>
              ) : null}
              {previewMode === "after" && !outputUrl ? <div className="preview-watermark">等待处理结果</div> : null}
              {previewMode === "repair" && !outputUrl ? <div className="preview-watermark">完成处理后显示当前帧修复预览</div> : null}
            </div>
          </div>
        </div>

        <div className="video-controls">
          <button type="button" className="control-button" onClick={() => void togglePlayback()}>
            {isPlaying ? "暂停" : "播放"}
          </button>
          <button type="button" className="control-button" onClick={restart}>
            回到开头
          </button>
          <button type="button" className="control-button icon-button" onClick={() => stepFrame(-1)} aria-label="上一帧">
            -1f
          </button>
          <button type="button" className="control-button icon-button" onClick={() => stepFrame(1)} aria-label="下一帧">
            +1f
          </button>
          <button type="button" className="control-button" onClick={jumpToCheckpoint}>
            跳到检查点
          </button>

          <span className="time-code">{formatTime(currentTime)}</span>
          <input
            className="timeline"
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <span className="time-code">{formatTime(duration)}</span>
        </div>

        <div className="selection-hint">
          {selection
            ? "拖动选区可移动，拖动边角可调整大小。点击空白视频区域可播放或暂停。"
            : "在视频画面上拖拽框选字幕区域。选区会换算成真实视频像素坐标。"}
        </div>
      </section>

      <section className="viewer-panel result-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Compare</span>
            <h2>前后对比与诊断预览</h2>
          </div>
        </div>
        <div className="compare-grid">
          <PreviewCard title="Before" subtitle="原始帧">
            <video className="result-video" src={videoUrl} muted preload="metadata" />
          </PreviewCard>
          <PreviewCard title="After" subtitle={outputUrl ? "导出结果" : "等待输出"}>
            {outputUrl ? <video className="result-video" src={outputUrl} controls preload="metadata" /> : <div className="result-placeholder">处理完成后显示</div>}
          </PreviewCard>
          <PreviewCard title="Mask" subtitle="当前选区 mask 预览">
            <div className="diagnostic-preview mask-diagnostic">{selection ? "MASK" : "未框选"}</div>
          </PreviewCard>
          <PreviewCard title="Frame repair" subtitle="当前帧修复预览">
            <div className="diagnostic-preview repair-diagnostic">{outputUrl ? "已生成" : "等待处理"}</div>
          </PreviewCard>
        </div>
      </section>
    </>
  );
}

function PreviewTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={active ? "active" : ""} onClick={onClick}>
      {label}
    </button>
  );
}

function PreviewCard({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="compare-card">
      <div>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

export function displayRectToVideoRect(displayRect: DisplayRect, videoElement: HTMLVideoElement): VideoRect {
  const videoWidth = videoElement.videoWidth || 1;
  const videoHeight = videoElement.videoHeight || 1;
  const contained = getContainedVideoRect(videoElement);

  const left = clamp(displayRect.x - contained.offsetX, 0, contained.displayedWidth);
  const top = clamp(displayRect.y - contained.offsetY, 0, contained.displayedHeight);
  const right = clamp(displayRect.x + displayRect.width - contained.offsetX, 0, contained.displayedWidth);
  const bottom = clamp(displayRect.y + displayRect.height - contained.offsetY, 0, contained.displayedHeight);

  const scaleX = videoWidth / Math.max(1, contained.displayedWidth);
  const scaleY = videoHeight / Math.max(1, contained.displayedHeight);

  const x = clamp(Math.round(Math.min(left, right) * scaleX), 0, Math.max(0, videoWidth - 1));
  const y = clamp(Math.round(Math.min(top, bottom) * scaleY), 0, Math.max(0, videoHeight - 1));
  const width = clamp(Math.round(Math.abs(right - left) * scaleX), 1, Math.max(1, videoWidth - x));
  const height = clamp(Math.round(Math.abs(bottom - top) * scaleY), 1, Math.max(1, videoHeight - y));

  return { x, y, width, height };
}

export function videoRectToDisplayRect(videoRect: VideoRect, videoElement: HTMLVideoElement): DisplayRect {
  const videoWidth = videoElement.videoWidth || 1;
  const videoHeight = videoElement.videoHeight || 1;
  const contained = getContainedVideoRect(videoElement);

  return {
    x: contained.offsetX + (videoRect.x / videoWidth) * contained.displayedWidth,
    y: contained.offsetY + (videoRect.y / videoHeight) * contained.displayedHeight,
    width: (videoRect.width / videoWidth) * contained.displayedWidth,
    height: (videoRect.height / videoHeight) * contained.displayedHeight
  };
}

function getContainedVideoRect(videoElement: HTMLVideoElement): ContainedVideoRect {
  const bounds = videoElement.getBoundingClientRect();
  const elementWidth = bounds.width || 1;
  const elementHeight = bounds.height || 1;
  const videoWidth = videoElement.videoWidth || elementWidth;
  const videoHeight = videoElement.videoHeight || elementHeight;
  const elementRatio = elementWidth / elementHeight;
  const videoRatio = videoWidth / videoHeight;

  let displayedWidth = elementWidth;
  let displayedHeight = elementHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (elementRatio > videoRatio) {
    displayedHeight = elementHeight;
    displayedWidth = displayedHeight * videoRatio;
    offsetX = (elementWidth - displayedWidth) / 2;
  } else {
    displayedWidth = elementWidth;
    displayedHeight = displayedWidth / videoRatio;
    offsetY = (elementHeight - displayedHeight) / 2;
  }

  return {
    offsetX,
    offsetY,
    displayedWidth,
    displayedHeight,
    elementWidth,
    elementHeight
  };
}

function constrainRectToVideo(rect: DisplayRect, videoElement: HTMLVideoElement): DisplayRect {
  const contained = getContainedVideoRect(videoElement);
  const minX = contained.offsetX;
  const minY = contained.offsetY;
  const maxX = contained.offsetX + contained.displayedWidth;
  const maxY = contained.offsetY + contained.displayedHeight;
  const left = clamp(rect.x, minX, maxX);
  const top = clamp(rect.y, minY, maxY);
  const right = clamp(rect.x + rect.width, minX, maxX);
  const bottom = clamp(rect.y + rect.height, minY, maxY);

  return normalizeRect({ x: left, y: top }, { x: right, y: bottom });
}

function moveRect(rect: DisplayRect, deltaX: number, deltaY: number, videoElement: HTMLVideoElement): DisplayRect {
  const contained = getContainedVideoRect(videoElement);
  const minX = contained.offsetX;
  const minY = contained.offsetY;
  const maxX = contained.offsetX + contained.displayedWidth - rect.width;
  const maxY = contained.offsetY + contained.displayedHeight - rect.height;

  return {
    ...rect,
    x: clamp(rect.x + deltaX, minX, Math.max(minX, maxX)),
    y: clamp(rect.y + deltaY, minY, Math.max(minY, maxY))
  };
}

function resizeRect(
  rect: DisplayRect,
  handle: DragHandle,
  deltaX: number,
  deltaY: number,
  videoElement: HTMLVideoElement
): DisplayRect {
  const contained = getContainedVideoRect(videoElement);
  const minX = contained.offsetX;
  const minY = contained.offsetY;
  const maxX = contained.offsetX + contained.displayedWidth;
  const maxY = contained.offsetY + contained.displayedHeight;

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) {
    left = clamp(left + deltaX, minX, right - MIN_SELECTION_SIZE);
  }
  if (handle.includes("e")) {
    right = clamp(right + deltaX, left + MIN_SELECTION_SIZE, maxX);
  }
  if (handle.includes("n")) {
    top = clamp(top + deltaY, minY, bottom - MIN_SELECTION_SIZE);
  }
  if (handle.includes("s")) {
    bottom = clamp(bottom + deltaY, top + MIN_SELECTION_SIZE, maxY);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function normalizeRect(start: Point, current: Point): DisplayRect {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    x,
    y,
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
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

function rectsNearlyEqual(a: DisplayRect, b: DisplayRect) {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
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

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}
