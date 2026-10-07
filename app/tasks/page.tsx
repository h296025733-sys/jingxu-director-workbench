"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  ListTodo,
  Loader2,
  Plus,
  RotateCcw,
  StopCircle,
  Trash2,
} from "lucide-react";
import AppShell from "@/components/AppShell";
import TaskCreateDialog from "@/components/TaskCreateDialog";
import TaskResultSheet from "@/components/TaskResultSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import LiveProgress from "@/components/LiveProgress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/client";
import { formatTime, taskStatusMeta } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskOut } from "@/lib/types";
import { toast } from "sonner";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

const StatusBadge = memo(function StatusBadge({ task }: { task: TaskOut }) {
  const meta = taskStatusMeta(task);
  return (
    <Badge
      variant={meta.variant}
      className={cn("gap-1.5 whitespace-nowrap", meta.pulse && "text-zinc-900")}
    >
      {meta.pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-400 opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-zinc-500" />
        </span>
      )}
      {meta.label}
    </Badge>
  );
});

function progressText(task: TaskOut): string {
  if (task.status === "pending") return "等待开始";
  if (task.status !== "running") return "";
  if (task.featureId === "watermark_removal") {
    if (task.progress < 35) return "正在扫描视频";
    if (task.progress < 69) return "正在判断安全区域";
    if (task.progress < 90) return "正在处理水印";
    return "正在检查结果";
  }
  if (task.featureId === "auto_edit") {
    if (task.progress < 20) return "正在读素材";
    if (task.progress < 40) {
      return task.params.transcribe === false ? "正在看画面" : "正在听内容";
    }
    if (task.progress < 70) return "正在编排剪辑";
    if (task.progress < 90) return "正在渲染成片";
    return "正在检查成片";
  }
  if (task.progress < 55) return task.videoId ? "正在读视频" : "正在整理素材";
  if (
    task.featureId === "video_breakdown" &&
    task.params.analysisConfirmed !== true
  ) {
    return "正在抓住参考片的爆点";
  }
  if (
    task.featureId === "omni_video" &&
    task.params.analysisConfirmed !== true
  ) {
    return "正在理解你的想法";
  }
  if (task.progress < 95) return "正在生成提示词";
  return "正在整理附件";
}

const TaskProgress = memo(function TaskProgress({
  taskId,
  status,
  progress,
}: {
  taskId: number;
  status: string;
  progress: number;
}) {
  const active = ACTIVE_STATUSES.has(status);
  if (!active) {
    return (
      <Progress
        value={progress}
        className="h-1.5"
        aria-label={`任务 ${taskId} 进度`}
      />
    );
  }
  return <LiveProgress value={progress} className="h-1.5" label={`任务 ${taskId} 进度`} />;
});

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFeatureId, setCreateFeatureId] = useState<string | undefined>();
  const [detail, setDetail] = useState<TaskOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskOut | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openingTaskId, setOpeningTaskId] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const hasActive = useRef(false);
  const listRequestActive = useRef(false);
  const listAbortController = useRef<AbortController | null>(null);
  const detailRequest = useRef<{
    taskId: number;
    controller: AbortController;
  } | null>(null);
  const showCreator = tasks.some((task) => Boolean(task.createdBy));
  const hasOverlayOpen = Boolean(detail || createOpen || deleteTarget);
  const visibleTasks = tasks.slice(0, visibleCount);

  const load = useCallback(async (showLoading = false) => {
    if (listRequestActive.current) return;
    if (!showLoading && document.visibilityState !== "visible") return;
    listRequestActive.current = true;
    const controller = new AbortController();
    listAbortController.current = controller;
    if (showLoading) setLoading(true);
    try {
      const data = await apiGet<{ tasks: TaskOut[] }>("/api/tasks", {
        signal: controller.signal,
      });
      setTasks((current) =>
        JSON.stringify(current) === JSON.stringify(data.tasks)
          ? current
          : data.tasks,
      );
      hasActive.current = data.tasks.some((t) =>
        ACTIVE_STATUSES.has(t.status),
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        toast.error(err instanceof Error ? err.message : "加载失败");
      }
    } finally {
      if (listAbortController.current === controller) {
        listAbortController.current = null;
      }
      listRequestActive.current = false;
      if (showLoading) setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (taskId: number, showError = false) => {
    if (detailRequest.current?.taskId === taskId) return true;
    detailRequest.current?.controller.abort();
    const controller = new AbortController();
    detailRequest.current = { taskId, controller };
    try {
      const data = await apiGet<{ task: TaskOut }>(`/api/tasks/${taskId}`, {
        signal: controller.signal,
      });
      setDetail((current) => {
        if (current && current.id !== taskId) return current;
        return JSON.stringify(current) === JSON.stringify(data.task)
          ? current
          : data.task;
      });
      if (!ACTIVE_STATUSES.has(data.task.status)) void load();
      return true;
    } catch (error) {
      if (showError && !controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "任务详情加载失败");
      }
      return controller.signal.aborted ? true : false;
    } finally {
      if (detailRequest.current?.controller === controller) {
        detailRequest.current = null;
      }
    }
  }, [load]);

  const openDetail = useCallback(async (task: TaskOut) => {
    setOpeningTaskId(task.id);
    setDetail(task);
    try {
      await refreshDetail(task.id, true);
    } finally {
      setOpeningTaskId((current) => (current === task.id ? null : current));
    }
  }, [refreshDetail]);

  const closeCreateDialog = useCallback(() => {
    setCreateOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") === "1") {
      window.history.replaceState(null, "", "/tasks");
    }
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("new") === "1") {
      setCreateFeatureId(query.get("feature") || undefined);
      setCreateOpen(true);
    }
    const requestedTaskId = Number(query.get("task"));
    if (Number.isSafeInteger(requestedTaskId) && requestedTaskId > 0) {
      setOpeningTaskId(requestedTaskId);
      void apiGet<{ task: TaskOut }>(`/api/tasks/${requestedTaskId}`)
        .then((response) => setDetail(response.task))
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : "任务详情加载失败"),
        )
        .finally(() => setOpeningTaskId(null));
    }
    void load(true);
    return () => {
      listAbortController.current?.abort();
      detailRequest.current?.controller.abort();
    };
  }, [load]);

  // 列表轮询只拿轻量摘要；抽屉/弹窗打开时不刷新背后的列表，避免无意义重绘。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!hasOverlayOpen && hasActive.current) void load();
    }, 5000);
    const onVisibilityChange = () => {
      if (
        !hasOverlayOpen &&
        document.visibilityState === "visible" &&
        hasActive.current
      ) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasOverlayOpen, load]);

  // 打开的运行中任务单独刷新；不再用列表结果替换整个详情抽屉。
  useEffect(() => {
    if (!detail || !ACTIVE_STATUSES.has(detail.status)) return;
    const taskId = detail.id;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshDetail(taskId);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [detail?.id, detail?.status, refreshDetail]);

  const cancel = async (task: TaskOut) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/cancel`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "取消失败");
      toast.success("已提交取消");
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消失败");
    }
  };

  const retry = async (task: TaskOut) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/retry`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        task?: TaskOut;
      };
      if (!res.ok) throw new Error(data.error || "重试失败");
      toast.success("已保留原素材，正在自动修正");
      if (data.task) setDetail(data.task);
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重试失败");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tasks/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "删除失败");
      toast.success("已删除任务记录");
      setDeleteTarget(null);
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const taskActions = (task: TaskOut, compact = false) => (
    <div className={cn("flex gap-2", compact ? "w-full" : "justify-end gap-1.5")}>
      <Button
        variant={compact ? "default" : "ghost"}
        size="sm"
        className={cn(compact && "flex-1")}
        onClick={() => void openDetail(task)}
        disabled={openingTaskId === task.id}
      >
        {openingTaskId === task.id ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
        {compact ? "查看结果" : "查看"}
      </Button>
      {ACTIVE_STATUSES.has(task.status) && task.canManage && (
        <Button variant="outline" size="sm" onClick={() => void cancel(task)}>
          <StopCircle className="h-3.5 w-3.5" />
          取消
        </Button>
      )}
      {(task.status === "failed" ||
        task.status === "canceled" ||
        task.status === "succeeded") &&
        task.canManage && (
          <Button variant="outline" size="sm" onClick={() => void retry(task)}>
            <RotateCcw className="h-3.5 w-3.5" />
            {compact ? "再试一次" : "重试"}
          </Button>
        )}
      {task.canManage && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700"
          onClick={() => setDeleteTarget(task)}
          aria-label={`删除任务 ${task.id}`}
          title="删除任务"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );

  return (
    <AppShell active="/tasks">
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setCreateFeatureId(undefined);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            新建创作
          </Button>
        </div>

        <Card aria-busy={loading}>
          <CardHeader className="pb-4">
            <h2 className="text-base font-semibold">任务 · {tasks.length}</h2>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <div className="flex flex-col items-center py-14 text-center">
                <ListTodo className="h-10 w-10 text-zinc-300" />
                <p className="mt-4 text-sm font-medium">还没有任务</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 lg:hidden">
                  {visibleTasks.map((task) => (
                    <article key={task.id} className="content-auto-task rounded-2xl border bg-background p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold" title={task.videoName}>
                            {task.videoId ? task.videoName : "文字与图片创作"}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {task.featureIcon} {task.featureName}
                          </p>
                          {task.createdBy && (
                            <p className="mt-1 truncate text-[11px] text-muted-foreground">
                              创建人 {task.creatorDisplayName || task.createdBy} · @{task.createdBy}
                            </p>
                          )}
                        </div>
                        <StatusBadge task={task} />
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <TaskProgress taskId={task.id} status={task.status} progress={task.progress} />
                        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {task.status === "running" ? "处理中" : `${task.progress}%`}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                        <span>{progressText(task) || `任务 #${task.id}`}</span>
                        <time dateTime={task.createdAt}>{formatTime(task.createdAt)}</time>
                      </div>
                      <div className="mt-4 border-t pt-3">{taskActions(task, true)}</div>
                    </article>
                  ))}
                </div>

                <div className="hidden overflow-x-auto overscroll-contain lg:block">
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>内容</TableHead>
                    <TableHead className="whitespace-nowrap">要做什么</TableHead>
                    {showCreator && <TableHead className="whitespace-nowrap">创建人</TableHead>}
                    <TableHead className="whitespace-nowrap">状态</TableHead>
                    <TableHead className="whitespace-nowrap">进度</TableHead>
                    <TableHead className="whitespace-nowrap">时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTasks.map((task) => (
                    <TableRow key={task.id}>
                      <TableCell className="max-w-[220px]">
                        <p className="truncate font-medium" title={task.videoName}>
                          {task.videoId ? task.videoName : "文字与图片创作"}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {task.featureIcon} {task.featureName}
                      </TableCell>
                      {showCreator && (
                        <TableCell className="max-w-[150px] whitespace-nowrap">
                          <p className="truncate text-sm font-medium" title={task.creatorDisplayName || task.createdBy}>
                            {task.creatorDisplayName || task.createdBy}
                          </p>
                          {task.createdBy && task.creatorDisplayName !== task.createdBy && (
                            <p className="truncate text-[11px] text-muted-foreground" title={`@${task.createdBy}`}>
                              @{task.createdBy}
                            </p>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="whitespace-nowrap">
                        <StatusBadge task={task} />
                      </TableCell>
                      <TableCell className="min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <TaskProgress taskId={task.id} status={task.status} progress={task.progress} />
                          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {task.status === "running" ? "处理中" : `${task.progress}%`}
                          </span>
                        </div>
                        {progressText(task) && (
                          <p className="mt-1 max-w-[180px] truncate text-[11px] text-muted-foreground">
                            {progressText(task)}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <time dateTime={task.createdAt}>{formatTime(task.createdAt)}</time>
                      </TableCell>
                      <TableCell className="text-right">
                        {taskActions(task)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                </Table>
                </div>
                {visibleTasks.length < tasks.length && (
                  <div className="mt-5 flex justify-center">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setVisibleCount((count) => count + 50)}
                    >
                      加载更多
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <TaskCreateDialog
        open={createOpen}
        initialFeatureId={createFeatureId}
        onClose={closeCreateDialog}
        onCreated={() => void load()}
      />

      <TaskResultSheet
        task={detail}
        open={!!detail}
        loading={openingTaskId === detail?.id}
        onClose={() => setDetail(null)}
        onRetry={retry}
        onRefresh={refreshDetail}
        onChanged={() => {
          setDetail(null);
          void load();
        }}
      />

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除任务记录</DialogTitle>
            <DialogDescription>
              确定删除任务 #{deleteTarget?.id} 吗？此操作不可恢复。
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
    </AppShell>
  );
}
