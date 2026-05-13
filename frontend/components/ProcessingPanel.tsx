"use client";

import { useEffect, useState } from "react";
import type { DisplayRect, RepairPreview, VideoRect } from "./VideoAnnotator";
import type { UploadedVideo } from "./VideoUploader";

export type ProcessOptions = {
  repair_mode: "fast" | "balanced" | "high_quality";
  inpaint_strength: "low" | "medium" | "high";
  detection_sensitivity: number;
  min_component_area: number;
  max_component_area: number;
  mask_dilate: number;
  feather_radius: number;
  temporal_window: number;
  use_neighbor_frames: boolean;
  preserve_edges: boolean;
  keep_audio: boolean;
  method: "TELEA" | "NS";
};

export type ProgressState = {
  status: "idle" | "processing" | "done" | "failed" | "cancelled";
  step?: "uploaded" | "probing" | "detecting_masks" | "extracting_frames" | "repairing_frames" | "running_propainter" | "running_lama" | "muxing_audio" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  download_url: string | null;
  engine?: string | null;
};

export type MaskPreview = {
  mask_preview_url: string;
  debug_overlay_url?: string;
  mask_coverage: number;
  components_count: number;
  warning: string | null;
};

type EngineStatus = {
  requested_mode: string;
  actual_engine: string;
  capabilities: {
    propainter: { enabled: boolean; configured: boolean; path: string; device: string };
    lama: { enabled: boolean; configured: boolean; path: string; device: string };
    fallback_engine: string;
  };
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  displayRect: DisplayRect | null;
  videoRect: VideoRect | null;
  currentTime: number;
  maskPreview: MaskPreview | null;
  repairPreview: RepairPreview | null;
  jobId: string | null;
  progress: ProgressState | null;
  onProgress: (progress: ProgressState | null) => void;
  onStart: (options: ProcessOptions) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onPreviewMask: (options: ProcessOptions) => Promise<void>;
  onPreviewRepair: (options: ProcessOptions) => Promise<void>;
  onError: (message: string | null) => void;
};

export function ProcessingPanel({
  apiBaseUrl,
  video,
  displayRect,
  videoRect,
  currentTime,
  maskPreview,
  repairPreview,
  jobId,
  progress,
  onProgress,
  onStart,
  onCancel,
  onPreviewMask,
  onPreviewRepair,
  onError
}: Props) {
  const [options, setOptions] = useState<ProcessOptions>({
    repair_mode: "balanced",
    inpaint_strength: "medium",
    detection_sensitivity: 0.62,
    min_component_area: 4,
    max_component_area: 5000,
    mask_dilate: 4,
    feather_radius: 4,
    temporal_window: 3,
    use_neighbor_frames: true,
    preserve_edges: true,
    keep_audio: true,
    method: "TELEA"
  });
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`${apiBaseUrl}/api/engine-status?mode=${options.repair_mode}`)
      .then((response) => response.json())
      .then((payload: EngineStatus) => {
        if (active) {
          setEngineStatus(payload);
        }
      })
      .catch(() => {
        if (active) {
          setEngineStatus(null);
        }
      });
    return () => {
      active = false;
    };
  }, [apiBaseUrl, options.repair_mode]);

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
        if (payload.status === "done" || payload.status === "failed" || payload.status === "cancelled") {
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
    }, 800);

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

  async function runPreview(kind: "mask" | "repair") {
    setIsPreviewing(true);
    onError(null);
    try {
      if (kind === "mask") {
        await onPreviewMask(options);
      } else {
        await onPreviewRepair(options);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "预览失败");
    } finally {
      setIsPreviewing(false);
    }
  }

  async function handleCancel() {
    if (!jobId) {
      return;
    }
    try {
      await onCancel(jobId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "取消失败");
    }
  }

  const percentage = Math.round((progress?.progress ?? 0) * 100);
  const downloadUrl =
    progress?.status === "done" && progress.download_url ? `${apiBaseUrl}${progress.download_url}` : null;
  const canProcess = Boolean(video && videoRect && videoRect.width > 0 && videoRect.height > 0);
  const isProcessing = Boolean(jobId && progress?.status === "processing");
  const actualEngine = progress?.engine || engineStatus?.actual_engine || "Temporal OpenCV";

  return (
    <div className="control-stack">
      <section className="tool-card engine-card">
        <div className="card-title">
          <span>引擎状态</span>
          <small>{actualEngine}</small>
        </div>
        <div className="engine-pill-row">
          <span className={options.repair_mode === "fast" ? "active" : ""}>fast</span>
          <span className={options.repair_mode === "balanced" ? "active" : ""}>balanced</span>
          <span className={options.repair_mode === "high_quality" ? "active" : ""}>high_quality</span>
        </div>
        <p className="hint">
          {engineStatus?.capabilities.propainter.enabled
            ? "ProPainter 已启用。"
            : "当前服务器未启用 ProPainter，高质量模式将使用 LaMa 或 Temporal OpenCV fallback。"}
        </p>
      </section>

      <details className="tool-card" open>
        <summary>文件信息</summary>
        <InfoGrid
          items={[
            ["文件名", video?.filename ?? "-"],
            ["文件大小", video ? formatBytes(video.fileSize) : "-"],
            ["分辨率", video ? `${video.width} × ${video.height}` : "-"],
            ["时长", video ? formatTime(video.duration) : "-"],
            ["当前时间", formatTime(currentTime)]
          ]}
        />
      </details>

      <details className="tool-card" open>
        <summary>字幕区域</summary>
        <div className="coord-section">
          <strong>屏幕显示坐标</strong>
          <CoordGrid rect={displayRect} />
        </div>
        <div className="coord-section">
          <strong>真实视频坐标</strong>
          <CoordGrid rect={videoRect} />
        </div>
      </details>

      <details className="tool-card" open>
        <summary>检测参数</summary>
        <RangeField label="检测敏感度" value={options.detection_sensitivity} min={0.15} max={1} step={0.01} onChange={(value) => setOptions({ ...options, detection_sensitivity: value })} />
        <NumberField label="最小组件面积" value={options.min_component_area} min={1} max={10000} onChange={(value) => setOptions({ ...options, min_component_area: value })} />
        <NumberField label="最大组件面积" value={options.max_component_area} min={4} max={250000} onChange={(value) => setOptions({ ...options, max_component_area: value })} />
        <RangeField label="遮罩扩张" value={options.mask_dilate} min={0} max={30} step={1} onChange={(value) => setOptions({ ...options, mask_dilate: value })} />
      </details>

      <details className="tool-card" open>
        <summary>修复参数</summary>
        <label className="field">
          <span>修复模式</span>
          <div className="segmented three">
            {(["fast", "balanced", "high_quality"] as const).map((value) => (
              <button key={value} type="button" className={options.repair_mode === value ? "active" : ""} onClick={() => setOptions({ ...options, repair_mode: value })}>
                {value}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>修复强度</span>
          <div className="segmented">
            {(["low", "medium", "high"] as const).map((value) => (
              <button key={value} type="button" className={options.inpaint_strength === value ? "active" : ""} onClick={() => setOptions({ ...options, inpaint_strength: value })}>
                {value === "low" ? "低" : value === "medium" ? "中" : "高"}
              </button>
            ))}
          </div>
        </label>
        <RangeField label="边缘羽化" value={options.feather_radius} min={0} max={20} step={1} onChange={(value) => setOptions({ ...options, feather_radius: value })} />
        <RangeField label="时序窗口" value={options.temporal_window} min={0} max={8} step={1} onChange={(value) => setOptions({ ...options, temporal_window: value })} />
        <SwitchField label="使用前后帧" checked={options.use_neighbor_frames} onChange={(value) => setOptions({ ...options, use_neighbor_frames: value })} />
        <SwitchField label="保留边缘" checked={options.preserve_edges} onChange={(value) => setOptions({ ...options, preserve_edges: value })} />
        <SwitchField label="保留原音频" checked={options.keep_audio} onChange={(value) => setOptions({ ...options, keep_audio: value })} />
      </details>

      <details className="tool-card" open>
        <summary>预览工具</summary>
        <div className="action-grid two">
          <button type="button" className="ghost-button" disabled={!canProcess || isPreviewing} onClick={() => runPreview("mask")}>
            预览 mask
          </button>
          <button type="button" className="ghost-button" disabled={!canProcess || isPreviewing} onClick={() => runPreview("repair")}>
            预览当前帧修复
          </button>
        </div>
        <InfoGrid
          items={[
            ["Mask 覆盖率", maskPreview ? `${(maskPreview.mask_coverage * 100).toFixed(2)}%` : "-"],
            ["组件数量", maskPreview ? String(maskPreview.components_count) : "-"],
            ["Mask 警告", maskPreview?.warning ?? "-"],
            ["帧预览引擎", repairPreview?.engine ?? "-"]
          ]}
        />
      </details>

      <section className="tool-card">
        <div className="card-title">
          <span>操作</span>
          <small>{progress?.step ? stepLabel(progress.step) : "等待处理"}</small>
        </div>
        <div className="action-grid">
          <button type="button" className="primary-button" disabled={!canProcess || isSubmitting || isProcessing} onClick={handleStart}>
            {isSubmitting ? "提交中" : "开始处理"}
          </button>
          <button type="button" className="danger-button" disabled={!isProcessing} onClick={handleCancel}>
            取消
          </button>
          <a className={`download-button ${downloadUrl ? "" : "disabled"}`} href={downloadUrl ?? undefined}>
            下载结果
          </a>
        </div>
      </section>

      <section className="tool-card progress-panel">
        <div className="card-title">
          <span>任务进度</span>
          <small>{percentage}%</small>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percentage}%` }} />
        </div>
        <InfoGrid
          items={[
            ["当前步骤", progress?.step ? stepLabel(progress.step) : "-"],
            ["任务状态", progress?.status ?? "idle"],
            ["实际引擎", actualEngine],
            ["后端信息", progress?.message ?? "等待开始处理"]
          ]}
        />
      </section>
    </div>
  );
}

function RangeField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}：{typeof value === "number" && step < 1 ? value.toFixed(2) : value}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="number-input" type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function SwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="info-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong title={value}>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CoordGrid({ rect }: { rect: DisplayRect | VideoRect | null }) {
  return (
    <div className="coord-grid">
      <Coord label="x" value={rect?.x} />
      <Coord label="y" value={rect?.y} />
      <Coord label="width" value={rect?.width} />
      <Coord label="height" value={rect?.height} />
    </div>
  );
}

function Coord({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function stepLabel(step: NonNullable<ProgressState["step"]>) {
  const labels: Record<NonNullable<ProgressState["step"]>, string> = {
    uploaded: "读取视频",
    probing: "读取视频",
    detecting_masks: "生成字幕 mask",
    extracting_frames: "拆帧",
    repairing_frames: "修复画面",
    running_propainter: "运行 ProPainter",
    running_lama: "运行 LaMa",
    muxing_audio: "合成音频",
    completed: "输出完成",
    failed: "处理失败",
    cancelled: "已取消"
  };
  return labels[step];
}

function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
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
