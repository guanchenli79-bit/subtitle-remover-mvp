"use client";

import { useEffect, useState } from "react";
import type { OriginalRect } from "./VideoAnnotator";

export type ProcessOptions = {
  threshold: number;
  dilate_iter: number;
  inpaint_radius: number;
  method: "TELEA" | "NS";
};

export type ProgressState = {
  status: "processing" | "done" | "failed";
  progress: number;
  message: string;
  download_url: string | null;
};

type Props = {
  apiBaseUrl: string;
  hasVideo: boolean;
  canProcess: boolean;
  jobId: string | null;
  rect: OriginalRect | null;
  progress: ProgressState | null;
  onProgress: (progress: ProgressState | null) => void;
  onResetRect: () => void;
  onStart: (options: ProcessOptions) => Promise<void>;
  onError: (message: string | null) => void;
};

export function ProcessingPanel({
  apiBaseUrl,
  hasVideo,
  canProcess,
  jobId,
  rect,
  progress,
  onProgress,
  onResetRect,
  onStart,
  onError
}: Props) {
  const [options, setOptions] = useState<ProcessOptions>({
    threshold: 180,
    dilate_iter: 2,
    inpaint_radius: 3,
    method: "TELEA"
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let isActive = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/progress/${jobId}`);
        if (!response.ok) {
          throw new Error("进度获取失败");
        }
        const payload = (await response.json()) as ProgressState;
        if (!isActive) {
          return;
        }
        onProgress(payload);
        if (payload.status === "done" || payload.status === "failed") {
          window.clearInterval(timer);
          if (payload.status === "failed") {
            onError(payload.message);
          }
        }
      } catch (error) {
        if (isActive) {
          onError(error instanceof Error ? error.message : "进度获取失败");
        }
      }
    }, 900);

    return () => {
      isActive = false;
      window.clearInterval(timer);
    };
  }, [apiBaseUrl, jobId, onError, onProgress]);

  async function handleStart() {
    setIsSubmitting(true);
    onError(null);
    try {
      await onStart(options);
    } catch (error) {
      onError(error instanceof Error ? error.message : "处理任务提交失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  const percentage = Math.round((progress?.progress ?? 0) * 100);
  const downloadUrl =
    progress?.status === "done" && progress.download_url ? `${apiBaseUrl}${progress.download_url}` : null;

  return (
    <>
      <section className="control-card region-card">
        <div className="step-heading split">
          <h2>2. 框选字幕区域</h2>
          <button type="button" className="secondary-button compact" onClick={onResetRect}>
            重新框选
          </button>
        </div>

        <div className="selected-region">
          <span>已框选区域：</span>
          <strong>
            {rect ? `X: ${rect.x}, Y: ${rect.y}, 宽: ${rect.width}, 高: ${rect.height}` : "请在左侧视频上拖拽框选"}
          </strong>
        </div>
      </section>

      <section className="control-card process-panel">
        <div className="step-heading">
          <h2>3. 处理设置</h2>
        </div>

        <div className="toggle-grid">
          <label className="setting-tile">
            <span>
              自动识别字幕
              <small>阈值分割高亮文字像素</small>
            </span>
            <input type="checkbox" defaultChecked />
          </label>
          <label className="setting-tile">
            <span>
              智能补全画面
              <small>使用 OpenCV inpaint 修复</small>
            </span>
            <input type="checkbox" defaultChecked />
          </label>
          <label className="setting-tile">
            <span>
              仅处理框选区域
              <small>保护其他画面不受影响</small>
            </span>
            <input type="checkbox" defaultChecked />
          </label>
        </div>

        <div className="options-grid">
          <label>
            <span>threshold</span>
            <input
              type="number"
              min={0}
              max={255}
              value={options.threshold}
              onChange={(event) => setOptions({ ...options, threshold: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>dilate_iter</span>
            <input
              type="number"
              min={0}
              max={8}
              value={options.dilate_iter}
              onChange={(event) => setOptions({ ...options, dilate_iter: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>inpaint_radius</span>
            <input
              type="number"
              min={1}
              max={20}
              value={options.inpaint_radius}
              onChange={(event) => setOptions({ ...options, inpaint_radius: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>method</span>
            <select
              value={options.method}
              onChange={(event) => setOptions({ ...options, method: event.target.value as ProcessOptions["method"] })}
            >
              <option value="TELEA">TELEA</option>
              <option value="NS">NS</option>
            </select>
          </label>
        </div>

        <button
          type="button"
          className="primary-button full-width start-button"
          disabled={!canProcess || isSubmitting || progress?.status === "processing"}
          onClick={handleStart}
        >
          {isSubmitting ? "提交中" : "开始去字幕处理"}
        </button>
      </section>

      <section className="control-card progress-card">
        <div className="section-title">处理进度</div>
        <div className="stepper" aria-label="处理阶段">
          <ProgressStep active={hasVideo} done={hasVideo} icon="☁" label="上传完成" time={hasVideo ? "已完成" : "待上传"} />
          <ProgressStep active={Boolean(progress)} done={(progress?.progress ?? 0) > 0.18} icon="A" label="识别字幕中" time="mask" />
          <ProgressStep active={Boolean(progress)} done={(progress?.progress ?? 0) > 0.5} icon="✎" label="去除文字中" time="inpaint" />
          <ProgressStep active={(progress?.progress ?? 0) > 0.88} done={progress?.status === "done"} icon="✦" label="画面补全中" time="mux" />
          <ProgressStep active={progress?.status === "done"} done={progress?.status === "done"} icon="↓" label="导出完成" time="mp4" />
        </div>

        <div className="progress-wrap" aria-label="处理进度">
          <div className="progress-bar" style={{ width: `${percentage}%` }} />
        </div>
        <div className="progress-line">
          <span>{progress?.message ?? "等待开始处理"}</span>
          <strong>{percentage}%</strong>
        </div>
      </section>

      <section className="control-card action-card">
        <a className={`ghost-button ${downloadUrl ? "" : "disabled"}`} href={downloadUrl ?? undefined}>
          预览结果
        </a>
        <a className={`download-button ${downloadUrl ? "" : "disabled"}`} href={downloadUrl ?? undefined}>
          下载视频
        </a>
        <button
          type="button"
          className="secondary-button"
          disabled={!canProcess || isSubmitting || progress?.status === "processing"}
          onClick={handleStart}
        >
          重新处理
        </button>
      </section>
    </>
  );
}

function ProgressStep({
  active,
  done,
  icon,
  label,
  time
}: {
  active: boolean;
  done: boolean;
  icon: string;
  label: string;
  time: string;
}) {
  return (
    <div className={`progress-step ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <div className="step-icon">{done ? "✓" : icon}</div>
      <span>{label}</span>
      <small>{time}</small>
    </div>
  );
}
