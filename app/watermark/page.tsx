"use client";

import Link from "next/link";
import AppShell from "@/components/AppShell";
import WatermarkBatchUploader from "@/components/WatermarkBatchUploader";

export default function WatermarkPage() {
  return <AppShell active="/watermark">
    <div className="mx-auto max-w-3xl space-y-4 py-4 sm:py-8">
      <WatermarkBatchUploader />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-500">
        <p>自动剪辑也共用这套处理能力，无需先在这里去水印。</p>
        <Link className="rounded text-indigo-600 underline underline-offset-4 focus-visible:outline focus-visible:outline-2" href="/tasks">查看处理任务</Link>
      </div>
      <p className="text-xs leading-6 text-zinc-500">只修补有画面依据的安全区域；遮挡主体或无法可靠识别的部分会说明并保留，不承诺无痕恢复。</p>
    </div>
  </AppShell>;
}
