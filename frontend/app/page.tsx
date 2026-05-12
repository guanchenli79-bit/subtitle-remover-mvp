"use client";

import { useMemo, useState } from "react";
import { ProcessingPanel, type ProcessOptions, type ProgressState } from "../components/ProcessingPanel";
import { VideoAnnotator, type OriginalRect } from "../components/VideoAnnotator";
import { VideoUploader, type UploadedVideo } from "../components/VideoUploader";

const RAW_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");

export default function Home() {
  const [video, setVideo] = useState<UploadedVideo | null>(null);
  const [rect, setRect] = useState<OriginalRect | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoUrl = useMemo(() => {
    if (!video) {
      return null;
    }
    return `${API_BASE_URL}/api/video/${video.video_id}`;
  }, [video]);

  const downloadUrl = useMemo(() => {
    if (progress?.status !== "done" || !progress.download_url) {
      return null;
    }
    return `${API_BASE_URL}${progress.download_url}`;
  }, [progress]);

  function handleUploaded(uploaded: UploadedVideo) {
    setVideo(uploaded);
    setRect(null);
    setJobId(null);
    setProgress(null);
    setError(null);
  }

  async function startProcessing(options: ProcessOptions) {
    if (!video || !rect) {
      return;
    }

    setError(null);
    setProgress({ status: "processing", progress: 0, message: "提交任务中", download_url: null });

    const response = await fetch(`${API_BASE_URL}/api/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        video_id: video.video_id,
        rect,
        options
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail ?? "处理任务提交失败");
    }

    const payload = (await response.json()) as { job_id: string; status: string };
    setJobId(payload.job_id);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">▶</div>
          <div>
            <strong>字幕净化</strong>
            <span>智能去字幕工具</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="主导航">
          <a href="#">首页</a>
          <a href="#">功能</a>
          <a href="#">使用说明</a>
          <a className="active" href="#">控制台</a>
        </nav>

        <div className="header-actions">
          <button type="button" aria-label="切换主题">☼</button>
          <span>本地模式</span>
        </div>
      </header>

      <div className="console-grid">
        <section className="left-column">
          {video && videoUrl ? (
            <VideoAnnotator
              key={video.video_id}
              video={video}
              videoUrl={videoUrl}
              outputUrl={downloadUrl}
              rect={rect}
              onRectChange={setRect}
            />
          ) : (
            <div className="preview-card empty-preview">
              <div>
                <h1>视频去字幕工具</h1>
                <p>上传视频后，在画面上拖动鼠标框选字幕所在区域。</p>
              </div>
            </div>
          )}
        </section>

        <aside className="right-column">
          <VideoUploader apiBaseUrl={API_BASE_URL} video={video} onUploaded={handleUploaded} />

          <ProcessingPanel
            apiBaseUrl={API_BASE_URL}
            hasVideo={Boolean(video)}
            canProcess={Boolean(video && rect)}
            jobId={jobId}
            rect={rect}
            progress={progress}
            onProgress={setProgress}
            onResetRect={() => setRect(null)}
            onStart={startProcessing}
            onError={setError}
          />
        </aside>
      </div>

      <p className="copyright-tip">请只处理自己拥有版权或有授权的视频。</p>

      {error ? <div className="toast error">{error}</div> : null}
    </main>
  );
}
