"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import AppShell, { cachedShellUser } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiSend } from "@/lib/client";
import { toast } from "sonner";

interface UserOut {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
}

interface Me {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

type EditorMode = "create" | "edit";
type EditorField = "displayName" | "username" | "password";

const AVATAR_TONES = [
  "bg-violet-100 text-violet-700",
  "bg-cyan-100 text-cyan-800",
  "bg-amber-100 text-amber-800",
  "bg-emerald-100 text-emerald-800",
  "bg-rose-100 text-rose-700",
  "bg-indigo-100 text-indigo-700",
] as const;

function displayInitial(name: string): string {
  const normalized = name.trim();
  return normalized ? Array.from(normalized)[0].toUpperCase() : "?";
}

function avatarTone(user: UserOut): string {
  const seed = Array.from(user.username).reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  return AVATAR_TONES[seed % AVATAR_TONES.length];
}

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserOut[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("create");
  const [editing, setEditing] = useState<UserOut | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EditorField, string>>>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserOut | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const meData = cachedShellUser
        ? { user: cachedShellUser as Me }
        : await apiGet<{ user: Me }>("/api/auth/me");
      if (!meData.user.isAdmin) {
        setAuthorized(false);
        router.replace("/dashboard");
        return;
      }
      setAuthorized(true);
      const userData = await apiGet<{ users: UserOut[] }>("/api/users");
      setUsers(userData.users);
      setMe(meData.user);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "账号名单加载失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetEditorFeedback = () => {
    setFieldErrors({});
    setFormError("");
  };

  const openCreate = () => {
    setEditorMode("create");
    setEditing(null);
    setDisplayName("");
    setUsername("");
    setPassword("");
    setIsAdmin(false);
    setDisabled(false);
    resetEditorFeedback();
    setEditorOpen(true);
  };

  const openEdit = (user: UserOut) => {
    setEditorMode("edit");
    setEditing(user);
    setDisplayName(user.displayName);
    setUsername(user.username);
    setPassword("");
    setIsAdmin(user.isAdmin);
    setDisabled(user.disabled);
    resetEditorFeedback();
    setEditorOpen(true);
  };

  const clearFieldError = (field: EditorField) => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError("");
  };

  const validateEditor = (): boolean => {
    const nextErrors: Partial<Record<EditorField, string>> = {};
    if (!displayName.trim()) nextErrors.displayName = "填写员工在公司使用的姓名";
    if (
      editorMode === "create" &&
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())
    ) {
      nextErrors.username = "使用 3–32 位字母、数字、下划线、点或中划线";
    }
    if (
      (editorMode === "create" || password.length > 0) &&
      (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
    ) {
      nextErrors.password = "至少 8 位，并且同时包含字母和数字";
    }
    setFieldErrors(nextErrors);
    const firstField = Object.keys(nextErrors)[0] as EditorField | undefined;
    if (firstField) {
      const fieldId = {
        displayName: "display-name",
        username: "username",
        password: "password",
      }[firstField];
      requestAnimationFrame(() => document.getElementById(fieldId)?.focus());
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (!validateEditor()) return;
    setSubmitting(true);
    setFormError("");
    try {
      if (editorMode === "create") {
        await apiSend("/api/users", "POST", {
          username: username.trim(),
          displayName: displayName.trim(),
          password,
          isAdmin,
        });
        toast.success("员工账号已创建");
      } else if (editing) {
        await apiSend(`/api/users/${editing.id}`, "PUT", {
          displayName: displayName.trim(),
          isAdmin,
          disabled,
          password: password || undefined,
        });
        toast.success("账号设置已保存");
      }
      setEditorOpen(false);
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/users/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "删除失败，请稍后重试");
      }
      toast.success("员工账号已删除");
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败，请稍后重试");
    } finally {
      setDeleting(false);
    }
  };

  if (authorized !== true) {
    return (
      <AppShell active="/dashboard">
        <div className="mx-auto h-32 max-w-5xl" />
      </AppShell>
    );
  }

  return (
    <AppShell active="/users">
      <div className="mx-auto max-w-5xl">
        <section aria-labelledby="account-list-title" className="overflow-hidden rounded-2xl border bg-white shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
            <div className="flex items-baseline gap-2">
              <h2 id="account-list-title" className="text-lg font-semibold tracking-tight">
                员工账号
              </h2>
              {!loading && <span className="text-xs text-muted-foreground">{users.length}</span>}
            </div>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              添加员工
            </Button>
          </div>

          {loading ? (
            <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
              {[0, 1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
              <UsersRound className="h-8 w-8 text-zinc-300" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-medium">还没有员工</h3>
              <Button className="mt-4" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                添加员工
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {users.map((user) => {
                const isSelf = me?.id === user.id;
                return (
                  <article
                    key={user.id}
                    className={`flex min-w-0 flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:px-6 ${user.disabled ? "opacity-60" : ""}`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${avatarTone(user)}`}
                        aria-hidden="true"
                      >
                        {displayInitial(user.displayName)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-zinc-950">
                            {user.displayName}
                          </h3>
                          {isSelf && (
                            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                              当前账号
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-500" translate="no">
                          @{user.username}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className={user.isAdmin ? "bg-violet-50 text-violet-700" : ""}>
                          {user.isAdmin ? <ShieldCheck className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
                          {user.isAdmin ? "管理员" : "成员"}
                        </Badge>
                        {user.mustChangePassword && !user.disabled && (
                          <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50">
                            <KeyRound className="h-3 w-3" />
                            待改密码
                          </Badge>
                        )}
                        <span className={`inline-flex items-center gap-1 text-xs ${user.disabled ? "text-red-600" : "text-emerald-700"}`}>
                          {user.disabled ? <Ban className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                          {user.disabled ? "停用" : "正常"}
                        </span>
                      </div>
                      {!isSelf && (
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => openEdit(user)}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:bg-red-50 hover:text-red-700"
                            onClick={() => setDeleteTarget(user)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            删除
                          </Button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!submitting) setEditorOpen(open);
        }}
      >
        <DialogContent aria-describedby={undefined} className="max-h-[90vh] max-w-lg overflow-y-auto overscroll-contain rounded-[24px] p-0">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="border-b bg-[#f8f7ff] px-6 py-5">
              <DialogHeader>
                <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-violet-100 text-violet-700">
                  {editorMode === "create" ? (
                    <Plus className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  )}
                </div>
                <DialogTitle className="text-xl">
                  {editorMode === "create" ? "添加员工" : `编辑 ${editing?.displayName ?? "员工"}`}
                </DialogTitle>
              </DialogHeader>
            </div>

            <div className="space-y-5 px-6 py-5">
              <div className="space-y-2">
                <Label htmlFor="display-name">员工姓名</Label>
                <Input
                  id="display-name"
                  name="displayName"
                  autoComplete="off"
                  placeholder="例如：张三…"
                  value={displayName}
                  aria-invalid={Boolean(fieldErrors.displayName)}
                  aria-describedby={fieldErrors.displayName ? "display-name-error" : undefined}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    clearFieldError("displayName");
                  }}
                />
                {fieldErrors.displayName && (
                  <p id="display-name-error" className="text-xs text-red-600">
                    {fieldErrors.displayName}
                  </p>
                )}
              </div>

              {editorMode === "create" && (
                <div className="space-y-2">
                  <Label htmlFor="username">登录用户名</Label>
                  <Input
                    id="username"
                    name="new-username"
                    autoComplete="off"
                    spellCheck={false}
                    translate="no"
                    placeholder="例如：zhangsan…"
                    value={username}
                    aria-invalid={Boolean(fieldErrors.username)}
                    aria-describedby={fieldErrors.username ? "username-error" : undefined}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      clearFieldError("username");
                    }}
                  />
                  {fieldErrors.username ? (
                    <p id="username-error" className="text-xs text-red-600">
                      {fieldErrors.username}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">创建后不能修改</p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">
                  {editorMode === "create" ? "初始密码" : "重置密码（可留空）"}
                </Label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                  <Input
                    id="password"
                    name="new-password"
                    className="pl-9"
                    type="password"
                    autoComplete="new-password"
                    placeholder="至少 8 位，含字母和数字…"
                    value={password}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={fieldErrors.password ? "password-error" : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      clearFieldError("password");
                    }}
                  />
                </div>
                {fieldErrors.password && (
                  <p id="password-error" className="text-xs text-red-600">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="role-select">账号权限</Label>
                <Select value={isAdmin ? "admin" : "member"} onValueChange={(value) => setIsAdmin(value === "admin")}>
                  <SelectTrigger id="role-select" className="w-full" aria-label="账号权限">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">成员</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editorMode === "edit" && (
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border bg-zinc-50 p-4 focus-within:ring-2 focus-within:ring-violet-400 focus-within:ring-offset-2">
                  <span>
                    <span className="block text-sm font-medium">允许登录</span>
                  </span>
                  <Switch
                    checked={!disabled}
                    onCheckedChange={(checked) => setDisabled(!checked)}
                    aria-label="允许该员工登录"
                  />
                </label>
              )}

              {formError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" aria-live="polite">
                  {formError}
                </div>
              )}
            </div>

            <DialogFooter className="border-t bg-white px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={submitting}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {submitting ? "保存中…" : editorMode === "create" ? "创建账号" : "保存修改"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="max-w-md rounded-[24px]">
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-red-50 text-red-600">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle>删除员工账号？</DialogTitle>
            <DialogDescription>删除「{deleteTarget?.displayName}」？历史任务仍会保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              先不删除
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
