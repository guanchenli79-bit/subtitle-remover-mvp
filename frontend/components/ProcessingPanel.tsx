"use client";

import { useEffect, useMemo, useState } from "react";
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
  status: "idle" | "processing" | "completed" | "done" | "failed" | "cancelled";
  stage?: ProgressStage;
  step?: ProgressStage;
  progress: number;
  message: string;
  current_frame?: number;
  total_frames?: number;
  error?: string | null;
  output_url?: string | null;
  download_url?: string | null;
  engine?: string | null;
  updated_at?: number;
};

export type ProgressStage =
  | "uploaded"
  | "probing"
  | "detecting_masks"
  | "extracting_frames"
  | "repairing_frames"
  | "running_propainter"
  | "running_lama"
  | "muxing_audio"
  | "completed"
  | "failed"
  | "cancelled";

export type MaskPreview = {
  mask_preview_url: string;
  debug_overlay_url?: string;
  mask_coverage: number;
  components_count: number;
  warning: string | null;
};

export type AutoDetectResult = {
  recommended_rect: VideoRect;
  confidence: number;
  sample_frames: Array<{ frame_index: number; time: number; preview_url?: string; detected: boolean }>;
  reason: string;
  warning: string | null;
};

export type WorkflowMode = "smart" | "manual";
type StrengthPreset = "light" | "standard" | "strong";
type QualityPreset = "speed" | "balanced" | "quality";

type EngineStatus = {
  requested_mode: string;
  actual_engine: string;
  capabilities: {
    gpu_api?: { enabled: boolean; configured: boolean; url: string };
    propainter: { enabled: boolean; configured: boolean; path: string; device: string };
    lama: { enabled: boolean; configured: boolean; path: string; device: string };
    fallback_engine: string;
  };
};

type AdvancedOptions = {
  detection_sensitivity: number;
  min_component_area: number;
  max_component_area: number;
  mask_dilate: number;
  feather_radius: number;
  temporal_window: number;
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  displayRect: DisplayRect | null;
  videoRect: VideoRect | null;
  currentTime: number;
  maskPreview: MaskPreview | null;
  repairPreview: RepairPreview | null;
  autoDetectResult: AutoDetectResult | null;
  isAutoDetecting: boolean;
  workflowMode: WorkflowMode;
  jobId: string | null;
  progress: ProgressState | null;
  onProgress: (progress: ProgressState | null) => void;
  onWorkflowModeChange: (mode: WorkflowMode) => void;
  onAutoDetect: () => Promise<void>;
  onStart: (options: ProcessOptions) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onPreviewEffect: (options: ProcessOptions) => Promise<void>;
  onError: (message: string | null) => void;
};

const STRENGTH_PRESETS: Record<StrengthPreset, AdvancedOptions & { label: string; description: string; inpaint_strength: "low" | "medium" | "high" }> = {
  light: {
    label: "轻度",
    description: "画面最自然，可能少量残留",
    detection_sensitivity: 0.68,
    mask_dilate: 3,
    temporal_window: 2,
    feather_radius: 8,
    min_component_area: 4,
    max_component_area: 5000,
    inpaint_strength: "low"
  },
  standard: {
    label: "标准",
    description: "默认推荐，干净度和自然度平衡",
    detection_sensitivity: 0.76,
    mask_dilate: 4,
    temporal_window: 3,
    feather_radius: 10,
    min_component_area: 4,
    max_component_area: 5000,
    inpaint_strength: "medium"
  },
  strong: {
    label: "强力",
    description: "字幕去得更干净，画面更容易糊",
    detection_sensitivity: 0.84,
    mask_dilate: 6,
    temporal_window: 3,
    feather_radius: 14,
    min_component_area: 3,
    max_component_area: 6500,
    inpaint_strength: "high"
  }
};

const QUALITY_PRESETS: Record<QualityPreset, { label: string; mode: ProcessOptions["repair_mode"]; description: string }> = {
  speed: { label: "速度优先", mode: "fast", description: "快速预览，小视频更快出结果" },
  balanced: { label: "平衡", mode: "balanced", description: "默认推荐，CPU 环境稳定可用" },
  quality: { label: "效果优先", mode: "high_quality", description: "优先使用 GPU/模型能力，不可用则自动降级" }
};

export function ProcessingPanel({
  apiBaseUrl,
  video,
  displayRect,
  videoRect,
  currentTime,
  maskPreview,
  repairPreview,
  autoDetectResult,
  isAutoDetecting,
  workflowMode,
  jobId,
  progress,
  onProgress,
  onWorkflowModeChange,
  onAutoDetect,
  onStart,
  onCancel,
  onPreviewEffect,
  onError
}: Props) {
  const [strength, setStrength] = useState<StrengthPreset>("standard");
  const [quality, setQuality] = useState<QualityPreset>("balanced");
  const [advanced, setAdvanced] = useState<AdvancedOptions>(STRENGTH_PRESETS.standard);
  const [useAdvanced, setUseAdvanced] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [pollFailureCount, setPollFailureCount] = useState(0);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const options = useMemo(() => buildOptions(strength, quality, useAdvanced ? advanced : null), [advanced, quality, strength, useAdvanced]);

  useEffect(() => {
    if (!useAdvanced) {
      setAdvanced(STRENGTH_PRESETS[strength]);
    }
  }, [strength, useAdvanced]);

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
      setPollFailureCount(0);
      setPollMessage(null);
      setLastProgressAt(null);
      return;
    }

    let isActive = true;
    let retryTimer: number | null = null;
    let failureCount = 0;

    const scheduleNextPoll = (delayMs: number) => {
      retryTimer = window.setTimeout(poll, delayMs);
    };

    const poll = async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch(`${apiBaseUrl}/api/status/${jobId}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error("进度获取失败");
        }
        const payload = (await response.json()) as ProgressState;
        if (!isActive) {
          return;
        }
        failureCount = 0;
        setPollFailureCount(0);
        setPollMessage(null);
        setLastProgressAt(Date.now());
        onError(null);
        onProgress(payload);
        if (isTerminalStatus(payload.status)) {
          if (payload.status === "failed") {
            onError(payload.error ?? payload.message ?? "任务处理失败");
          }
          return;
        }
        scheduleNextPoll(900);
      } catch {
        if (isActive) {
          failureCount += 1;
          setPollFailureCount(failureCount);
          setPollMessage(failureCount <= 3 ? "正在重新连接进度..." : "进度连接不稳定，但任务可能仍在运行");
          scheduleNextPoll(Math.min(3500, 900 + failureCount * 400));
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };

    setPollFailureCount(0);
    setPollMessage(null);
    setLastProgressAt(null);
    poll();

    return () => {
      isActive = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [apiBaseUrl, jobId, onError, onProgress]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function runAutoDetect() {
    onError(null);
    try {
      await onAutoDetect();
    } catch (error) {
      onError(error instanceof Error ? error.message : "自动识别字幕区域失败");
    }
  }

  async function runPreviewEffect() {
    setIsPreviewing(true);
    onError(null);
    try {
      await onPreviewEffect(options);
    } catch (error) {
      onError(error instanceof Error ? error.message : "预览效果失败");
    } finally {
      setIsPreviewing(false);
    }
  }

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
  const stage = getProgressStage(progress);
  const outputPath = getOutputPath(progress);
  const downloadUrl = progress && isCompleteStatus(progress.status) && outputPath ? `${apiBaseUrl}${outputPath}` : null;
  const canProcess = Boolean(video && videoRect && videoRect.width > 0 && videoRect.height > 0);
  const isProcessing = Boolean(jobId && progress?.status === "processing");
  const actualEngine = progress?.engine || engineStatus?.actual_engine || "Temporal OpenCV";
  const engineHint = getEngineHint(options.repair_mode, actualEngine, engineStatus);
  const frameText = frameProgressText(progress);
  const lastUpdateText = lastProgressAt ? formatLastUpdated(lastProgressAt, clock) : "-";

  return (
    <div className="control-stack">
      <section className="tool-card one-click-card">
        <div className="card-title">
          <span>一键去字幕</span>
          <small>{actualEngine}</small>
        </div>
        <p className="hint">{engineHint}</p>

        <div className="mode-switch">
          <button type="button" className={workflowMode === "smart" ? "active" : ""} onClick={() => onWorkflowModeChange("smart")}>
            智能全消
            <small>自动识别常规字幕</small>
          </button>
          <button type="button" className={workflowMode === "manual" ? "active" : ""} onClick={() => onWorkflowModeChange("manual")}>
            手动框选
            <small>适合复杂画面</small>
          </button>
        </div>

        <div className="choice-section">
          <strong>去除强度</strong>
          <div className="choice-grid">
            {(["light", "standard", "strong"] as const).map((value) => (
              <button key={value} type="button" className={strength === value ? "choice-button active" : "choice-button"} onClick={() => setStrength(value)}>
                <span>{STRENGTH_PRESETS[value].label}</span>
                <small>{STRENGTH_PRESETS[value].description}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="choice-section">
          <strong>处理偏好</strong>
          <div className="choice-grid">
            {(["speed", "balanced", "quality"] as const).map((value) => (
              <button key={value} type="button" className={quality === value ? "choice-button active" : "choice-button"} onClick={() => setQuality(value)}>
                <span>{QUALITY_PRESETS[value].label}</span>
                <small>{QUALITY_PRESETS[value].description}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="tool-card steps-card">
        <div className="card-title">
          <span>处理流程</span>
          <small>{progress?.status ?? "idle"}</small>
        </div>
        <StepItem index={1} title="上传视频" state={video ? "done" : "active"} detail={video?.filename ?? "选择 mp4、mov 或 webm"} />
        <StepItem
          index={2}
          title="识别字幕"
          state={autoDetectResult ? "done" : isAutoDetecting ? "active" : video ? "active" : "idle"}
          detail={autoDetectResult ? `置信度 ${Math.round(autoDetectResult.confidence * 100)}%` : isAutoDetecting ? "正在自动分析字幕位置" : "上传后自动开始"}
        />
        <StepItem index={3} title="预览效果" state={repairPreview ? "done" : maskPreview ? "active" : "idle"} detail={maskPreview ? `mask ${(maskPreview.mask_coverage * 100).toFixed(1)}% · ${maskPreview.components_count} 个组件` : "先查看将被擦除的像素"} />
        <StepItem index={4} title="开始处理" state={isProcessing ? "active" : isCompleteStatus(progress?.status ?? "idle") ? "done" : "idle"} detail={stage ? stepLabel(stage) : "生成完整视频"} />
        <StepItem index={5} title="下载结果" state={downloadUrl ? "done" : "idle"} detail={downloadUrl ? "结果已生成" : "完成后下载 mp4"} />

        <div className="action-grid">
          <button type="button" className="ghost-button" disabled={!video || isAutoDetecting} onClick={runAutoDetect}>
            {isAutoDetecting ? "识别中" : "自动识别字幕"}
          </button>
          <button type="button" className="ghost-button" disabled={!canProcess || isPreviewing} onClick={runPreviewEffect}>
            {isPreviewing ? "预览中" : "预览效果"}
          </button>
          <button type="button" className="primary-button" disabled={!canProcess || isSubmitting || isProcessing} onClick={handleStart}>
            {isSubmitting ? "提交中" : "开始去字幕"}
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
          <span>状态反馈</span>
          <small>{percentage}%</small>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percentage}%` }} />
        </div>
        {pollMessage ? <div className={`poll-warning ${pollFailureCount > 3 ? "unstable" : ""}`}>{pollMessage}</div> : null}
        {autoDetectResult?.warning ? <div className="soft-warning">{autoDetectResult.warning}</div> : null}
        {maskPreview?.warning ? <div className="soft-warning">{maskPreview.warning}</div> : null}
        <InfoGrid
          items={[
            ["当前步骤", stage ? stepLabel(stage) : "-"],
            ["当前帧", frameText],
            ["最后更新", lastUpdateText],
            ["后端信息", progress?.message ?? autoDetectResult?.reason ?? "等待开始处理"],
            ["错误信息", progress?.error ?? "-"]
          ]}
        />
      </section>

      <details className="tool-card">
        <summary>文件与字幕区域</summary>
        <InfoGrid
          items={[
            ["文件名", video?.filename ?? "-"],
            ["文件大小", video ? formatBytes(video.fileSize) : "-"],
            ["分辨率", video ? `${video.width} × ${video.height}` : "-"],
            ["时长", video ? formatTime(video.duration) : "-"],
            ["自动识别", autoDetectResult ? `${Math.round(autoDetectResult.confidence * 100)}%` : "-"],
            ["当前时间", formatTime(currentTime)]
          ]}
        />
        <div className="coord-section">
          <strong>屏幕显示坐标</strong>
          <CoordGrid rect={displayRect} />
        </div>
        <div className="coord-section">
          <strong>真实视频坐标</strong>
          <CoordGrid rect={videoRect} />
        </div>
      </details>

      <details className="tool-card">
        <summary>高级设置</summary>
        <SwitchField label="启用高级参数覆盖" checked={useAdvanced} onChange={setUseAdvanced} />
        <RangeField label="检测灵敏度" value={advanced.detection_sensitivity} min={0.15} max={1} step={0.01} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, detection_sensitivity: value })} />
        <RangeField label="时间窗口" value={advanced.temporal_window} min={0} max={8} step={1} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, temporal_window: value })} />
        <RangeField label="mask 扩张" value={advanced.mask_dilate} min={0} max={30} step={1} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, mask_dilate: value })} />
        <RangeField label="feather" value={advanced.feather_radius} min={0} max={20} step={1} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, feather_radius: value })} />
        <NumberField label="min component area" value={advanced.min_component_area} min={1} max={10000} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, min_component_area: value })} />
        <NumberField label="max component area" value={advanced.max_component_area} min={4} max={250000} disabled={!useAdvanced} onChange={(value) => setAdvanced({ ...advanced, max_component_area: value })} />
      </details>
    </div>
  );
}

function buildOptions(strength: StrengthPreset, quality: QualityPreset, advanced: AdvancedOptions | null): ProcessOptions {
  const strengthPreset = STRENGTH_PRESETS[strength];
  const tuning = advanced ?? strengthPreset;
  return {
    repair_mode: QUALITY_PRESETS[quality].mode,
    inpaint_strength: strengthPreset.inpaint_strength,
    detection_sensitivity: tuning.detection_sensitivity,
    min_component_area: tuning.min_component_area,
    max_component_area: tuning.max_component_area,
    mask_dilate: tuning.mask_dilate,
    feather_radius: tuning.feather_radius,
    temporal_window: tuning.temporal_window,
    use_neighbor_frames: quality !== "speed",
    preserve_edges: true,
    keep_audio: true,
    method: "TELEA"
  };
}

function StepItem({ index, title, detail, state }: { index: number; title: string; detail: string; state: "idle" | "active" | "done" }) {
  return (
    <div className={`step-item ${state}`}>
      <span>{state === "done" ? "✓" : index}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function RangeField({ label, value, min, max, step, disabled, onChange }: { label: string; value: number; min: number; max: number; step: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}：{typeof value === "number" && step < 1 ? value.toFixed(2) : value}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function NumberField({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="number-input" type="number" min={min} max={max} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
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

function getEngineHint(mode: ProcessOptions["repair_mode"], engine: string, status: EngineStatus | null) {
  if (mode === "high_quality" && engine === "Temporal OpenCV") {
    return "当前服务器未启用 GPU 高质量引擎，正在使用 Temporal OpenCV。想要更干净效果，需要启用 ProPainter、LaMa 或 GPU API。";
  }
  if (status?.capabilities.gpu_api?.enabled) {
    return "GPU API 已配置，高质量模式会优先尝试外部 GPU 引擎。";
  }
  if (engine === "OpenCV") {
    return "速度优先模式使用 OpenCV，适合快速预览。";
  }
  return "默认使用 CPU 增强处理：文字级 mask、前后帧融合和边缘收口。";
}

function getProgressStage(progress: ProgressState | null): ProgressStage | undefined {
  return progress?.stage ?? progress?.step;
}

function isCompleteStatus(status: ProgressState["status"]) {
  return status === "completed" || status === "done";
}

function isTerminalStatus(status: ProgressState["status"]) {
  return isCompleteStatus(status) || status === "failed" || status === "cancelled";
}

function getOutputPath(progress: ProgressState | null) {
  return progress?.output_url ?? progress?.download_url ?? null;
}

function frameProgressText(progress: ProgressState | null) {
  if (!progress?.total_frames) {
    return "-";
  }
  return `${progress.current_frame ?? 0} / ${progress.total_frames}`;
}

function formatLastUpdated(lastProgressAt: number, now: number) {
  const seconds = Math.max(0, Math.round((now - lastProgressAt) / 1000));
  return seconds <= 1 ? "刚刚" : `${seconds} 秒前`;
}

function stepLabel(step: ProgressStage) {
  const labels: Record<ProgressStage, string> = {
    uploaded: "上传完成",
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
