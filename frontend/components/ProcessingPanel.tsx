"use client";

import { useEffect, useState } from "react";
import type { SelectionState } from "./VideoAnnotator";
import type { UploadedVideo } from "./VideoUploader";

export type ProcessOptions = {
  inpaint_strength: "low" | "medium" | "high";
  mask_dilate: number;
  feather_radius: number;
  keep_audio: boolean;
};

export type ProgressStatus =
  | "uploaded"
  | "probing"
  | "processing_frames"
  | "muxing_audio"
  | "completed"
  | "canceled"
  | "failed"
  | "processing"
  | "done";

export type ProgressState = {
  status: ProgressStatus;
  progress: number;
  message: string;
  download_url: string | null;
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  selection: SelectionState | null;
  jobId: string | null;
  progress: ProgressState | null;
  onProgress: (progress: ProgressState | null) => void;
  onResetSelection: () => void;
  onStart: (options: ProcessOptions) => Promise<void>;
  onCancel: () => void;
  onError: (message: string | null) => void;
};

const STRENGTH_OPTIONS: Array<{ value: ProcessOptions["inpaint_strength"]; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" }
];

export function ProcessingPanel({
  apiBaseUrl,
  video,
  selection,
  jobId,
  progress,
  onProgress,
  onResetSelection,
  onStart,
  onCancel,
  onError
}: Props) {
  const [options, setOptions] = useState<ProcessOptions>({
    inpaint_strength: "medium",
    mask_dilate: 8,
    feather_radius: 6,
    keep_audio: true
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
        if (payload.status === "completed" || payload.status === "done" || payload.status === "canceled" || payload.status === "failed") {
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
    }, 700);

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
    progress?.download_url && (progress.status === "completed" || progress.status === "done")
      ? `${apiBaseUrl}${progress.download_url}`
      : null;
  const canProcess = Boolean(video && selection);
  const isProcessing = Boolean(progress && !["completed", "done", "canceled", "failed"].includes(progress.status));

  return (
    <aside className="side-panel">
      <section className="panel">
        <div className="panel-heading">
          <span className="eyebrow">File</span>
          <h2>文件信息</h2>
        </div>
        <div className="info-grid">
          <InfoRow label="文件名" value={video?.filename ?? "未上传"} />
          <InfoRow label="文件大小" value={video ? formatBytes(video.size) : "--"} />
          <InfoRow label="视频分辨率" value={video ? `${video.width} x ${video.height}` : "--"} />
          <InfoRow label="时长" value={video ? formatDuration(video.duration) : "--"} />
          <InfoRow label="方向" value={video ? (video.height > video.width ? "竖屏" : "横屏") : "--"} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading split">
          <div>
            <span className="eyebrow">Region</span>
            <h2>字幕区域</h2>
          </div>
          <button type="button" className="secondary-button compact" onClick={onResetSelection}>
            清空
          </button>
        </div>

        <div className="coordinate-block">
          <h3>屏幕显示坐标</h3>
          <CoordinateGrid rect={selection?.displayRect ?? null} />
        </div>
        <div className="coordinate-block">
          <h3>真实视频坐标</h3>
          <CoordinateGrid rect={selection?.videoRect ?? null} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <span className="eyebrow">Settings</span>
          <h2>处理参数</h2>
        </div>

        <div className="field-group">
          <label>修复强度</label>
          <div className="segmented-control">
            {STRENGTH_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.inpaint_strength === item.value ? "active" : ""}
                onClick={() => setOptions({ ...options, inpaint_strength: item.value })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <RangeField
          label="边缘羽化"
          min={0}
          max={20}
          value={options.feather_radius}
          onChange={(value) => setOptions({ ...options, feather_radius: value })}
        />
        <RangeField
          label="遮罩扩张"
          min={0}
          max={30}
          value={options.mask_dilate}
          onChange={(value) => setOptions({ ...options, mask_dilate: value })}
        />

        <label className="toggle-row">
          <span>
            保留原音频
            <small>导出时使用原视频音轨</small>
          </span>
          <input
            type="checkbox"
            checked={options.keep_audio}
            onChange={(event) => setOptions({ ...options, keep_audio: event.target.checked })}
          />
        </label>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <span className="eyebrow">Run</span>
          <h2>操作</h2>
        </div>
        <div className="action-grid">
          <button
            type="button"
            className="primary-button"
            disabled={!canProcess || isSubmitting || isProcessing}
            onClick={handleStart}
          >
            {isSubmitting ? "提交中" : "开始处理"}
          </button>
          <button type="button" className="secondary-button" disabled={!isProcessing} onClick={onCancel}>
            取消
          </button>
          <a className={`download-button ${downloadUrl ? "" : "disabled"}`} href={downloadUrl ?? undefined}>
            下载结果
          </a>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <span className="eyebrow">Progress</span>
          <h2>进度</h2>
        </div>

        <div className="progress-meta">
          <span>{progress ? statusLabel(progress.status) : "等待开始"}</span>
          <strong>{percentage}%</strong>
        </div>
        <div className="progress-track" aria-label="处理进度">
          <div className="progress-fill" style={{ width: `${percentage}%` }} />
        </div>
        <div className={`backend-message ${progress?.status === "failed" ? "error" : ""}`}>
          {progress?.message ?? "上传视频并框选字幕区域后即可处理"}
        </div>
      </section>
    </aside>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function CoordinateGrid({ rect }: { rect: { x: number; y: number; width: number; height: number } | null }) {
  return (
    <div className="coordinate-grid">
      <CoordinateValue label="x" value={rect?.x} />
      <CoordinateValue label="y" value={rect?.y} />
      <CoordinateValue label="width" value={rect?.width} />
      <CoordinateValue label="height" value={rect?.height} />
    </div>
  );
}

function CoordinateValue({ label, value }: { label: string; value?: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{typeof value === "number" ? Math.round(value) : "--"}</strong>
    </div>
  );
}

function RangeField({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span>
        {label}
        <strong>{value}</strong>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function statusLabel(status: ProgressState["status"]) {
  const labels: Record<ProgressState["status"], string> = {
    uploaded: "已上传",
    probing: "读取视频",
    processing_frames: "逐帧处理",
    muxing_audio: "合成音频",
    completed: "已完成",
    canceled: "已取消",
    failed: "失败",
    processing: "处理中",
    done: "已完成"
  };
  return labels[status] ?? status;
}

function formatBytes(bytes: number) {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}
