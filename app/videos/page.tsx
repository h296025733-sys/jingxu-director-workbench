"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Clapperboard,
  Eye,
  Film,
  Loader2,
  Play,
  Search,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import AppShell from "@/components/AppShell";
import TaskCreateDialog from "@/components/TaskCreateDialog";
import VideoPreviewDialog from "@/components/VideoPreviewDialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiSend } from "@/lib/client";
import { formatBytes, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { VideoOut } from "@/lib/types";
import {
  generateVideoThumbnail,
  getVideoUploadRecovery,
  uploadVideoFile,
} from "@/lib/video-client";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { toast } from "sonner";

export default function VideosPage() {
  const [videos, setVideos] = useState<VideoOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const {
    value: uploading,
    update: updateUploading,
    updateNow: setUploadingNow,
  } = useThrottledValue<{
      name: string;
      percent: number;
      phase: "uploading" | "saving";
      bytesPerSecond: number;
      statusText?: string;
    } | null>(null, 120);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<VideoOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoOut | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tagTarget, setTagTarget] = useState<VideoOut | null>(null);
  const [tagText, setTagText] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createVideoId, setCreateVideoId] = useState<string | undefined>();
  const [thumbnailRevision, setThumbnailRevision] = useState<
    Record<string, number>
  >({});
  const [visibleCount, setVisibleCount] = useState(48);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await apiGet<{ videos: VideoOut[] }>("/api/videos");
      setVideos((current) =>
        JSON.stringify(current) === JSON.stringify(data.videos)
          ? current
          : data.videos,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [videos, deferredSearch]);
  const visibleVideos = filtered.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(48);
  }, [deferredSearch]);

  const startUpload = (file: File) => {
    if (uploading) {
      toast.error("已有视频正在上传");
      return;
    }
    setUploadingNow({
      name: file.name,
      percent: 0,
      phase: "uploading",
      bytesPerSecond: 0,
    });
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    const thumbnailPromise = generateVideoThumbnail(file);
    void (async () => {
      try {
        const uploadedVideo = await uploadVideoFile(file, (progress) => {
          updateUploading({
            name: file.name,
            percent: progress.percent,
            phase: progress.phase,
            bytesPerSecond: progress.bytesPerSecond,
            statusText: progress.statusText,
          }, progress.phase === "saving" || Boolean(progress.statusText));
        }, controller.signal);
        toast.success("上传成功");
        setVideos((current) => [
          uploadedVideo,
          ...current.filter((video) => video.id !== uploadedVideo.id),
        ]);
        // 封面和上传并行生成；视频保存成功后立刻可用，不再等待封面。
        void thumbnailPromise.then(async (dataUrl) => {
          if (!dataUrl) return;
          const response = await fetch(`/api/videos/${uploadedVideo.id}/thumbnail`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl }),
          }).catch(() => null);
          if (response?.ok) {
            setThumbnailRevision((current) => ({
              ...current,
              [uploadedVideo.id]: Date.now(),
            }));
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频上传失败";
        const recovery = getVideoUploadRecovery(error);
        if (recovery?.kind === "reconnect") {
          toast.error(message, {
            duration: Number.POSITIVE_INFINITY,
            description: "会在新标签页打开固定入口，当前页面不会关闭。",
            action: {
              label: "重新连接",
              onClick: () =>
                window.open(recovery.url, "_blank", "noopener,noreferrer"),
            },
          });
        } else if (recovery?.kind === "retry") {
          toast.error(message, {
            duration: 20_000,
            action: {
              label: "重试",
              onClick: () => startUpload(file),
            },
          });
        } else {
          toast.error(message);
        }
      } finally {
        if (uploadControllerRef.current === controller) {
          uploadControllerRef.current = null;
        }
        setUploadingNow(null);
      }
    })();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/videos/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(data.error || "删除失败");
      toast.success(data.message || "已删除视频");
      setDeleteTarget(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const openTagEditor = (video: VideoOut) => {
    setTagTarget(video);
    setTagText(video.tags.join(", "));
  };

  const saveTags = async () => {
    if (!tagTarget) return;
    const tags = tagText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((t) => t.slice(0, 20));
    setTagSaving(true);
    try {
      await apiSend(`/api/videos/${tagTarget.id}`, "PUT", { tags });
      toast.success("标签已保存");
      setTagTarget(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setTagSaving(false);
    }
  };

  return (
    <AppShell active="/videos">
      <div className="space-y-6">
        {/* 上传区 */}
        <div
          role="button"
          tabIndex={0}
          aria-disabled={Boolean(uploading)}
          onClick={() => {
            if (!uploading) inputRef.current?.click();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (!uploading) inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file && !uploading) startUpload(file);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-[border-color,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
            dragging
              ? "border-zinc-900 bg-zinc-50"
              : "border-zinc-300 bg-muted/20 hover:border-zinc-400 hover:bg-muted/40",
          )}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-white shadow-lg shadow-zinc-900/20">
            <Upload className="h-5 w-5" />
          </div>
          <p className="mt-4 text-sm font-medium">
            点击或拖拽视频
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            mp4 / mov / webm / mkv · 最大 1GB
          </p>
          <input
            ref={inputRef}
            type="file"
            aria-label="选择要上传的视频"
            accept="video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v,.flv,.wmv"
            className="hidden"
            disabled={Boolean(uploading)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) startUpload(file);
              e.target.value = "";
            }}
          />
        </div>

        {uploading && (
          <div
            aria-busy="true"
            aria-live="polite"
            className="animate-fade-in rounded-xl border p-4"
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate">{uploading.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {uploading.statusText
                      ? uploading.statusText
                      : uploading.phase === "saving"
                      ? "文件已传完，正在保存"
                      : uploading.bytesPerSecond > 0
                        ? `${formatBytes(uploading.bytesPerSecond)}/秒`
                        : "正在连接"}
                  </span>
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {uploading.percent}%
              </span>
            </div>
            <Progress
              value={uploading.percent}
              aria-label={`${uploading.name} 上传进度`}
            />
            {uploading.phase === "uploading" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2 text-xs"
                onClick={() => uploadControllerRef.current?.abort()}
              >
                取消上传
              </Button>
            )}
          </div>
        )}

        {/* 工具栏 */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索视频"
              name="video-search"
              autoComplete="off"
              className="pl-9"
              placeholder="搜索视频名称或标签…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            共 {filtered.length} 个视频
            {search && `（搜索 “${search.trim()}”）`}
          </p>
        </div>

        {/* 海报墙 */}
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <Skeleton key={i} className="aspect-video rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-16 text-center">
              <Film className="h-10 w-10 text-zinc-300" />
              <p className="mt-4 text-sm font-medium">
                {search ? "没有匹配的视频" : "还没有视频"}
              </p>
              {search && <p className="mt-1 text-xs text-muted-foreground">换个关键词试试</p>}
            </CardContent>
          </Card>
        ) : (
          <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleVideos.map((video) => (
              <div
                key={video.id}
                className="content-auto-card group overflow-hidden rounded-xl border bg-card transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0"
              >
                {/* 封面 */}
                <div className="relative aspect-video overflow-hidden bg-zinc-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/videos/${video.id}/thumbnail${
                      thumbnailRevision[video.id]
                        ? `?v=${thumbnailRevision[video.id]}`
                        : ""
                    }`}
                    alt={video.name}
                    width={640}
                    height={360}
                    loading="lazy"
                    decoding="async"
                    className="relative z-[1] h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                    onLoad={(e) => {
                      e.currentTarget.style.display = "block";
                    }}
                  />
                  <div className="absolute inset-0 z-0 flex items-center justify-center text-zinc-300">
                    <Clapperboard className="h-8 w-8" />
                  </div>
                  <div className="absolute inset-0 z-[2] bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" />
                  <div className="absolute inset-x-2 bottom-2 z-[3] flex gap-1.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    <Button
                      size="sm"
                      className="h-8 flex-1 bg-white/95 text-zinc-900 hover:bg-white"
                      onClick={() => setPreview(video)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      预览
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 flex-1 bg-white/95 text-zinc-900 hover:bg-white"
                      onClick={() => {
                        setCreateVideoId(video.id);
                        setCreateOpen(true);
                      }}
                    >
                      <Play className="h-3.5 w-3.5" />
                      任务
                    </Button>
                  </div>
                  <span className="absolute right-2 top-2 z-[3] rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                    {formatBytes(video.size)}
                  </span>
                </div>

                {/* 信息区 */}
                <div className="p-3">
                  <button
                    type="button"
                    onClick={() => setPreview(video)}
                    className="block w-full text-left"
                    title={video.name}
                  >
                    <p className="truncate text-sm font-medium transition-colors hover:text-foreground">
                      {video.name}
                    </p>
                  </button>
                  <div className="mt-1.5 flex min-h-[20px] items-center gap-1.5">
                    {video.tags.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        未添加标签
                      </span>
                    ) : (
                      video.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))
                    )}
                    {video.tags.length > 2 && (
                      <span className="text-[11px] text-muted-foreground">
                        +{video.tags.length - 2}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t pt-2">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] text-muted-foreground">
                        {formatTime(video.createdAt)}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        上传人 {video.uploadedBy}
                      </p>
                    </div>
                    <div className="flex gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openTagEditor(video)}
                      >
                        <Tag className="h-3 w-3" />
                        标签
                      </Button>
                      {video.canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => setDeleteTarget(video)}
                          aria-label={`删除视频 ${video.name}`}
                          title="删除视频"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {visibleVideos.length < filtered.length && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisibleCount((count) => count + 48)}
              >
                加载更多
              </Button>
            </div>
          )}
          </>
        )}
      </div>

      <VideoPreviewDialog
        video={preview}
        open={!!preview}
        onClose={() => setPreview(null)}
      />

      <TaskCreateDialog
        open={createOpen}
        initialVideoId={createVideoId}
        onClose={() => {
          setCreateOpen(false);
          setCreateVideoId(undefined);
        }}
        onCreated={() => void load()}
      />

      {/* 删除确认 */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除视频</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.name}」吗？
              {(deleteTarget?.taskCount ?? 0) > 0
                ? ` 与它关联的 ${deleteTarget?.taskCount} 个任务和附件也会一起删除。`
                : " 视频文件和封面会一起删除。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 标签编辑 */}
      <Dialog
        open={!!tagTarget}
        onOpenChange={(o) => !o && setTagTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑标签</DialogTitle>
            <DialogDescription>
              {tagTarget?.name} · 用逗号分隔多个标签，最多 10 个
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="video-tags">标签</Label>
            <Input
              id="video-tags"
              placeholder="例如：美妆，剧情反转，前3秒钩子"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void saveTags()} disabled={tagSaving}>
              {tagSaving ? "保存中…" : "保存标签"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
