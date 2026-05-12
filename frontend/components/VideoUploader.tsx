"use client";

import { ChangeEvent, useRef, useState } from "react";

export type UploadedVideo = {
  video_id: string;
  filename: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  onUploaded: (video: UploadedVideo) => void;
};

export function VideoUploader({ apiBaseUrl, video, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedName, setSelectedName] = useState<string>("未选择文件");
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setSelectedName(file.name);
    setMessage(null);
  }

  async function uploadSelected() {
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setMessage("请选择 mp4、mov 或 webm 视频");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setIsUploading(true);
    setMessage("上传中");
    try {
      const response = await fetch(`${apiBaseUrl}/api/upload`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail ?? "上传失败");
      }

      const uploaded = (await response.json()) as UploadedVideo;
      onUploaded(uploaded);
      setMessage(`${uploaded.width} × ${uploaded.height} · ${uploaded.fps} fps`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="control-card upload-panel">
      <div className="step-heading">
        <h2>1. 上传视频</h2>
      </div>

      <div className="upload-row">
        <input
          ref={inputRef}
          className="file-input"
          type="file"
          accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
          onChange={handleFileChange}
        />

        <button type="button" className="upload-drop" onClick={() => inputRef.current?.click()}>
          <span className="upload-icon">⇧</span>
          <strong>上传视频</strong>
          <small>支持 MP4 / MOV / WEBM，文件 ≤ 500MB</small>
        </button>

        <div className="uploaded-file">
          <div className="file-thumb">▶</div>
          <div>
            <strong>{video?.filename ?? selectedName}</strong>
            <span>{video ? `${video.width} × ${video.height} · ${video.fps} fps` : "等待选择视频"}</span>
          </div>
          {video ? <span className="ok-dot">✓</span> : null}
        </div>
      </div>

      <button type="button" className="primary-button full-width upload-confirm" disabled={isUploading} onClick={uploadSelected}>
        {isUploading ? "上传中" : "确认上传"}
      </button>

      <div className="file-line">{message ? <strong>{message}</strong> : null}</div>
    </section>
  );
}
