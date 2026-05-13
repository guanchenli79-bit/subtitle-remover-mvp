"use client";

import { useEffect, useMemo, useState } from "react";
import { ProcessingPanel, type MaskPreview, type ProcessOptions, type ProgressState } from "../components/ProcessingPanel";
import { VideoAnnotator, type DisplayRect, type RepairPreview, type VideoMetadata, type VideoRect } from "../components/VideoAnnotator";
import { VideoUploader, type UploadedVideo } from "../components/VideoUploader";

const RAW_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");

export default function Home() {
  const [video, setVideo] = useState<UploadedVideo | null>(null);
  const [displayRect, setDisplayRect] = useState<DisplayRect | null>(null);
  const [videoRect, setVideoRect] = useState<VideoRect | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [maskPreview, setMaskPreview] = useState<MaskPreview | null>(null);
  const [repairPreview, setRepairPreview] = useState<RepairPreview | null>(null);
  const [showMaskOverlay, setShowMaskOverlay] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (video?.previewUrl) {
        URL.revokeObjectURL(video.previewUrl);
      }
    };
  }, [video?.previewUrl]);

  const downloadUrl = useMemo(() => {
    if (progress?.status !== "done" || !progress.download_url) {
      return null;
    }
    return `${API_BASE_URL}${progress.download_url}`;
  }, [progress]);

  function handleUploaded(uploaded: UploadedVideo) {
    if (video?.previewUrl) {
      URL.revokeObjectURL(video.previewUrl);
    }
    setVideo(uploaded);
    setDisplayRect(null);
    setVideoRect(null);
    setJobId(null);
    setCurrentTime(0);
    setMaskPreview(null);
    setRepairPreview(null);
    setProgress({ status: "idle", step: "uploaded", progress: 0.02, message: "上传完成", download_url: null });
    setError(null);
  }

  function handleSelectionChange(nextDisplayRect: DisplayRect | null, nextVideoRect: VideoRect | null) {
    setDisplayRect(nextDisplayRect);
    setVideoRect(nextVideoRect);
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

  async function startProcessing(options: ProcessOptions) {
    if (!video || !videoRect) {
      return;
    }

    setError(null);
    setProgress({ status: "processing", step: "uploaded", progress: 0.03, message: "提交任务中", download_url: null });

    const response = await fetch(`${API_BASE_URL}/api/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        video_id: video.video_id,
        x: videoRect.x,
        y: videoRect.y,
        width: videoRect.width,
        height: videoRect.height,
        video_width: video.width,
        video_height: video.height,
        rect: {
          ...videoRect,
          video_width: video.width,
          video_height: video.height
        },
        options
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "处理任务提交失败");
    }

    const payload = (await response.json()) as { job_id: string; status: string; engine?: string };
    setJobId(payload.job_id);
    if (payload.engine) {
      setProgress((current) => current ? { ...current, engine: payload.engine } : current);
    }
  }

  async function cancelJob(targetJobId: string) {
    const response = await fetch(`${API_BASE_URL}/api/cancel/${targetJobId}`, {
      method: "POST"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "取消失败");
    }
    const payload = (await response.json()) as ProgressState;
    setProgress(payload);
  }

  async function previewMask(options: ProcessOptions) {
    if (!video || !videoRect) {
      return;
    }
    const response = await fetch(`${API_BASE_URL}/api/preview-mask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPreviewPayload(video, videoRect, currentTime, options))
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "mask 预览失败");
    }
    const payload = (await response.json()) as MaskPreview;
    setMaskPreview({
      ...payload,
      mask_preview_url: `${API_BASE_URL}${payload.mask_preview_url}`,
      debug_overlay_url: payload.debug_overlay_url ? `${API_BASE_URL}${payload.debug_overlay_url}` : undefined
    });
    setShowMaskOverlay(true);
  }

  async function previewRepair(options: ProcessOptions) {
    if (!video || !videoRect) {
      return;
    }
    const response = await fetch(`${API_BASE_URL}/api/preview-repair-frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPreviewPayload(video, videoRect, currentTime, options))
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "当前帧修复预览失败");
    }
    const payload = (await response.json()) as RepairPreview & { before_url: string; after_url: string };
    setRepairPreview({
      ...payload,
      before_url: `${API_BASE_URL}${payload.before_url}`,
      after_url: `${API_BASE_URL}${payload.after_url}`
    });
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">VS</div>
          <div>
            <strong>视频去字幕工具</strong>
            <span>本地处理管线 · ROI mask · Inpaint</span>
          </div>
        </div>
        <div className="header-meta">
          <span>Railway 单服务部署</span>
          <span>请只处理自己拥有版权或有授权的视频</span>
        </div>
      </header>

      <section className="top-status-bar">
        <span>当前文件：{video?.filename ?? "-"}</span>
        <span>分辨率：{video ? `${video.width}×${video.height}` : "-"}</span>
        <span>时长：{video ? `${video.duration.toFixed(1)}s` : "-"}</span>
        <span>当前模式：{progress?.engine ?? "Temporal OpenCV"}</span>
        <span>进度：{progress ? `${Math.round(progress.progress * 100)}%` : "0%"}</span>
      </section>

      <div className="workspace-grid">
        <section className="left-pane">
          {video ? (
            <VideoAnnotator
              video={video}
              videoUrl={video.previewUrl}
              outputUrl={downloadUrl}
              maskPreviewUrl={maskPreview?.mask_preview_url ?? null}
              showMaskOverlay={showMaskOverlay}
              repairPreview={repairPreview}
              displayRect={displayRect}
              videoRect={videoRect}
              onSelectionChange={handleSelectionChange}
              onVideoMetadata={handleVideoMetadata}
              onTimeChange={setCurrentTime}
              onToggleMaskOverlay={() => setShowMaskOverlay((value) => !value)}
            />
          ) : (
            <section className="video-workbench empty-workbench">
              <div>
                <h1>上传视频后开始预览与框选</h1>
                <p>支持横屏与竖屏视频，预览区会按原始比例完整显示。</p>
              </div>
            </section>
          )}
        </section>

        <aside className="right-pane">
          <VideoUploader apiBaseUrl={API_BASE_URL} video={video} onUploaded={handleUploaded} />
          <ProcessingPanel
            apiBaseUrl={API_BASE_URL}
            video={video}
            displayRect={displayRect}
            videoRect={videoRect}
            currentTime={currentTime}
            maskPreview={maskPreview}
            repairPreview={repairPreview}
            jobId={jobId}
            progress={progress}
            onProgress={setProgress}
            onStart={startProcessing}
            onCancel={cancelJob}
            onPreviewMask={previewMask}
            onPreviewRepair={previewRepair}
            onError={setError}
          />
        </aside>
      </div>

      {error ? <div className="toast error">{error}</div> : null}
    </main>
  );
}

function buildPreviewPayload(video: UploadedVideo, rect: VideoRect, time: number, options: ProcessOptions) {
  return {
    video_id: video.video_id,
    time,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    video_width: video.width,
    video_height: video.height,
    rect: {
      ...rect,
      video_width: video.width,
      video_height: video.height
    },
    options
  };
}
