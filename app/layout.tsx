import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "镜序 · AI 影像创作台",
  description: "从文字、图片和视频生成可执行的影像提示词与参考素材",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
