"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eraser, Upload, X, Loader2, Video, ArrowRight, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { apiGet, apiSend } from "@/lib/client";
import { uploadVideoFile } from "@/lib/video-client";
import type { VideoOut } from "@/lib/types";
import { WATERMARK_BATCH_MAX_FILES, watermarkFileProblem, type WatermarkBatchItem } from "@/lib/watermark-batch-contract";

type Draft = {
  id: string; batchId: string; name: string; size: number; file?: File; videoId?: string;
  fingerprint: string; status: "ready" | "uploading" | "submitting" | "error" | "accepted";
  percent: number; note?: string;
};
// getRandomValues also works on the company's HTTP LAN; randomUUID may not.
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function sizeLabel(size: number): string { return `${(size / 1024 / 1024).toFixed(1)} MB`; }
const active = (status: string) => ["waiting", "pending", "running"].includes(status);
function stateLabel(status: string): string {
  return ({ waiting: "等待名额", pending: "排队中", running: "处理中", succeeded: "处理结束 · 请查看结果", failed: "需要处理 · 查看原因", canceled: "已取消", deleted: "任务已删除" } as Record<string,string>)[status] ?? status;
}

export default function WatermarkBatchUploader() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const draftRef = useRef<Draft[]>([]);
  const [items, setItems] = useState<WatermarkBatchItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [videos, setVideos] = useState<VideoOut[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const batchId = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const loading = useRef(false);
  const itemsRef = useRef<WatermarkBatchItem[]>([]);
  const changeDrafts = useCallback((next: Draft[] | ((current: Draft[]) => Draft[])) => {
    draftRef.current = typeof next === "function" ? next(draftRef.current) : next;
    if (mounted.current) setDrafts(draftRef.current);
  }, []);
  const update = (id: string, patch: Partial<Draft>) => changeDrafts((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const result = await apiGet<{ items: WatermarkBatchItem[] }>("/api/watermark-batches");
      if (!mounted.current) return;
      itemsRef.current = result.items; setItems(result.items); setLoadError("");
    } catch (error) { if (mounted.current) setLoadError(error instanceof Error ? error.message : "暂时无法读取处理清单"); }
    finally { loading.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && (itemsRef.current.some((item) => active(item.status)) || draftRef.current.some((item) => item.status === "accepted"))) void refresh();
    }, 5000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const hasUnsent = () => draftRef.current.some((item) => item.status !== "accepted");
    const beforeUnload = (event: BeforeUnloadEvent) => { if (hasUnsent()) { event.preventDefault(); event.returnValue = ""; } };
    const beforeNavigate = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.("a[href]");
      if (!anchor || !hasUnsent() || event.defaultPrevented || event.ctrlKey || event.metaKey || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm("还有视频未上传或未提交。离开会停止这些视频，已加入后台的处理不受影响。确定离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeNavigate, true);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; controllerRef.current?.abort(); window.clearInterval(timer);
      window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", beforeNavigate, true); document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const addFiles = (files: File[]) => {
    if (controllerRef.current) return;
    const next = [...draftRef.current];
    const errors: string[] = [];
    batchId.current ??= newId();
    for (const file of files) {
      const issue = watermarkFileProblem(file);
      if (issue) { errors.push(`${file.name}：${issue}`); continue; }
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
      if (next.some((row) => row.fingerprint === fingerprint)) continue;
      if (next.length >= WATERMARK_BATCH_MAX_FILES) { errors.push("一次最多添加20条视频，其余未添加"); break; }
      next.push({ id: newId(), batchId: batchId.current, name: file.name, size: file.size, file, fingerprint, status: "ready", percent: 0 });
    }
    changeDrafts(next);
    if (errors.length) toast.error(errors.slice(0,3).join("；"));
  };
  const openLibrary = async () => {
    setLibraryOpen((value) => !value);
    if (libraryOpen) return;
    try {
      const [result, session] = await Promise.all([apiGet<{ videos: VideoOut[] }>("/api/videos"), apiGet<{ user: { username: string } }>("/api/auth/me")]);
      setVideos(result.videos.filter((video) => video.uploadedBy === session.user.username)); setLibraryError("");
    } catch { setLibraryError("素材暂时加载不了，请收起后重新打开"); }
  };
  const addExisting = (video: VideoOut) => {
    if (draftRef.current.length >= WATERMARK_BATCH_MAX_FILES) { toast.error("一次最多添加20条视频"); return; }
    batchId.current ??= newId();
    if (draftRef.current.some((row) => row.videoId === video.id)) return;
    changeDrafts((current) => [...current, { id: newId(), batchId: batchId.current!, name: video.name, size: video.size, videoId: video.id, fingerprint: video.id, status: "ready", percent: 100 }]);
  };

  const start = async () => {
    if (controllerRef.current) return;
    const controller = new AbortController(); controllerRef.current = controller; setBusy(true);
    const selected = draftRef.current.filter((row) => row.status !== "accepted");
    for (const initial of selected) {
      if (controller.signal.aborted) break;
      let row = draftRef.current.find((current) => current.id === initial.id)!;
      try {
        if (!row.videoId) {
          if (!row.file) throw new Error("请重新选择这个文件");
          update(row.id, { status: "uploading", percent: 0, note: "" });
          const video = await uploadVideoFile(row.file, (progress) => update(row.id, { percent: Math.round(progress.percent), note: progress.statusText || (progress.phase === "saving" ? "正在保存视频" : "") }), controller.signal);
          update(row.id, { videoId: video.id, percent: 100 });
          row = { ...row, videoId: video.id };
        }
        if (controller.signal.aborted) { update(row.id, { status: "ready" }); break; }
        update(row.id, { status: "submitting", note: "" });
        // Retrying this same id cannot create another task if a response was lost.
        let accepted: { id: string } | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { accepted = await apiSend<{ id: string }>("/api/watermark-batches", "POST", { id: row.id, batchId: row.batchId, videoId: row.videoId }); break; }
          catch (error) {
            if (attempt || controller.signal.aborted || !/网络|请求失败|响应|服务器内部/.test(String(error))) throw error;
          }
        }
        if (!accepted) throw new Error("未确认提交结果，请继续提交核对");
        update(row.id, { status: "accepted", note: "已加入后台" });
        await refresh();
      } catch (error) {
        update(row.id, { status: controller.signal.aborted ? "ready" : "error", note: controller.signal.aborted ? "已暂停，可继续" : error instanceof Error ? error.message : "未完成，点击继续上传并提交" });
      }
    }
    controllerRef.current = null;
    if (!mounted.current) return;
    changeDrafts((current) => current.filter((row) => row.status !== "accepted"));
    if (!draftRef.current.length) { batchId.current = null; toast.success("已加入后台处理，离开页面也会继续"); }
    setBusy(false); void refresh();
  };
  const cancel = async (item: WatermarkBatchItem) => {
    if (actionId) return; setActionId(item.id);
    try {
      if (item.status === "waiting") await apiSend("/api/watermark-batches", "DELETE", { id: item.id });
      else if (item.taskId) await apiSend(`/api/tasks/${item.taskId}/cancel`, "POST");
      await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "取消未完成"); void refresh(); }
    finally { setActionId(null); }
  };
  const queuedCount = items.filter((item) => active(item.status)).length;
  return <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
    <header className="flex items-center gap-3 border-b border-zinc-100 p-5 sm:p-6">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white"><Eraser className="size-5" /></span>
      <div><h1 className="text-xl font-semibold tracking-tight">批量去水印</h1><p className="mt-1 text-sm text-zinc-500">一次放入多条，逐条保留原片和原声。</p></div>
    </header>
    <div className="space-y-4 p-4 sm:p-6">
      <input ref={input} aria-label="选择去水印视频" className="sr-only" type="file" multiple accept="video/*,.mov,.mkv,.m4v" disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }} className={`flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:opacity-50 ${dragging ? "border-indigo-500 bg-indigo-50" : "border-zinc-300 bg-zinc-50/70 hover:border-zinc-500"}`}>
        <Upload className="size-6 text-zinc-500" /><span className="font-medium">把多条视频拖到这里，或点击选择</span><span className="text-xs text-zinc-500">一次最多20条 · 每条不超过1GB</span>
      </button>
      <button type="button" disabled={busy} className="rounded text-sm text-indigo-600 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 disabled:opacity-50" onClick={() => void openLibrary()}>{libraryOpen ? "收起已上传素材" : "也可以从已上传素材添加"}</button>
      {libraryOpen && <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200 p-2">{libraryError ? <p role="alert" className="p-2 text-sm text-red-600">{libraryError}</p> : videos.length ? videos.map((video) => <button disabled={busy || drafts.some((row) => row.videoId === video.id)} className="flex w-full items-center justify-between gap-3 rounded p-2 text-left text-sm hover:bg-zinc-50 disabled:opacity-40" key={video.id} onClick={() => addExisting(video)}><span className="min-w-0 break-all">{video.name}</span><span className="shrink-0 text-xs text-zinc-500">添加</span></button>) : <p className="p-2 text-sm text-zinc-500">暂无可添加的视频</p>}</div>}
      {drafts.length > 0 && <div className="rounded-xl border border-zinc-200" aria-label="本次待提交视频">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 text-sm"><span className="font-medium">本次选择 · {drafts.length}条</span>{!busy && <button type="button" className="text-zinc-500 hover:text-zinc-900" onClick={() => { changeDrafts([]); batchId.current = null; }}>清空选择</button>}</div>
        <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto">{drafts.map((row) => <li className="flex items-start gap-3 p-4" key={row.id}>
          <Video className="mt-1 size-4 shrink-0 text-zinc-400" /><div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{row.name}</p><p className={`mt-1 text-xs leading-5 ${row.status === "error" ? "text-red-600" : "text-zinc-500"}`}>{row.status === "uploading" ? `上传中 ${row.percent}%${row.note ? ` · ${row.note}` : ""}` : row.status === "submitting" ? "正在加入后台" : row.status === "accepted" ? "已加入后台" : row.note || `${sizeLabel(row.size)} · ${row.videoId ? "已上传，等待提交" : "等待上传"}`}</p>{row.status === "uploading" && <progress aria-label={`${row.name} 上传进度`} className="mt-2 h-1 w-full accent-indigo-600" max={100} value={row.percent} />}</div>
          {!busy && <button type="button" aria-label={`移除 ${row.name}`} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900" onClick={() => changeDrafts((current) => current.filter((item) => item.id !== row.id))}><X className="size-4" /></button>}
        </li>)}</ul>
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-zinc-50 p-4"><p className="max-w-sm text-xs leading-5 text-zinc-500">上传期间请保留此页；加入后台后可离开。按顺序处理，某条出错不影响后面的。</p><div className="flex gap-2">{busy && <Button variant="outline" onClick={() => controllerRef.current?.abort()}>暂停上传</Button>}<Button disabled={busy || !drafts.length} onClick={() => void start()}>{busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Eraser />}{busy ? "上传并提交中" : drafts.some((row) => row.status === "error") ? "继续上传并提交" : `开始去水印${drafts.length ? `（${drafts.length}条）` : ""}`}</Button></div></div>
      {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-700"><span>暂时无法刷新处理清单：{loadError}</span><button type="button" className="underline" onClick={() => void refresh()}>重新加载</button></div>}
      {items.length > 0 && <div className="pt-2"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">我的处理清单{queuedCount > 0 ? ` · ${queuedCount}条未结束` : ""}</h2><Button variant="ghost" size="sm" onClick={() => void refresh()} aria-label="刷新处理清单"><RotateCcw /></Button></div>
        <ul className="divide-y divide-zinc-100">{items.slice(0,30).map((item) => <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3" key={item.id}><div className="min-w-0 flex-1 basis-48"><p className="break-all text-sm font-medium">{item.name}</p><p className={`mt-1 text-xs ${item.status === "failed" ? "text-amber-700" : "text-zinc-500"}`}>{stateLabel(item.status)}{item.status === "running" ? ` · ${item.progress}%` : ""}{item.taskId ? ` · #${item.taskId}` : ""}</p></div><div className="flex shrink-0 items-center gap-3">{active(item.status) && <Button variant="ghost" size="sm" disabled={Boolean(actionId)} onClick={() => void cancel(item)}>取消</Button>}{item.taskId && item.status !== "deleted" && <Link className="inline-flex items-center gap-1 rounded text-sm text-indigo-600 focus-visible:outline focus-visible:outline-2" href={`/tasks?task=${item.taskId}`}>查看<ArrowRight className="size-3" /></Link>}</div></li>)}</ul>
        {items.length > 30 && <p className="mt-2 text-xs text-zinc-500">这里只显示最近30条，可在任务页查看更早的处理结果。</p>}
      </div>}
    </div>
  </section>;
}
