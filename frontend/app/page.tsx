"use client";

import { useEffect, useMemo, useState } from "react";
import { ProcessingPanel, type ProcessOptions, type ProgressState } from "../components/ProcessingPanel";
import { VideoAnnotator, type SelectionState, type VideoMetadata } from "../components/VideoAnnotator";
import { VideoUploader, type UploadedVideo } from "../components/VideoUploader";

const RAW_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");

const STRENGTH_TO_RADIUS: Record<ProcessOptions["inpaint_strength"], number> = {
  low: 2,
  medium: 3,
  high: 5
};

export default function Home() {
  const [video, setVideo] = useState<UploadedVideo | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (video?.preview_url) {
        URL.revokeObjectURL(video.preview_url);
      }
    };
  }, [video?.preview_url]);

  const outputUrl = useMemo(() => {
    if (!progress?.download_url || !["completed", "done"].includes(progress.status)) {
      return null;
    }
    return `${API_BASE_URL}${progress.download_url}`;
  }, [progress]);

  function handleUploaded(uploaded: UploadedVideo) {
    setVideo((current) => {
      if (current?.preview_url) {
        URL.revokeObjectURL(current.preview_url);
      }
      return uploaded;
    });
    setSelection(null);
    setJobId(null);
    setProgress({ status: "upload", progress: 0.05, stage_progress: 1, message: "视频已上传，正在读取本地预览", download_url: null });
    setError(null);
  }

  function handleVideoMetadata(metadata: VideoMetadata) {
    setVideo((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        width: metadata.width || current.width,
        height: metadata.height || current.height,
        duration: metadata.duration || current.duration
      };
    });
  }

  function handleCancel() {
    setJobId(null);
    setProgress((current) =>
      current && !["completed", "done", "canceled", "failed"].includes(current.status)
        ? { ...current, status: "canceled", message: "正在取消任务" }
        : current
    );
    if (jobId) {
      fetch(`${API_BASE_URL}/api/cancel/${jobId}`, { method: "POST" }).catch(() => undefined);
    }
  }

  async function startProcessing(options: ProcessOptions) {
    if (!video || !selection) {
      return;
    }

    const rect = selection.videoRect;
    setError(null);
    setProgress({ status: "upload", progress: 0.08, stage_progress: 1, message: "任务已提交", download_url: null });

    const response = await fetch(`${API_BASE_URL}/api/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        video_id: video.video_id,
        rect,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        video_width: video.width,
        video_height: video.height,
        inpaint_strength: options.inpaint_strength,
        repair_mode: options.repair_mode,
        detection_sensitivity: options.detection_sensitivity,
        temporal_window: options.temporal_window,
        min_component_area: options.min_component_area,
        max_component_area: options.max_component_area,
        mask_dilate: options.mask_dilate,
        feather_radius: options.feather_radius,
        ocr_confirm: options.ocr_confirm,
        keep_audio: options.keep_audio,
        options: {
          inpaint_strength: options.inpaint_strength,
          repair_mode: options.repair_mode,
          detection_sensitivity: options.detection_sensitivity,
          temporal_window: options.temporal_window,
          min_component_area: options.min_component_area,
          max_component_area: options.max_component_area,
          mask_dilate: options.mask_dilate,
          feather_radius: options.feather_radius,
          ocr_confirm: options.ocr_confirm,
          keep_audio: options.keep_audio,
          inpaint_radius: STRENGTH_TO_RADIUS[options.inpaint_strength]
        }
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "处理任务提交失败");
    }

    const payload = (await response.json()) as { job_id: string; status: ProgressState["status"] };
    setJobId(payload.job_id);
    setProgress({
      status: payload.status ?? "uploaded",
      progress: 0.1,
      stage_progress: 0,
      message: "后端已接收处理任务",
      download_url: null
    });
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">SR</div>
          <div>
            <strong>Subtitle Remover</strong>
            <span>视频去字幕处理台</span>
          </div>
        </div>
        <div className="header-status">
          <span>{video ? `${video.width} x ${video.height}` : "等待上传"}</span>
          <strong>{selection ? "已选择字幕区域" : "未选择区域"}</strong>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="left-column">
          {video ? (
            <VideoAnnotator
              key={video.video_id}
              video={video}
              videoUrl={video.preview_url}
              outputUrl={outputUrl}
              selection={selection}
              onSelectionChange={setSelection}
              onVideoMetadata={handleVideoMetadata}
            />
          ) : (
            <section className="viewer-panel empty-viewer">
              <div>
                <span className="eyebrow">Preview</span>
                <h1>上传视频后开始处理</h1>
                <p>左侧会显示本地 HTML5 视频预览，可播放、暂停、拖动时间轴并框选字幕区域。</p>
              </div>
            </section>
          )}
        </section>

        <section className="right-column">
          <VideoUploader apiBaseUrl={API_BASE_URL} video={video} onUploaded={handleUploaded} />
          <ProcessingPanel
            apiBaseUrl={API_BASE_URL}
            video={video}
            selection={selection}
            jobId={jobId}
            progress={progress}
            onProgress={setProgress}
            onResetSelection={() => setSelection(null)}
            onStart={startProcessing}
            onCancel={handleCancel}
            onError={setError}
          />
        </section>
      </div>

      {error ? <div className="toast error">{error}</div> : null}
    </main>
  );
}
