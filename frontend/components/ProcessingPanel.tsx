"use client";

import { useEffect, useMemo, useState } from "react";
import type { SelectionState } from "./VideoAnnotator";
import type { UploadedVideo } from "./VideoUploader";

export type RepairMode = "fast" | "balanced" | "high_quality";

export type ProcessOptions = {
  inpaint_strength: "low" | "medium" | "high";
  repair_mode: RepairMode;
  detection_sensitivity: number;
  temporal_window: number;
  min_component_area: number;
  max_component_area: number;
  mask_dilate: number;
  feather_radius: number;
  ocr_confirm: boolean;
  keep_audio: boolean;
};

export type ProgressStatus =
  | "upload"
  | "uploaded"
  | "analyze"
  | "probing"
  | "detect"
  | "repair"
  | "processing"
  | "processing_frames"
  | "merge"
  | "muxing_audio"
  | "done"
  | "completed"
  | "canceled"
  | "failed";

export type ProgressState = {
  status: ProgressStatus;
  progress: number;
  stage?: string;
  stage_progress?: number;
  current_frame?: number;
  total_frames?: number;
  eta_seconds?: number | null;
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

const STRENGTH_OPTIONS: Array<{ value: ProcessOptions["inpaint_strength"]; label: string; hint: string }> = [
  { value: "low", label: "低", hint: "保守收边" },
  { value: "medium", label: "中", hint: "默认" },
  { value: "high", label: "高", hint: "更强修补" }
];

const REPAIR_MODES: Array<{ value: RepairMode; label: string; hint: string }> = [
  { value: "fast", label: "Fast", hint: "低延迟，少量时序融合" },
  { value: "balanced", label: "Balanced", hint: "默认，质量和速度平衡" },
  { value: "high_quality", label: "High Quality", hint: "更多相邻帧参与修复" }
];

const STEPS: Array<{ key: ProgressStatus; label: string }> = [
  { key: "upload", label: "上传视频" },
  { key: "analyze", label: "分析视频" },
  { key: "detect", label: "检测字幕" },
  { key: "repair", label: "修复画面" },
  { key: "merge", label: "合成输出" },
  { key: "done", label: "完成" }
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
    repair_mode: "balanced",
    detection_sensitivity: 0.68,
    temporal_window: 2,
    min_component_area: 4,
    max_component_area: 12000,
    mask_dilate: 7,
    feather_radius: 8,
    ocr_confirm: false,
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
        if (isTerminalStatus(payload.status)) {
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
  const stagePercentage = Math.round((progress?.stage_progress ?? progress?.progress ?? 0) * 100);
  const activeStep = normalizeStatus(progress?.status);
  const downloadUrl =
    progress?.download_url && (progress.status === "done" || progress.status === "completed")
      ? `${apiBaseUrl}${progress.download_url}`
      : null;
  const canProcess = Boolean(video && selection);
  const isProcessing = Boolean(progress && !isTerminalStatus(progress.status));
  const frameLine = useMemo(() => {
    if (!progress?.total_frames) {
      return "帧进度 --";
    }
    return `${progress.current_frame ?? 0}/${progress.total_frames} 帧`;
  }, [progress?.current_frame, progress?.total_frames]);

  return (
    <aside className="side-panel">
      <section className="panel file-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">File</span>
            <h2>文件信息</h2>
          </div>
          <span className={`orientation-pill ${video && video.height > video.width ? "portrait" : ""}`}>
            {video ? (video.height > video.width ? "竖屏" : "横屏") : "--"}
          </span>
        </div>
        <div className="info-grid">
          <InfoRow label="文件名" value={video?.filename ?? "未上传"} />
          <InfoRow label="文件大小" value={video ? formatBytes(video.size) : "--"} />
          <InfoRow label="分辨率" value={video ? `${video.width} x ${video.height}` : "--"} />
          <InfoRow label="时长" value={video ? formatDuration(video.duration) : "--"} />
          <InfoRow label="帧率" value={video ? `${video.fps} fps` : "--"} />
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
          <div>
            <span className="eyebrow">Detection</span>
            <h2>检测参数</h2>
          </div>
        </div>

        <RangeField
          label="Detection sensitivity"
          description="默认 0.68；越高越容易捕捉快节奏字幕，也更容易带入噪点。"
          min={0.1}
          max={1}
          step={0.01}
          value={options.detection_sensitivity}
          display={options.detection_sensitivity.toFixed(2)}
          onChange={(value) => setOptions({ ...options, detection_sensitivity: value })}
        />
        <RangeField
          label="Temporal window"
          description="默认 2；前后帧投票补偿短暂漏检，范围 0-3。"
          min={0}
          max={3}
          step={1}
          value={options.temporal_window}
          onChange={(value) => setOptions({ ...options, temporal_window: value })}
        />
        <RangeField
          label="Min component area"
          description="默认 4；过滤极小噪点。"
          min={1}
          max={80}
          step={1}
          value={options.min_component_area}
          onChange={(value) => setOptions({ ...options, min_component_area: value })}
        />
        <RangeField
          label="Max component area"
          description="默认 12000；避免把整片背景当文字。"
          min={1000}
          max={60000}
          step={500}
          value={options.max_component_area}
          onChange={(value) => setOptions({ ...options, max_component_area: value })}
        />
        <RangeField
          label="Mask dilate"
          description="默认 7；扩张文字 mask，覆盖描边和抗锯齿边缘。"
          min={0}
          max={30}
          step={1}
          value={options.mask_dilate}
          onChange={(value) => setOptions({ ...options, mask_dilate: value })}
        />
        <label className="toggle-row">
          <span>
            OCR confirm
            <small>可选辅助确认，不会单独决定 mask；服务器无 OCR 时自动跳过。</small>
          </span>
          <input
            type="checkbox"
            checked={options.ocr_confirm}
            onChange={(event) => setOptions({ ...options, ocr_confirm: event.target.checked })}
          />
        </label>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Repair</span>
            <h2>修复参数</h2>
          </div>
        </div>

        <div className="field-group">
          <label>修复模式</label>
          <div className="mode-grid">
            {REPAIR_MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.repair_mode === item.value ? "active" : ""}
                onClick={() => setOptions({ ...options, repair_mode: item.value })}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <label>修复强度</label>
          <div className="segmented-control">
            {STRENGTH_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.inpaint_strength === item.value ? "active" : ""}
                title={item.hint}
                onClick={() => setOptions({ ...options, inpaint_strength: item.value })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <RangeField
          label="Feather radius"
          description="默认 8；修复边缘柔化，减少块状边界。"
          min={0}
          max={20}
          step={1}
          value={options.feather_radius}
          onChange={(value) => setOptions({ ...options, feather_radius: value })}
        />

        <label className="toggle-row">
          <span>
            保留原音频
            <small>导出时使用原视频音轨。</small>
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
          <div>
            <span className="eyebrow">Run</span>
            <h2>任务状态</h2>
          </div>
          <strong className="percent-badge">{percentage}%</strong>
        </div>

        <div className="step-list">
          {STEPS.map((step, index) => {
            const state = stepState(step.key, activeStep);
            return (
              <div key={step.key} className={`process-step ${state}`}>
                <span>{index + 1}</span>
                <strong>{step.label}</strong>
              </div>
            );
          })}
        </div>

        <div className="progress-meta">
          <span>{progress ? statusLabel(progress.status) : "等待开始"}</span>
          <strong>{stagePercentage}% 当前阶段</strong>
        </div>
        <div className="progress-track" aria-label="处理进度">
          <div className="progress-fill" style={{ width: `${percentage}%` }} />
        </div>
        <div className="job-stats">
          <span>{frameLine}</span>
          <span>预计剩余 {formatEta(progress?.eta_seconds)}</span>
        </div>
        <div className={`backend-message ${progress?.status === "failed" ? "error" : ""}`}>
          {progress?.message ?? "上传视频并框选字幕区域后即可处理"}
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
  description,
  min,
  max,
  step,
  value,
  display,
  onChange
}: {
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span>
        <span>
          {label}
          <small>{description}</small>
        </span>
        <strong>{display ?? value}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function normalizeStatus(status?: ProgressStatus) {
  const aliases: Partial<Record<ProgressStatus, ProgressStatus>> = {
    uploaded: "upload",
    probing: "analyze",
    processing: "repair",
    processing_frames: "repair",
    muxing_audio: "merge",
    completed: "done"
  };
  return status ? aliases[status] ?? status : null;
}

function stepState(step: ProgressStatus, active: ProgressStatus | null) {
  if (!active) {
    return "idle";
  }
  const stepIndex = STEPS.findIndex((item) => item.key === step);
  const activeIndex = STEPS.findIndex((item) => item.key === active);
  if (active === "failed" || active === "canceled") {
    return stepIndex <= Math.max(0, activeIndex) ? "done" : "idle";
  }
  if (stepIndex < activeIndex) {
    return "done";
  }
  if (stepIndex === activeIndex) {
    return "active";
  }
  return "idle";
}

function isTerminalStatus(status: ProgressState["status"]) {
  return status === "done" || status === "completed" || status === "canceled" || status === "failed";
}

function statusLabel(status: ProgressState["status"]) {
  const labels: Record<ProgressState["status"], string> = {
    upload: "上传视频",
    uploaded: "上传视频",
    analyze: "分析视频",
    probing: "分析视频",
    detect: "检测字幕",
    repair: "修复画面",
    processing: "修复画面",
    processing_frames: "修复画面",
    merge: "合成输出",
    muxing_audio: "合成输出",
    done: "完成",
    completed: "完成",
    canceled: "已取消",
    failed: "失败"
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

function formatEta(seconds?: number | null) {
  if (!Number.isFinite(seconds ?? NaN) || !seconds) {
    return "--";
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}
