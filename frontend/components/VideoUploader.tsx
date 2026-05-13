"use client";

import { ChangeEvent, useRef, useState } from "react";

export type UploadedVideo = {
  video_id: string;
  filename: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  previewUrl: string;
  fileSize: number;
  mimeType: string;
};

type Props = {
  apiBaseUrl: string;
  video: UploadedVideo | null;
  onUploaded: (video: UploadedVideo) => void;
};

export function VideoUploader({ apiBaseUrl, video, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string>("选择一个视频开始");

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setMessage(file ? `${file.name} · ${formatBytes(file.size)}` : "选择一个视频开始");
  }

  async function uploadSelected() {
    if (!selectedFile) {
      setMessage("请选择 mp4、mov 或 webm 视频");
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    setIsUploading(true);
    setMessage("正在上传并分析视频");
    try {
      const response = await fetch(`${apiBaseUrl}/api/upload`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail ?? "上传失败");
      }

      const uploaded = (await response.json()) as Omit<UploadedVideo, "previewUrl" | "fileSize" | "mimeType">;
      const previewUrl = URL.createObjectURL(selectedFile);
      onUploaded({
        ...uploaded,
        previewUrl,
        fileSize: selectedFile.size,
        mimeType: selectedFile.type
      });
      setMessage("上传完成，可以框选字幕区域");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="tool-card upload-card">
      <div className="card-title">
        <span>素材</span>
        <small>MP4 / MOV / WEBM，最大 500MB</small>
      </div>

      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
        onChange={handleFileChange}
      />

      <div className="upload-actions">
        <button type="button" className="ghost-button" onClick={() => inputRef.current?.click()}>
          选择视频
        </button>
        <button type="button" className="primary-button" disabled={isUploading || !selectedFile} onClick={uploadSelected}>
          {isUploading ? "上传中" : "上传视频"}
        </button>
      </div>

      <div className="upload-status">
        <strong>{video?.filename ?? selectedFile?.name ?? "未选择文件"}</strong>
        <span>{message}</span>
      </div>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
