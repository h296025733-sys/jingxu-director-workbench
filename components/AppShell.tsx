"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleAlert,
  Eraser,
  AudioLines,
  FolderDown,
  KeyRound,
  ListTodo,
  LogOut,
  Menu,
  Sparkles,
  TableProperties,
  Users,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, apiSend } from "@/lib/client";
import { initials } from "@/lib/format";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  chooseDownloadFolder,
  currentDownloadFolderName,
  supportsRememberedDownloadFolder,
} from "@/lib/download-client";

interface ShellUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

interface SystemStatus {
  ready: boolean;
  checks: { label: string; ready: boolean }[];
}

// App Router page transitions remount this shell. Keep the last verified user in
// memory so ordinary navigation does not flash a full-screen loading page while
// the lightweight session check runs again.
export let cachedShellUser: ShellUser | null = null;

const NAV_ITEMS = [
  { key: "/dashboard", label: "创作台", icon: Sparkles },
  { key: "/videos", label: "素材", icon: Video },
  { key: "/tasks", label: "任务", icon: ListTodo },
  { key: "/watermark", label: "视频去水印", icon: Eraser },
  { key: "/voices", label: "声音克隆", icon: AudioLines },
  { key: "/forms", label: "协作表", icon: TableProperties },
  { key: "/users", label: "成员", icon: Users, adminOnly: true },
];

function NavList({
  active,
  items,
}: {
  active: string;
  items: typeof NAV_ITEMS;
}) {
  return (
    <nav className="flex-1 space-y-1 px-3 py-4">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.key;
        return (
          <Link
            key={item.key}
            href={item.key}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
              isActive
                ? "bg-white/10 text-white"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "h-4 w-4 transition-colors",
                isActive
                  ? "text-white"
                  : "text-zinc-500 group-hover:text-zinc-300",
              )}
            />
            {item.label}
            {isActive && (
              <span className="ml-auto h-1.5 w-1.5 rounded-full bg-white/70" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
      <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-white text-zinc-950 shadow-lg shadow-indigo-500/20">
        <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-400 to-sky-400" />
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-[0.18em] text-white">镜序</p>
        <p className="mt-0.5 text-[10px] text-zinc-500">AI 影像创作台</p>
      </div>
    </div>
  );
}

export default function AppShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<ShellUser | null>(cachedShellUser);
  const [checking, setChecking] = useState(cachedShellUser === null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdReminderDismissed, setPwdReminderDismissed] = useState(
    () =>
      typeof window !== "undefined" &&
      sessionStorage.getItem("dw_pwd_reminder") === "1",
  );
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [usageOpen, setUsageOpen] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const title =
    NAV_ITEMS.find((item) => item.key === active)?.label ?? "镜序";
  const navItems = NAV_ITEMS.filter(
    (item) => !item.adminOnly || user?.isAdmin,
  );
  const mustChangePassword = user?.mustChangePassword ?? false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ user: ShellUser }>("/api/auth/me");
        if (!cancelled) {
          cachedShellUser = data.user;
          setUser(data.user);
        }
      } catch {
        if (!cancelled) {
          cachedShellUser = null;
          setUser(null);
          router.replace("/login");
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const logout = async () => {
    try {
      await apiSend("/api/auth/logout", "POST");
    } finally {
      cachedShellUser = null;
      setUser(null);
      router.replace("/login");
    }
  };

  const openUsage = () => {
    setUsageOpen(true);
    void currentDownloadFolderName().then(setDownloadFolder);
    if (user?.isAdmin) {
      void apiGet<SystemStatus>("/api/system/status")
        .then(setSystemStatus)
        .catch(() => setSystemStatus(null));
    }
  };

  const pickDownloadFolder = async () => {
    setChoosingFolder(true);
    try {
      const name = await chooseDownloadFolder();
      setDownloadFolder(name);
      toast.success(`以后附件会保存到「${name}」`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error(error instanceof Error ? error.message : "无法选择文件夹");
    } finally {
      setChoosingFolder(false);
    }
  };

  const changePassword = async () => {
    if (!oldPassword || !newPassword) {
      toast.error("请填写原密码和新密码");
      return;
    }
    if (
      newPassword.length < 8 ||
      !/[a-zA-Z]/.test(newPassword) ||
      !/\d/.test(newPassword)
    ) {
      toast.error("新密码至少 8 位，且同时包含字母和数字");
      return;
    }
    setPwdSubmitting(true);
    try {
      await apiSend("/api/auth/password", "PUT", {
        oldPassword,
        newPassword,
      });
      toast.success("密码已修改");
      setPwdOpen(false);
      sessionStorage.removeItem("dw_pwd_reminder");
      setOldPassword("");
      setNewPassword("");
      const data = await apiGet<{ user: ShellUser }>("/api/auth/me");
      cachedShellUser = data.user;
      setUser(data.user);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "修改失败");
    } finally {
      setPwdSubmitting(false);
    }
  };

  if (checking || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-white text-zinc-950 shadow-xl shadow-indigo-500/20">
            <Sparkles className="h-6 w-6" />
          </div>
          <p className="text-sm text-zinc-500">加载中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#f5f5f7]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-white px-3 py-2 text-sm font-medium text-zinc-950 shadow-lg transition-transform focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
      >
        跳到主要内容
      </a>
      {/* 桌面端侧边栏 */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-zinc-950 md:flex">
        <Brand />
        <NavList
          active={active}
          items={navItems}
        />
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-violet-500/20 text-xs text-violet-300">
                {initials(user.displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-200">
                {user.displayName}
              </p>
              <p className="truncate text-[11px] text-zinc-500">
                {user.username}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
              onClick={() => void logout()}
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 md:px-6">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="打开菜单"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-64 bg-zinc-950 p-0 text-white"
            >
              <SheetTitle className="sr-only">导航</SheetTitle>
              <Brand />
              <NavList
                active={active}
                items={navItems}
              />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold md:text-base">
              {title}
            </h1>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-full p-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
                aria-label="打开账号菜单"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-zinc-900 text-xs text-white">
                    {initials(user.displayName)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-medium sm:inline">
                  {user.displayName}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>
                <p className="text-sm font-semibold">{user.displayName}</p>
                <p className="text-xs font-normal text-muted-foreground">
                  {user.username}
                  {user.isAdmin ? " · 管理员" : ""}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPwdOpen(true)}>
                <KeyRound />
                修改密码
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openUsage}>
                <FolderDown />
                下载与使用
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-600 focus:text-red-600"
                onSelect={() => void logout()}
              >
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main
          id="main-content"
          className="mx-auto w-full max-w-7xl flex-1 scroll-mt-16 animate-fade-in p-4 md:p-8"
        >
          {mustChangePassword && !pwdReminderDismissed && (
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 animate-fade-in sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 shrink-0" />
                请先修改初始密码
              </span>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
                  onClick={() => setPwdOpen(true)}
                >
                  去修改
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-amber-700 hover:bg-amber-100"
                  onClick={() => {
                    setPwdReminderDismissed(true);
                    sessionStorage.setItem("dw_pwd_reminder", "1");
                  }}
                >
                  稍后
                </Button>
              </div>
            </div>
          )}
          {children}
        </main>
      </div>

      {/* 修改密码 */}
      <Dialog
        open={pwdOpen}
        onOpenChange={setPwdOpen}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>修改密码</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="old-password">原密码</Label>
              <Input
                id="old-password"
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 位，含字母和数字"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void changePassword()} disabled={pwdSubmitting}>
              {pwdSubmitting ? "提交中…" : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-xl">
          <DialogHeader>
            <DialogTitle>下载与使用</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <section className="rounded-2xl border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">我的下载文件夹</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {downloadFolder || "浏览器默认位置"}
                  </p>
                </div>
                {supportsRememberedDownloadFolder() ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void pickDownloadFolder()}
                    disabled={choosingFolder}
                  >
                    <FolderDown className="h-4 w-4" />
                    {choosingFolder ? "正在选择…" : downloadFolder ? "更换文件夹" : "选择文件夹"}
                  </Button>
                ) : (
                  <p className="max-w-64 text-xs text-amber-700">请在浏览器中选择下载位置</p>
                )}
              </div>
            </section>

            {user.isAdmin && (
              <section className="rounded-2xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">本机创作环境</h3>
                  {systemStatus && (
                    <span className="text-xs text-muted-foreground">
                      {systemStatus.ready ? "已就绪" : "需要管理员处理"}
                    </span>
                  )}
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {systemStatus?.checks.map((check) => (
                    <div key={check.label} className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-xs">
                      {check.ready ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <CircleAlert className="h-3.5 w-3.5 text-amber-600" />
                      )}
                      {check.label}
                    </div>
                  )) ?? <p className="text-xs text-muted-foreground">正在检查…</p>}
                </div>
                {systemStatus && !systemStatus.ready && (
                  <p className="mt-3 text-xs text-amber-700">请在本机完成初始化</p>
                )}
              </section>
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setUsageOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
