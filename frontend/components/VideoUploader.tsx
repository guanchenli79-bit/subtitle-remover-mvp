"use client";

import { ChangeEvent, useRef, useState } from "react";

export type UploadedVideo = {
  video_id: string;
  filename: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  size: number;
  preview_url: string;
};

type UploadResponse = Omit<UploadedVideo, "preview_url" | "size"> & {
  size?: number;
  video_width?: number;
  video_height?: number;
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  onUploaded: (video: UploadedVideo) => void;
};

export function VideoUploader({ apiBaseUrl, video, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedName, setSelectedName] = useState<string>("未选择文件");
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setSelectedName(file.name);
    setSelectedSize(file.size);
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

      const uploaded = (await response.json()) as UploadResponse;
      const previewUrl = URL.createObjectURL(file);
      onUploaded({
        ...uploaded,
        width: uploaded.video_width ?? uploaded.width,
        height: uploaded.video_height ?? uploaded.height,
        size: uploaded.size ?? file.size,
        preview_url: previewUrl
      });
      setMessage(`${uploaded.width} x ${uploaded.height} · ${uploaded.fps} fps`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="panel upload-panel">
      <div className="panel-heading">
        <span className="eyebrow">Source</span>
        <h2>视频文件</h2>
      </div>

      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
        onChange={handleFileChange}
      />

      <button type="button" className="upload-drop" onClick={() => inputRef.current?.click()}>
        <span className="upload-icon">+</span>
        <strong>选择视频</strong>
        <small>MP4 / MOV / WEBM · 最大 500MB</small>
      </button>

      <div className="file-summary">
        <div className="file-thumb">▶</div>
        <div>
          <strong>{video?.filename ?? selectedName}</strong>
          <span>{video ? `${video.width} x ${video.height}` : selectedSize ? formatBytes(selectedSize) : "等待上传"}</span>
        </div>
      </div>

      <button type="button" className="primary-button full-width" disabled={isUploading} onClick={uploadSelected}>
        {isUploading ? "上传中" : "上传并创建本地预览"}
      </button>

      <div className="status-line">{message ? <span>{message}</span> : null}</div>
    </section>
  );
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
