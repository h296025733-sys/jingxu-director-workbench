"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  FileImage,
  Film,
  FolderOpen,
  Sparkles,
  Type,
} from "lucide-react";
import AppShell from "@/components/AppShell";
import TaskCreateDialog from "@/components/TaskCreateDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/client";
import { formatTime, taskStatusMeta } from "@/lib/format";
import type { TaskOut } from "@/lib/types";

interface DashboardData {
  recentTasks: TaskOut[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [initialFeatureId, setInitialFeatureId] = useState<string>();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("create") === "auto_edit") {
      setInitialFeatureId("auto_edit");
      setCreateOpen(true);
      router.replace("/dashboard", { scroll: false });
    }
  }, [router]);

  const load = () => {
    void apiGet<DashboardData>("/api/dashboard")
      .then(setData)
      .catch(() => undefined);
  };

  useEffect(load, []);

  return (
    <AppShell active="/dashboard">
      <div className="space-y-8">
        <section className="relative isolate overflow-hidden rounded-[2rem] bg-zinc-950 px-6 py-10 text-white shadow-2xl shadow-indigo-200/50 sm:px-10 sm:py-14 lg:px-14">
          <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-indigo-500/35 blur-3xl" />
            <div className="absolute bottom-[-7rem] left-[35%] h-64 w-64 rounded-full bg-violet-400/20 blur-3xl" />
            <div className="absolute right-10 top-10 grid grid-cols-4 gap-2 opacity-50" aria-hidden="true">
              {Array.from({ length: 12 }, (_, index) => (
                <span
                  key={index}
                  className="h-12 w-16 rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur"
                />
              ))}
            </div>
          </div>
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-300">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" />
              镜序
            </div>
            <h2 className="mt-6 text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
              有想法，就能开拍。
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-400 sm:text-base">
              文字、图片、视频随你给。剩下的判断，交给我。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                size="lg"
                onClick={() => setCreateOpen(true)}
                className="bg-white text-zinc-950 shadow-xl shadow-black/20 hover:bg-zinc-100"
              >
                <Sparkles className="h-4 w-4" />
                开始创作
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-white/15 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/videos">
                  <FolderOpen className="h-4 w-4" />
                  查看素材
                </Link>
              </Button>
            </div>
          </div>
          <div className="mt-10 flex flex-wrap gap-2 text-xs text-zinc-400">
            {[
              [Type, "一句想法"],
              [FileImage, "几张图片"],
              [Film, "一条参考片"],
            ].map(([Icon, label]) => {
              const Mark = Icon as typeof Type;
              return (
                <span key={String(label)} className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-2">
                  <Mark className="h-3.5 w-3.5" />
                  {String(label)}
                </span>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">最近创作</h2>
            <Link href="/tasks" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-950">
              查看全部 <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {!data ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-28 rounded-2xl" />
              ))}
            </div>
          ) : data.recentTasks.length === 0 ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex min-h-36 w-full items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white text-sm text-zinc-500 hover:border-indigo-300 hover:bg-indigo-50/30 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              创建第一条作品
            </button>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.recentTasks.slice(0, 6).map((task) => {
                const meta = taskStatusMeta(task);
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => router.push(`/tasks?task=${task.id}`)}
                    className="group rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:hover:translate-y-0"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-400">#{task.id}</span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm font-medium leading-6 text-zinc-900">
                      {task.videoId || task.featureId === "voice_clone" ? task.videoName : "文字与图片创作"}
                    </p>
                    <p className="mt-2 text-xs text-zinc-400">{formatTime(task.createdAt)}</p>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <TaskCreateDialog
        initialFeatureId={initialFeatureId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          load();
          router.push("/tasks");
        }}
      />
    </AppShell>
  );
}
