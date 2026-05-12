import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "视频去字幕工具",
  description: "本地视频去字幕 MVP"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
