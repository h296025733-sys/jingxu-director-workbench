"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  History,
  Loader2,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OpsChangeLog, OpsHistoryPage } from "@/lib/channel-ops-types";
import { apiGet } from "@/lib/client";
import { formatTime } from "@/lib/format";

interface Me {
  isAdmin: boolean;
}

const EMPTY_HISTORY: OpsHistoryPage = {
  logs: [],
  page: 1,
  pageSize: 30,
  total: 0,
  pageCount: 1,
};

const ACTION_LABELS = {
  create: "新增",
  update: "修改",
  delete: "删除",
} as const;

const ENTITY_LABELS = {
  store: "店铺",
  account: "账号",
  item: "内容规划",
} as const;

const FIELD_LABELS: Record<string, string> = {
  name: "店铺名称",
  storeId: "所属店铺",
  handle: "账号",
  displayName: "显示名称",
  prefix: "编号前缀",
  focus: "内容方向",
  tone: "账号语气",
  accountId: "所属账号",
  contentCode: "内容编号",
  title: "内容选题",
  contentType: "内容类型",
  plannedDate: "计划日期",
  stage: "制作状态",
  compliance: "合规状态",
  owner: "负责人",
  hook: "开头 Hook",
  cta: "CTA",
  views: "播放量",
  clicks: "商品点击",
  ordersCount: "订单数",
  accounts: "包含账号",
  contentItems: "包含内容规划",
};

const META_FIELDS = new Set(["id", "version", "createdAt", "updatedAt", "updatedBy"]);

function readInitialFilter(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return new URL(window.location.href).searchParams.get(name) || fallback;
}

function writeUrlState(values: { page: number; entity: string; action: string; search: string }): void {
  const url = new URL(window.location.href);
  if (values.page > 1) url.searchParams.set("page", String(values.page));
  else url.searchParams.delete("page");
  if (values.entity !== "all") url.searchParams.set("entity", values.entity);
  else url.searchParams.delete("entity");
  if (values.action !== "all") url.searchParams.set("action", values.action);
  else url.searchParams.delete("action");
  if (values.search) url.searchParams.set("search", values.search);
  else url.searchParams.delete("search");
  window.history.replaceState(null, "", url);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return `${value.length} 条`;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function changedRows(log: OpsChangeLog): Array<{ field: string; before: unknown; after: unknown }> {
  const keys = new Set([...Object.keys(log.before || {}), ...Object.keys(log.after || {})]);
  return Array.from(keys)
    .filter((key) => !META_FIELDS.has(key))
    .filter((key) => !Object.is(log.before?.[key], log.after?.[key]))
    .map((key) => ({ field: key, before: log.before?.[key], after: log.after?.[key] }));
}

export default function FormsHistoryPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [history, setHistory] = useState<OpsHistoryPage>(EMPTY_HISTORY);
  const [page, setPage] = useState(() => Math.max(1, Number(readInitialFilter("page", "1")) || 1));
  const [entity, setEntity] = useState(() => readInitialFilter("entity", "all"));
  const [action, setAction] = useState(() => readInitialFilter("action", "all"));
  const [search, setSearch] = useState(() => readInitialFilter("search", ""));
  const [searchInput, setSearchInput] = useState(search);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<OpsChangeLog | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "30" });
      if (entity !== "all") params.set("entity", entity);
      if (action !== "all") params.set("action", action);
      if (search) params.set("search", search);
      const result = await apiGet<OpsHistoryPage>(`/api/forms/history?${params.toString()}`, { cache: "no-store" });
      setHistory(result);
      writeUrlState({ page, entity, action, search });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更改记录读取失败，请刷新重试。");
    } finally {
      setLoading(false);
    }
  }, [action, entity, page, search]);

  useEffect(() => {
    void apiGet<{ user: Me }>("/api/auth/me")
      .then(({ user }) => {
        if (!user.isAdmin) {
          setAuthorized(false);
          router.replace("/forms");
          return;
        }
        setAuthorized(true);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    if (authorized === true) void load();
  }, [authorized, load]);

  const detailRows = useMemo(() => selectedLog ? changedRows(selectedLog) : [], [selectedLog]);

  if (authorized !== true) {
    return <AppShell active="/forms"><div className="mx-auto h-40 max-w-6xl" /></AppShell>;
  }

  return (
    <AppShell active="/forms">
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" aria-labelledby="history-title">
          <div className="h-1 bg-[linear-gradient(90deg,#18181b_0_38%,#7c3aed_38%_60%,#e4e4e7_60%)]" />
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <div className="flex items-center gap-2">
                <History className="h-5 w-5 text-violet-700" aria-hidden="true" />
                <h2 id="history-title" className="text-xl font-semibold tracking-tight text-zinc-950">协作表更改记录</h2>
              </div>
              <p className="mt-1 text-sm text-zinc-500">记录每次新增、修改和删除及其操作人。</p>
            </div>
            <Button asChild variant="outline"><Link href="/forms"><ArrowLeft aria-hidden="true" />返回协作表</Link></Button>
          </div>
        </section>

        <section className="rounded-2xl border bg-white p-4 shadow-sm sm:p-5" aria-label="筛选更改记录">
          <form className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_180px_180px_auto]" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}>
            <div className="relative">
              <Label htmlFor="history-search" className="sr-only">搜索操作人或内容</Label>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
              <Input id="history-search" name="search" autoComplete="off" className="pl-9" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索操作人、账号或内容…" />
            </div>
            <Select value={entity} onValueChange={(value) => { setEntity(value); setPage(1); }}>
              <SelectTrigger aria-label="记录对象"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部对象</SelectItem>
                <SelectItem value="store">店铺</SelectItem>
                <SelectItem value="account">账号</SelectItem>
                <SelectItem value="item">内容规划</SelectItem>
              </SelectContent>
            </Select>
            <Select value={action} onValueChange={(value) => { setAction(value); setPage(1); }}>
              <SelectTrigger aria-label="操作类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部操作</SelectItem>
                <SelectItem value="create">新增</SelectItem>
                <SelectItem value="update">修改</SelectItem>
                <SelectItem value="delete">删除</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit">筛选</Button>
          </form>
        </section>

        <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" aria-labelledby="history-list-title">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 id="history-list-title" className="text-base font-semibold">全部记录</h2>
              <p className="mt-0.5 text-xs text-zinc-500">共 {history.total.toLocaleString("zh-CN")} 条</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
              {loading ? "读取中…" : "刷新"}
            </Button>
          </div>

          {loading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-zinc-500"><Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />载入更改记录…</div>
          ) : !history.logs.length ? (
            <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center"><History className="h-8 w-8 text-zinc-300" aria-hidden="true" /><p className="mt-3 text-sm font-medium">还没有符合条件的记录</p></div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-zinc-50 hover:bg-zinc-50">
                      <TableHead className="pl-5">时间</TableHead>
                      <TableHead>操作人</TableHead>
                      <TableHead>操作</TableHead>
                      <TableHead>对象</TableHead>
                      <TableHead>内容</TableHead>
                      <TableHead className="w-20"><span className="sr-only">详情</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap pl-5 text-xs tabular-nums text-zinc-500">{formatTime(log.createdAt)}</TableCell>
                        <TableCell><p className="text-sm font-medium">{log.actorDisplayName}</p><p className="text-xs text-zinc-500" translate="no">@{log.actorUsername}</p></TableCell>
                        <TableCell><ActionBadge action={log.action} /></TableCell>
                        <TableCell className="text-xs text-zinc-500">{ENTITY_LABELS[log.entityType]}</TableCell>
                        <TableCell className="min-w-[320px]"><p className="line-clamp-2 text-sm text-zinc-800">{log.summary}</p></TableCell>
                        <TableCell><Button variant="ghost" size="icon" aria-label={`查看记录 ${log.id}`} onClick={() => setSelectedLog(log)}><Eye aria-hidden="true" /></Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="divide-y md:hidden">
                {history.logs.map((log) => (
                  <article key={log.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><ActionBadge action={log.action} /><span className="text-xs text-zinc-500">{ENTITY_LABELS[log.entityType]}</span></div>
                        <p className="mt-2 break-words text-sm text-zinc-800">{log.summary}</p>
                        <p className="mt-2 text-xs text-zinc-500">{log.actorDisplayName} · {formatTime(log.createdAt)}</p>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={`查看记录 ${log.id}`} onClick={() => setSelectedLog(log)}><Eye aria-hidden="true" /></Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}

          {history.pageCount > 1 && (
            <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-zinc-500">
              <span>第 {history.page} / {history.pageCount} 页</span>
              <div className="flex gap-2">
                <Button variant="outline" size="icon" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft aria-hidden="true" /></Button>
                <Button variant="outline" size="icon" aria-label="下一页" disabled={page >= history.pageCount || loading} onClick={() => setPage((current) => Math.min(history.pageCount, current + 1))}><ChevronRight aria-hidden="true" /></Button>
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog open={Boolean(selectedLog)} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto overscroll-contain rounded-[24px]">
          {selectedLog && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2"><ActionBadge action={selectedLog.action} /><span className="text-xs text-zinc-500">{ENTITY_LABELS[selectedLog.entityType]}</span></div>
                <DialogTitle className="break-words">{selectedLog.entityLabel}</DialogTitle>
                <DialogDescription>{selectedLog.actorDisplayName}（@{selectedLog.actorUsername}）· {formatTime(selectedLog.createdAt)}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {detailRows.length ? detailRows.map((row) => (
                  <div key={row.field} className="rounded-xl border p-4">
                    <p className="text-xs font-semibold text-zinc-600">{FIELD_LABELS[row.field] || row.field}</p>
                    {selectedLog.action === "update" ? (
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <SnapshotValue label="修改前" value={row.before} />
                        <SnapshotValue label="修改后" value={row.after} />
                      </div>
                    ) : (
                      <div className="mt-2"><SnapshotValue label={selectedLog.action === "create" ? "新增内容" : "删除前内容"} value={selectedLog.action === "create" ? row.after : row.before} /></div>
                    )}
                  </div>
                )) : (
                  <p className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">这条记录没有可展示的字段差异。</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function ActionBadge({ action }: { action: OpsChangeLog["action"] }) {
  const className = action === "create"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : action === "delete"
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-violet-200 bg-violet-50 text-violet-700";
  return <Badge variant="outline" className={className}>{ACTION_LABELS[action]}</Badge>;
}

function SnapshotValue({ label, value }: { label: string; value: unknown }) {
  const formatted = formatValue(value);
  return (
    <div className="min-w-0 rounded-lg bg-zinc-50 p-3">
      <p className="text-[10px] font-medium text-zinc-400">{label}</p>
      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-zinc-700">{formatted}</pre>
    </div>
  );
}
