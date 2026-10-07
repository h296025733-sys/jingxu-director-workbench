"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Sparkles, User } from "lucide-react";
import { apiGet, apiSend } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<{ user: unknown }>("/api/auth/me")
      .then(() => router.replace("/dashboard"))
      .catch(() => undefined);
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error("请输入用户名和密码");
      return;
    }
    setLoading(true);
    try {
      await apiSend("/api/auth/login", "POST", { username, password });
      toast.success("登录成功");
      router.replace("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-12">
      {/* 背景光斑 */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-violet-600/20 blur-3xl" />
        <div className="absolute -bottom-24 right-0 h-[360px] w-[520px] rounded-full bg-fuchsia-600/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-[300px] w-[420px] rounded-full bg-sky-600/10 blur-3xl" />
      </div>
      {/* 网格纹理 */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_75%)]" />

      <div className="relative w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <div className="flex flex-col items-center text-center">
            <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-white text-zinc-950 shadow-lg shadow-violet-500/30">
              <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-400 to-sky-400" />
              <Sparkles className="h-5 w-5" />
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-white">
              镜序
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              AI 影像创作台
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {["文字", "图片", "视频"].map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-zinc-300"
                >
                  <Sparkles className="h-3 w-3 text-violet-300" />
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" className="text-zinc-300">
                用户名
              </Label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  id="username"
                  autoComplete="username"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-10 border-white/15 bg-white/5 pl-9 text-white placeholder:text-zinc-600 focus-visible:ring-violet-400/60"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-zinc-300">
                密码
              </Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-10 border-white/15 bg-white/5 pl-9 text-white placeholder:text-zinc-600 focus-visible:ring-violet-400/60"
                />
              </div>
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="h-10 w-full bg-white text-zinc-950 transition-colors hover:bg-zinc-200"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "登录中…" : "登 录"}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-zinc-500">
            使用管理员提供的账号登录
          </p>
        </div>
        <p className="mt-6 text-center text-xs text-zinc-600">
          仅供公司内部使用 · 视频数据仅存储在内网服务器
        </p>
      </div>
    </div>
  );
}
