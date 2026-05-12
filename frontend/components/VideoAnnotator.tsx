"use client";

import { PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { UploadedVideo } from "./VideoUploader";

type DisplayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OriginalRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Props = {
  video: UploadedVideo;
  videoUrl: string;
  outputUrl: string | null;
  rect: OriginalRect | null;
  onRectChange: (rect: OriginalRect | null) => void;
};

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export function VideoAnnotator({ video, videoUrl, outputUrl, rect, onRectChange }: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!stageRef.current) {
      return;
    }

    const observer = new ResizeObserver(updateDisplaySize);
    observer.observe(stageRef.current);
    updateDisplaySize();
    return () => observer.disconnect();
  }, []);

  const displayedRect = useMemo(() => {
    if (!rect || displaySize.width <= 0 || displaySize.height <= 0) {
      return null;
    }
    return originalToDisplay(rect, video.width, video.height, displaySize.width, displaySize.height);
  }, [rect, video.width, video.height, displaySize]);

  const activeRect = drag ? normalizeRect(drag.startX, drag.startY, drag.currentX, drag.currentY) : displayedRect;

  function updateDisplaySize() {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    setDisplaySize({ width: bounds.width, height: bounds.height });
  }

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) {
      return { x: 0, y: 0 };
    }
    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height)
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    updateDisplaySize();
    const point = pointFromEvent(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) {
      return;
    }
    const point = pointFromEvent(event);
    setDrag({
      ...drag,
      currentX: point.x,
      currentY: point.y
    });
  }

  function finishDrag() {
    if (!drag) {
      return;
    }
    const nextDisplayRect = normalizeRect(drag.startX, drag.startY, drag.currentX, drag.currentY);
    setDrag(null);

    if (nextDisplayRect.width < 4 || nextDisplayRect.height < 4) {
      return;
    }

    onRectChange(displayToOriginal(nextDisplayRect, video.width, video.height, displaySize.width, displaySize.height));
  }

  return (
    <>
      <section className="preview-card">
        <div ref={stageRef} className="video-stage">
          <video className="preview-video" src={videoUrl} controls onLoadedMetadata={updateDisplaySize} />
          <div
            ref={overlayRef}
            className="annotation-layer"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={() => setDrag(null)}
          >
            {activeRect ? <div className="selection-box" style={rectStyle(activeRect)} /> : null}
          </div>
        </div>

        <div className="video-note">
          <span>ⓘ 在视频中拖动鼠标，框选包含字幕的区域，系统将仅处理该区域内的字幕。</span>
          <button type="button" className="secondary-button compact" onClick={() => onRectChange(null)}>
            重置选区
          </button>
        </div>
      </section>

      <section className="preview-card comparison-card">
        <div className="section-title">处理效果对比</div>
        <div className="compare-grid">
          <div>
            <h3>处理前（含字幕）</h3>
            <video src={videoUrl} muted controls={false} />
          </div>
          <div className="compare-arrow">→</div>
          <div>
            <h3>处理后（已去字幕）</h3>
            {outputUrl ? <video src={outputUrl} muted controls /> : <div className="after-placeholder">等待处理结果</div>}
          </div>
        </div>
        <p>处理后画面会尽量保持自然，字幕区域由文字 mask 引导修复。</p>
      </section>
    </>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

function displayToOriginal(
  rect: DisplayRect,
  videoWidth: number,
  videoHeight: number,
  displayWidth: number,
  displayHeight: number
): OriginalRect {
  const scaleX = videoWidth / displayWidth;
  const scaleY = videoHeight / displayHeight;
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY)
  };
}

function originalToDisplay(
  rect: OriginalRect,
  videoWidth: number,
  videoHeight: number,
  displayWidth: number,
  displayHeight: number
): DisplayRect {
  const scaleX = displayWidth / videoWidth;
  const scaleY = displayHeight / videoHeight;
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
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
