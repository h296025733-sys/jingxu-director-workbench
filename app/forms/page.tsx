"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Download,
  FlaskConical,
  History,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Store as StoreIcon,
  Trash2,
  Users,
  UsersRound,
  Video,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  OPS_COMPLIANCE_STATES,
  OPS_CONTENT_TYPES,
  OPS_STAGES,
  type OpsAccount,
  type OpsContentItem,
  type OpsEntityType,
  type OpsMutationResult,
  type OpsStore,
  type OpsWorkspaceData,
} from "@/lib/channel-ops-types";
import { apiGet } from "@/lib/client";
import { formatTime } from "@/lib/format";

interface Me {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

type Filter = "all" | "review" | "ready" | "published";
type TimeScope = "month" | "week" | "day";
type HierarchyLevel = "store" | "owner";
type ContentView = "table" | "canvas";
type PeriodFilter = "all" | "week" | "month";

type ItemDraft = Pick<
  OpsContentItem,
  | "accountId"
  | "contentCode"
  | "title"
  | "contentType"
  | "plannedDate"
  | "stage"
  | "compliance"
  | "owner"
  | "hook"
  | "cta"
  | "views"
  | "clicks"
  | "ordersCount"
>;

type AccountDraft = Pick<OpsAccount, "storeId" | "handle" | "displayName" | "prefix" | "focus" | "tone">;

type HierarchyEditor =
  | { entity: "store"; base: OpsStore | null }
  | { entity: "account"; base: OpsAccount | null }
  | null;

interface ConflictPayload {
  error: string;
  code: "EDIT_CONFLICT";
  current: OpsStore | OpsAccount | OpsContentItem;
  fields: string[];
}

interface DeleteTarget {
  entity: OpsEntityType;
  id: string;
  version: number;
  label: string;
  detail: string;
}

const EMPTY_WORKSPACE: OpsWorkspaceData = {
  revision: 0,
  latestChangeAt: null,
  stores: [],
  accounts: [],
  items: [],
};

const ITEM_EDITABLE_KEYS: Array<keyof ItemDraft> = [
  "accountId",
  "contentCode",
  "title",
  "contentType",
  "plannedDate",
  "stage",
  "compliance",
  "owner",
  "hook",
  "cta",
  "views",
  "clicks",
  "ordersCount",
];

const ACCOUNT_EDITABLE_KEYS: Array<keyof AccountDraft> = [
  "storeId",
  "handle",
  "displayName",
  "prefix",
  "focus",
  "tone",
];

const stageClass: Record<string, string> = {
  选题池: "border-zinc-200 bg-zinc-100 text-zinc-600",
  待生成: "border-violet-200 bg-violet-50 text-violet-700",
  脚本完成: "border-blue-200 bg-blue-50 text-blue-700",
  剪辑中: "border-amber-200 bg-amber-50 text-amber-700",
  待审核: "border-orange-200 bg-orange-50 text-orange-700",
  待发布: "border-teal-200 bg-teal-50 text-teal-700",
  已发布: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

class MutationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

function todayString(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function emptyItem(accountId: string, contentCode: string): ItemDraft {
  return {
    accountId,
    contentCode,
    title: "",
    contentType: OPS_CONTENT_TYPES[0],
    plannedDate: todayString(),
    stage: OPS_STAGES[0],
    compliance: OPS_COMPLIANCE_STATES[0],
    owner: "",
    hook: "",
    cta: "",
    views: 0,
    clicks: 0,
    ordersCount: 0,
  };
}

function itemToDraft(item: OpsContentItem): ItemDraft {
  return Object.fromEntries(ITEM_EDITABLE_KEYS.map((key) => [key, item[key]])) as unknown as ItemDraft;
}

function accountToDraft(account: OpsAccount): AccountDraft {
  return Object.fromEntries(ACCOUNT_EDITABLE_KEYS.map((key) => [key, account[key]])) as unknown as AccountDraft;
}

function rebaseDraft<T extends Record<string, unknown>>(
  current: T,
  base: T,
  draft: T,
  keys: Array<keyof T>,
): T {
  const next = { ...current };
  for (const key of keys) {
    if (!Object.is(draft[key], base[key])) next[key] = draft[key];
  }
  return next;
}

function isConflictPayload(value: Record<string, unknown>): value is Record<string, unknown> & ConflictPayload {
  return value.code === "EDIT_CONFLICT" && Boolean(value.current) && typeof value.error === "string";
}

async function sendMutation<T>(
  method: "POST" | "PUT" | "DELETE",
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/forms", {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new MutationError(typeof payload.error === "string" ? payload.error : "保存失败，请稍后重试。", response.status, payload);
  }
  return payload as T;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(2026, 7, 31);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function isoLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function chineseDate(value: Date, includeYear = true): string {
  return `${includeYear ? `${value.getFullYear()}年` : ""}${value.getMonth() + 1}月${value.getDate()}日`;
}

function getTimeWindow(anchorValue: string, scope: TimeScope): { start: string; end: string; label: string } {
  const anchor = parseLocalDate(anchorValue);
  const start = new Date(anchor);
  const end = new Date(anchor);
  if (scope === "month") {
    start.setDate(1);
    end.setMonth(end.getMonth() + 1, 0);
  } else if (scope === "week") {
    const weekday = (anchor.getDay() + 6) % 7;
    start.setDate(anchor.getDate() - weekday);
    end.setDate(start.getDate() + 6);
  }
  const label = scope === "month"
    ? `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`
    : scope === "day"
      ? chineseDate(anchor)
      : `${chineseDate(start)} — ${chineseDate(end, start.getFullYear() !== end.getFullYear())}`;
  return { start: isoLocalDate(start), end: isoLocalDate(end), label };
}

function moveDate(value: string, scope: TimeScope, direction: -1 | 1): string {
  const next = parseLocalDate(value);
  if (scope === "month") next.setMonth(next.getMonth() + direction);
  else next.setDate(next.getDate() + direction * (scope === "week" ? 7 : 1));
  return isoLocalDate(next);
}

function formatDate(value: string): string {
  return value.length >= 10 ? value.slice(5).replace("-", "/") : value;
}

function dateRangeIncludes(dateText: string, period: PeriodFilter): boolean {
  if (period === "all") return true;
  const date = parseLocalDate(dateText);
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  if (period === "month") {
    return date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth();
  }
  const weekday = (current.getDay() + 6) % 7;
  const start = new Date(current);
  start.setDate(current.getDate() - weekday);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return date >= start && date < end;
}

function changedFieldLabels(fields: string[]): string {
  const labels: Record<string, string> = {
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
  };
  return fields.map((field) => labels[field] || field).join("、");
}

export default function FormsPage() {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<OpsWorkspaceData>(EMPTY_WORKSPACE);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountsExpanded, setAccountsExpanded] = useState(true);
  const [hierarchyLevel, setHierarchyLevel] = useState<HierarchyLevel>("store");
  const [selectedOwner, setSelectedOwner] = useState("all");
  const [contentView, setContentView] = useState<ContentView>("canvas");
  const [timeScope, setTimeScope] = useState<TimeScope>("week");
  const [anchorDate, setAnchorDate] = useState("2026-08-31");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [page, setPage] = useState(1);
  const [itemOpen, setItemOpen] = useState(false);
  const [itemBase, setItemBase] = useState<OpsContentItem | null>(null);
  const [itemDraft, setItemDraft] = useState<ItemDraft>(() => emptyItem("", "A01"));
  const [itemConflict, setItemConflict] = useState<ConflictPayload | null>(null);
  const [hierarchyEditor, setHierarchyEditor] = useState<HierarchyEditor>(null);
  const [storeName, setStoreName] = useState("");
  const [accountDraft, setAccountDraft] = useState<AccountDraft>({
    storeId: "",
    handle: "",
    displayName: "",
    prefix: "",
    focus: "",
    tone: "",
  });
  const [hierarchyConflict, setHierarchyConflict] = useState<ConflictPayload | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const revisionRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  const loadWorkspace = useCallback(async (initial = false) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (initial) setLoading(true);
    else setSyncing(true);
    try {
      const data = await apiGet<OpsWorkspaceData>("/api/forms", { cache: "no-store" });
      revisionRef.current = data.revision;
      setWorkspace(data);
      setSelectedStoreId((current) => data.stores.some((store) => store.id === current) ? current : data.stores[0]?.id || "");
      setSelectedAccountId((current) => data.accounts.some((account) => account.id === current) ? current : data.accounts[0]?.id || "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "协作表读取失败，请刷新重试。");
    } finally {
      refreshInFlightRef.current = false;
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      loadWorkspace(true),
      apiGet<{ user: Me }>("/api/auth/me")
        .then((result) => setMe(result.user))
        .catch(() => router.replace("/login")),
    ]).catch(() => undefined);
  }, [loadWorkspace, router]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("jingxu-channel-ops");
    broadcastRef.current = channel;
    if (channel) channel.onmessage = () => void loadWorkspace(false);
    return () => {
      channel?.close();
      broadcastRef.current = null;
    };
  }, [loadWorkspace]);

  useEffect(() => {
    const checkRevision = async () => {
      if (document.visibilityState !== "visible" || refreshInFlightRef.current) return;
      try {
        const result = await apiGet<{ revision: number }>("/api/forms/revision", { cache: "no-store" });
        if (result.revision !== revisionRef.current) await loadWorkspace(false);
      } catch {
        // A temporary tunnel hiccup is retried on the next lightweight poll.
      }
    };
    const interval = window.setInterval(() => void checkRevision(), 3_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkRevision();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (!itemOpen && !hierarchyEditor) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hierarchyEditor, itemOpen]);

  const selectedStore = workspace.stores.find((store) => store.id === selectedStoreId) || workspace.stores[0] || null;
  const storeAccounts = useMemo(
    () => workspace.accounts.filter((account) => account.storeId === selectedStore?.id),
    [selectedStore?.id, workspace.accounts],
  );
  const selectedAccount = storeAccounts.find((account) => account.id === selectedAccountId) || storeAccounts[0] || null;
  const timeWindow = useMemo(() => getTimeWindow(anchorDate, timeScope), [anchorDate, timeScope]);
  const periodItems = useMemo(
    () => workspace.items.filter((item) => item.plannedDate >= timeWindow.start && item.plannedDate <= timeWindow.end),
    [timeWindow.end, timeWindow.start, workspace.items],
  );
  const accountPeriodItems = useMemo(
    () => selectedAccount ? periodItems.filter((item) => item.accountId === selectedAccount.id) : [],
    [periodItems, selectedAccount],
  );
  const ownerOptions = useMemo(
    () => Array.from(new Set(workspace.items.filter((item) => item.accountId === selectedAccount?.id).map((item) => item.owner.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [selectedAccount?.id, workspace.items],
  );
  const activeOwner = selectedOwner !== "all" && ownerOptions.includes(selectedOwner) ? selectedOwner : "all";
  const selectedItems = useMemo(
    () => hierarchyLevel === "owner" && activeOwner !== "all" ? accountPeriodItems.filter((item) => item.owner.trim() === activeOwner) : accountPeriodItems,
    [accountPeriodItems, activeOwner, hierarchyLevel],
  );
  const owners = useMemo(
    () => Array.from(new Set(selectedItems.map((item) => item.owner).filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [selectedItems],
  );
  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return selectedItems.filter((item) => {
      const filterMatch = filter === "all"
        || (filter === "review" && item.compliance !== "已通过")
        || (filter === "ready" && item.compliance === "已通过" && item.stage === "待发布")
        || (filter === "published" && item.stage === "已发布");
      if (!filterMatch) return false;
      if (!term) return true;
      return [item.contentCode, item.title, item.contentType, item.owner, item.hook, item.cta]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [filter, search, selectedItems]);
  const hiddenFilteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return selectedItems.filter((item) => {
      if (stageFilter !== "all" && item.stage !== stageFilter) return false;
      if (ownerFilter !== "all" && item.owner !== ownerFilter) return false;
      if (!dateRangeIncludes(item.plannedDate, periodFilter)) return false;
      return !term || [item.contentCode, item.title, item.contentType, item.owner, item.hook, item.cta].join(" ").toLowerCase().includes(term);
    });
  }, [ownerFilter, periodFilter, search, selectedItems, stageFilter]);
  const pageSize = 40;
  const pageCount = Math.max(1, Math.ceil(hiddenFilteredItems.length / pageSize));
  const visibleItems = hiddenFilteredItems.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);

  useEffect(() => setPage(1), [ownerFilter, periodFilter, search, selectedAccountId, stageFilter]);

  useEffect(() => {
    if (!selectedStore) return;
    if (!storeAccounts.some((account) => account.id === selectedAccountId)) {
      setSelectedAccountId(storeAccounts[0]?.id || "");
    }
  }, [selectedAccountId, selectedStore, storeAccounts]);

  const stats = useMemo(() => {
    const total = selectedItems.length;
    const active = selectedItems.filter((item) => ["待生成", "脚本完成", "剪辑中", "待审核"].includes(item.stage)).length;
    const review = selectedItems.filter((item) => item.compliance !== "已通过").length;
    const published = selectedItems.filter((item) => item.stage === "已发布").length;
    const passed = selectedItems.filter((item) => item.compliance === "已通过").length;
    const ready = selectedItems.filter((item) => item.compliance === "已通过" && item.stage === "待发布").length;
    return { total, active, review, published, ready, passRate: total ? Math.round((passed / total) * 100) : 0 };
  }, [selectedItems]);

  const resetViewFilters = () => {
    setFilter("all");
    setSearch("");
  };

  const selectStore = (store: OpsStore) => {
    if (store.id === selectedStore?.id) {
      setAccountsExpanded((current) => !current);
      return;
    }
    const accounts = workspace.accounts.filter((account) => account.storeId === store.id);
    setSelectedStoreId(store.id);
    setSelectedAccountId(accounts[0]?.id || "");
    setSelectedOwner("all");
    setAccountsExpanded(true);
    resetViewFilters();
  };

  const selectAccount = (account: OpsAccount) => {
    setSelectedStoreId(account.storeId);
    setSelectedAccountId(account.id);
    setSelectedOwner("all");
    setAccountsExpanded(true);
    resetViewFilters();
  };

  const selectHierarchyLevel = (level: HierarchyLevel) => {
    setHierarchyLevel(level);
    if (level === "store") setSelectedOwner("all");
    resetViewFilters();
  };

  const selectTimeScope = (scope: TimeScope) => {
    setTimeScope(scope);
    setFilter("all");
  };

  const nextCode = (accountId: string): string => {
    const account = workspace.accounts.find((entry) => entry.id === accountId);
    const prefix = account?.prefix || "C";
    const highest = workspace.items
      .filter((item) => item.accountId === accountId && item.contentCode.startsWith(prefix))
      .reduce((max, item) => Math.max(max, Number(item.contentCode.slice(prefix.length)) || 0), 0);
    return `${prefix}${String(highest + 1).padStart(2, "0")}`;
  };

  const announceMutation = async (message: string, merged = false) => {
    broadcastRef.current?.postMessage({ revision: Date.now() });
    await loadWorkspace(false);
    toast.success(merged ? `${message}，并已自动合并同事对其他字段的修改。` : message);
  };

  const openNewItem = (
    accountId = selectedAccount?.id || "",
    plannedDate = anchorDate,
    stage = OPS_STAGES[0],
  ) => {
    const account = workspace.accounts.find((entry) => entry.id === accountId);
    if (!account) {
      toast.error("请先添加并选择一个账号。");
      return;
    }
    setItemBase(null);
    setItemDraft({
      ...emptyItem(account.id, nextCode(account.id)),
      plannedDate,
      stage,
    });
    setItemConflict(null);
    setItemOpen(true);
  };

  const openEditItem = (item: OpsContentItem) => {
    setItemBase(item);
    setItemDraft(itemToDraft(item));
    setItemConflict(null);
    setItemOpen(true);
  };

  const saveItem = async (continueAdding = false) => {
    setSaving(true);
    setItemConflict(null);
    try {
      const result = itemBase
        ? await sendMutation<OpsMutationResult<OpsContentItem>>("PUT", {
            entity: "item",
            id: itemBase.id,
            baseVersion: itemBase.version,
            base: itemToDraft(itemBase),
            data: itemDraft,
          })
        : await sendMutation<OpsMutationResult<OpsContentItem>>("POST", { entity: "item", data: itemDraft });
      if (continueAdding) {
        const account = workspace.accounts.find((entry) => entry.id === result.value.accountId);
        const prefix = account?.prefix || "C";
        const currentNumber = Number(result.value.contentCode.slice(prefix.length)) || 0;
        setItemBase(null);
        setItemDraft({
          ...emptyItem(result.value.accountId, `${prefix}${String(currentNumber + 1).padStart(2, "0")}`),
          plannedDate: result.value.plannedDate,
        });
      } else {
        setItemOpen(false);
      }
      await announceMutation(itemBase ? "内容规划已保存" : "内容规划已新增", result.merged);
    } catch (error) {
      if (error instanceof MutationError && error.status === 409 && isConflictPayload(error.payload)) {
        setItemConflict(error.payload);
      } else {
        toast.error(error instanceof Error ? error.message : "内容规划保存失败，请重试。");
      }
    } finally {
      setSaving(false);
    }
  };

  const keepMyItemChanges = () => {
    if (!itemConflict || !itemBase || !("contentCode" in itemConflict.current)) return;
    const current = itemConflict.current as OpsContentItem;
    const rebased = rebaseDraft(
      itemToDraft(current) as unknown as Record<string, unknown>,
      itemToDraft(itemBase) as unknown as Record<string, unknown>,
      itemDraft as unknown as Record<string, unknown>,
      ITEM_EDITABLE_KEYS,
    ) as unknown as ItemDraft;
    setItemBase(current);
    setItemDraft(rebased);
    setItemConflict(null);
    toast.message("已保留你的改动；再次保存时只覆盖你实际改过的字段。");
  };

  const loadCurrentItem = () => {
    if (!itemConflict || !("contentCode" in itemConflict.current)) return;
    const current = itemConflict.current as OpsContentItem;
    setItemBase(current);
    setItemDraft(itemToDraft(current));
    setItemConflict(null);
  };

  const openStoreEditor = (base: OpsStore | null) => {
    setHierarchyEditor({ entity: "store", base });
    setStoreName(base?.name || "");
    setHierarchyConflict(null);
  };

  const suggestPrefix = (storeId: string): string => {
    const used = new Set(
      workspace.accounts
        .filter((account) => account.storeId === storeId)
        .map((account) => account.prefix.toUpperCase()),
    );
    for (const prefix of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!used.has(prefix)) return prefix;
    }
    return `X${used.size + 1}`;
  };

  const openAccountEditor = (base: OpsAccount | null, storeId = selectedStoreId) => {
    setHierarchyEditor({ entity: "account", base });
    setAccountDraft(base ? accountToDraft(base) : {
      storeId,
      handle: "",
      displayName: "",
      prefix: suggestPrefix(storeId),
      focus: "",
      tone: "",
    });
    setHierarchyConflict(null);
  };

  const saveHierarchy = async () => {
    if (!hierarchyEditor) return;
    setSaving(true);
    setHierarchyConflict(null);
    try {
      if (hierarchyEditor.entity === "store") {
        const data = { name: storeName };
        const result = hierarchyEditor.base
          ? await sendMutation<OpsMutationResult<OpsStore>>("PUT", {
              entity: "store",
              id: hierarchyEditor.base.id,
              baseVersion: hierarchyEditor.base.version,
              base: { name: hierarchyEditor.base.name },
              data,
            })
          : await sendMutation<OpsMutationResult<OpsStore>>("POST", { entity: "store", data });
        setHierarchyEditor(null);
        await announceMutation(hierarchyEditor.base ? "店铺已保存" : "店铺已新增", result.merged);
      } else {
        const result = hierarchyEditor.base
          ? await sendMutation<OpsMutationResult<OpsAccount>>("PUT", {
              entity: "account",
              id: hierarchyEditor.base.id,
              baseVersion: hierarchyEditor.base.version,
              base: accountToDraft(hierarchyEditor.base),
              data: accountDraft,
            })
          : await sendMutation<OpsMutationResult<OpsAccount>>("POST", { entity: "account", data: accountDraft });
        setHierarchyEditor(null);
        await announceMutation(hierarchyEditor.base ? "账号已保存" : "账号已新增", result.merged);
      }
    } catch (error) {
      if (error instanceof MutationError && error.status === 409 && isConflictPayload(error.payload)) {
        setHierarchyConflict(error.payload);
      } else {
        toast.error(error instanceof Error ? error.message : "保存失败，请重试。");
      }
    } finally {
      setSaving(false);
    }
  };

  const keepMyHierarchyChanges = () => {
    if (!hierarchyEditor || !hierarchyConflict) return;
    if (hierarchyEditor.entity === "store" && "name" in hierarchyConflict.current && !("handle" in hierarchyConflict.current)) {
      const current = hierarchyConflict.current as OpsStore;
      const oldName = hierarchyEditor.base?.name || "";
      setStoreName(storeName === oldName ? current.name : storeName);
      setHierarchyEditor({ entity: "store", base: current });
      setHierarchyConflict(null);
      return;
    }
    if (hierarchyEditor.entity === "account" && "handle" in hierarchyConflict.current) {
      const current = hierarchyConflict.current as OpsAccount;
      const oldBase = hierarchyEditor.base;
      if (!oldBase) return;
      const rebased = rebaseDraft(
        accountToDraft(current) as unknown as Record<string, unknown>,
        accountToDraft(oldBase) as unknown as Record<string, unknown>,
        accountDraft as unknown as Record<string, unknown>,
        ACCOUNT_EDITABLE_KEYS,
      ) as unknown as AccountDraft;
      setAccountDraft(rebased);
      setHierarchyEditor({ entity: "account", base: current });
      setHierarchyConflict(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await sendMutation<{ revision: number }>("DELETE", {
        entity: deleteTarget.entity,
        id: deleteTarget.id,
        baseVersion: deleteTarget.version,
      });
      const label = deleteTarget.label;
      setDeleteTarget(null);
      await announceMutation(`${label} 已删除`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败，请重试。");
      if (error instanceof MutationError && [404, 409].includes(error.status)) await loadWorkspace(false);
    } finally {
      setDeleting(false);
    }
  };

  const exportCsv = () => {
    const headers = ["店铺", "账号", "内容编号", "内容选题", "内容类型", "计划日期", "制作状态", "合规", "负责人", "Hook", "CTA", "播放", "点击", "订单"];
    const rows = filteredItems.map((item) => {
      const account = workspace.accounts.find((entry) => entry.id === item.accountId);
      const store = workspace.stores.find((entry) => entry.id === account?.storeId);
      return [store?.name, account?.handle, item.contentCode, item.title, item.contentType, item.plannedDate, item.stage, item.compliance, item.owner, item.hook, item.cta, item.views, item.clicks, item.ordersCount];
    });
    const blob = new Blob(["\uFEFF", [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const scopeLabel = timeScope === "month" ? "月" : timeScope === "week" ? "周" : "日";
    const ownerSuffix = hierarchyLevel === "owner" && activeOwner !== "all" ? `_${activeOwner}` : "";
    anchor.download = `${selectedStore?.name || "渠道内容规划"}_${selectedAccount?.prefix || "账号"}${ownerSuffix}_${scopeLabel}视图.csv`.replace(/[\\/:*?"<>|]/g, "_");
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const currentProgress = selectedItems.length
    ? Math.round((selectedItems.filter((item) => ["已发布", "待发布"].includes(item.stage)).length / selectedItems.length) * 100)
    : 0;
  const ownerContext = hierarchyLevel === "owner" ? (activeOwner === "all" ? "全部负责人" : activeOwner) : "";
  const nextAccount = selectedAccount && storeAccounts.length > 1
    ? storeAccounts[(storeAccounts.findIndex((account) => account.id === selectedAccount.id) + 1) % storeAccounts.length]
    : undefined;

  const renderOriginalWorkspace = () => (
    <main className="ops-workbench-theme min-h-screen bg-background text-foreground">
      <a href="#ops-main-content" className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-primary shadow-lg transition-transform focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        跳到主要内容
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[228px] flex-col border-r border-border bg-[#f1f1e8] px-4 py-5 lg:flex">
        <Link href="/dashboard" className="flex items-center gap-3 rounded-xl px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" title="返回镜序创作台">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><FlaskConical className="h-5 w-5" aria-hidden="true" /></span>
          <span><span className="block text-sm font-bold tracking-tight">STORETWO</span><span className="block text-[11px] text-muted-foreground">店铺渠道运营台</span></span>
        </Link>
        <nav className="mt-8 min-h-0 flex-1" aria-label="账号导航">
          <p className="px-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">当前店铺</p>
          <div className="mx-1 mt-2 rounded-xl border border-border bg-white/65 p-3">
            <div className="flex items-center gap-2"><StoreIcon className="h-3.5 w-3.5 text-primary" aria-hidden="true" /><p className="truncate text-xs font-bold">{selectedStore?.name || "尚未添加店铺"}</p></div>
            <p className="mt-1 text-[10px] text-muted-foreground">{storeAccounts.length} 个账号</p>
          </div>
          <p className="mt-5 px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">选择账号</p>
          <div className="max-h-[42vh] space-y-1 overflow-y-auto pr-1">
            {storeAccounts.map((account) => <OpsSidebarAccount key={account.id} account={account} active={account.id === selectedAccount?.id} onClick={() => selectAccount(account)} />)}
            {selectedStore && !storeAccounts.length && <p className="px-2 py-3 text-[11px] leading-5 text-muted-foreground">这个店铺还没有账号。</p>}
          </div>
          <Button className="mt-2 w-full justify-start" variant="ghost" size="sm" onClick={() => openAccountEditor(null, selectedStore?.id || "")}><Plus aria-hidden="true" />添加账号</Button>
          <div className="my-3 border-t border-border" />
          <Button className="w-full justify-start text-muted-foreground" variant="ghost" size="lg" onClick={() => setFilter("all")}><LayoutDashboard aria-hidden="true" />本账号内容</Button>
          <Button className="w-full justify-start text-muted-foreground" variant="ghost" size="lg" onClick={() => setFilter("review")}><ShieldCheck aria-hidden="true" />本账号待复核</Button>
          <Button className="w-full justify-start text-muted-foreground" variant="ghost" size="lg" onClick={exportCsv} disabled={!selectedAccount}><Download aria-hidden="true" />导出当前视图</Button>
          {me?.isAdmin && <Button asChild className="w-full justify-start text-muted-foreground" variant="ghost" size="lg"><Link href="/forms/history"><History aria-hidden="true" />更改记录</Link></Button>}
        </nav>
        <div className="mt-4 rounded-xl border border-border bg-white/70 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold"><CircleDot className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />产品事实卡</div>
          <p className="text-[11px] leading-5 text-muted-foreground">Selenium Sulfide 1% · 300 mL<br />建议每周使用 2–3 次</p>
        </div>
      </aside>

      <section id="ops-main-content" className="min-h-screen scroll-mt-16 lg:pl-[228px]">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-5 backdrop-blur-xl sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden" aria-label="返回镜序创作台"><FlaskConical className="h-4 w-4" aria-hidden="true" /></Link>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold tracking-tight text-balance sm:text-lg">{selectedAccount ? `${selectedAccount.prefix} · ${selectedAccount.handle}` : "店铺运营总览"}</h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">{selectedStore?.name || "请添加店铺"}{selectedAccount ? ` / ${selectedAccount.displayName}` : ""}{ownerContext ? ` / 负责人：${ownerContext}` : ""} · {timeWindow.label}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="sr-only" aria-live="polite">{syncing ? "正在同步最新数据" : "数据已同步"}</span>
            <Button onClick={() => openNewItem()} disabled={!selectedAccount}><Plus aria-hidden="true" />新增规划</Button>
          </div>
        </header>

        <div className="mx-auto max-w-[1480px] space-y-6 px-5 py-6 sm:px-8 sm:py-8">
          <section className="rounded-2xl border bg-card p-4 shadow-[0_8px_26px_rgb(39_45_42/4%)]" aria-label="店铺与账号选择">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <OpsNativeSelect className="w-[132px]" value={hierarchyLevel} onChange={(event) => selectHierarchyLevel(event.target.value as HierarchyLevel)} aria-label="选择查看层级">
                  <option value="store">店铺层级</option><option value="owner">负责人层级</option>
                </OpsNativeSelect>
                <p className="mt-1 text-sm font-bold">{hierarchyLevel === "store" ? "横向选择店铺，点击当前店铺可展开或收起账号" : "选择负责人后，指标和规划表会同步筛选"}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <fieldset className="flex rounded-lg bg-muted p-1" aria-label="内容展示方式"><OpsViewModeButton label="表格" active={contentView === "table"} onClick={() => setContentView("table")} /><OpsViewModeButton label="画布" active={contentView === "canvas"} onClick={() => setContentView("canvas")} /></fieldset>
                <Button variant="outline" size="sm" onClick={() => openStoreEditor(null)}><Plus aria-hidden="true" />添加店铺</Button>
              </div>
            </div>
            <div className="-mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-2">
              {workspace.stores.map((store) => <OpsStoreCard key={store.id} store={store} accountCount={workspace.accounts.filter((account) => account.storeId === store.id).length} active={store.id === selectedStore?.id} expanded={store.id === selectedStore?.id && accountsExpanded} contentCount={periodItems.filter((item) => workspace.accounts.find((account) => account.id === item.accountId)?.storeId === store.id).length} onClick={() => selectStore(store)} onEdit={() => openStoreEditor(store)} />)}
              {!loading && !workspace.stores.length && <button type="button" onClick={() => openStoreEditor(null)} className="flex min-h-[98px] min-w-[260px] items-center justify-center gap-2 rounded-xl border border-dashed text-sm font-semibold text-muted-foreground hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Plus className="h-4 w-4" aria-hidden="true" />创建第一个店铺</button>}
            </div>
            {selectedStore && accountsExpanded && (
              <div className="mt-3 border-t pt-4">
                <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-bold">{selectedStore.name} · 账号</p><p className="mt-0.5 text-[11px] text-muted-foreground">每个账号的内容、指标和筛选相互独立</p></div><Button size="sm" onClick={() => openAccountEditor(null, selectedStore.id)}><Plus aria-hidden="true" />添加账号</Button></div>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {storeAccounts.map((account, index) => <OpsAccountCard key={account.id} account={account} active={account.id === selectedAccount?.id} index={index} onClick={() => selectAccount(account)} onEdit={() => openAccountEditor(account)} />)}
                  {!storeAccounts.length && <button type="button" onClick={() => openAccountEditor(null, selectedStore.id)} className="flex min-h-[124px] min-w-[300px] items-center justify-center gap-2 rounded-2xl border border-dashed text-sm font-semibold text-muted-foreground hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Users className="h-4 w-4" aria-hidden="true" />为这个店铺添加第一个账号</button>}
                </div>
                {selectedAccount && <OpsReferenceVideoPanel account={selectedAccount} revision={workspace.revision} />}
              </div>
            )}
            {hierarchyLevel === "owner" && selectedAccount && (
              <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-muted/35 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground"><Users className="h-4 w-4" aria-hidden="true" /></span><div className="min-w-0"><p className="text-xs font-bold">负责人筛选 · {selectedAccount.handle}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{ownerOptions.length ? `已从当前账号规划中汇总 ${ownerOptions.length} 位负责人` : "当前账号还没有负责人；新增规划时填写即可自动出现"}</p></div></div>
                <OpsNativeSelect className="w-full sm:w-[220px]" value={activeOwner} onChange={(event) => { setSelectedOwner(event.target.value); resetViewFilters(); }} disabled={!ownerOptions.length} aria-label="选择负责人"><option value="all">全部负责人</option>{ownerOptions.map((owner) => <option key={owner} value={owner}>{owner}</option>)}</OpsNativeSelect>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-[0_8px_24px_rgb(39_45_42/4%)] sm:flex-row sm:items-center sm:justify-between" aria-label="时间筛选">
            <div className="flex flex-wrap items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary text-secondary-foreground"><CalendarDays className="h-4 w-4" aria-hidden="true" /></span><div><p className="text-xs font-bold">时间范围</p><p className="mt-0.5 text-[11px] text-muted-foreground">{timeWindow.label}</p></div><div className="ml-1 flex rounded-lg bg-muted p-1"><OpsTimeScopeButton active={timeScope === "month"} label="月" onClick={() => selectTimeScope("month")} /><OpsTimeScopeButton active={timeScope === "week"} label="周" onClick={() => selectTimeScope("week")} /><OpsTimeScopeButton active={timeScope === "day"} label="日" onClick={() => selectTimeScope("day")} /></div></div>
            <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="icon" aria-label="上一时间段" onClick={() => setAnchorDate(moveDate(anchorDate, timeScope, -1))}><ChevronLeft aria-hidden="true" /></Button><Input className="w-[145px] bg-background" name="anchorDate" type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value || "2026-08-31")} aria-label="筛选基准日期" /><Button variant="outline" size="icon" aria-label="下一时间段" onClick={() => setAnchorDate(moveDate(anchorDate, timeScope, 1))}><ChevronRight aria-hidden="true" /></Button><Button variant="ghost" size="sm" onClick={() => setAnchorDate(todayString())}>今天</Button></div>
          </section>

          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="当前账号概览">
            <OpsMetricCard label={hierarchyLevel === "owner" && activeOwner !== "all" ? "负责人内容" : "本账号内容"} value={String(stats.total)} unit="条" note={ownerContext || timeWindow.label} icon={<Video />} tone="ink" />
            <OpsMetricCard label="制作进行中" value={String(stats.active)} unit="条" note="生成、脚本、剪辑、审核" icon={<BarChart3 />} tone="amber" />
            <OpsMetricCard label="待合规复核" value={String(stats.review)} unit="条" note="发布前必须完成" icon={<ShieldCheck />} tone="rose" />
            <OpsMetricCard label="合规通过率" value={String(stats.passRate)} unit="%" note={ownerContext || (selectedAccount ? `${selectedAccount.prefix} · 当前范围` : "尚未选择账号")} icon={<CheckCircle2 />} tone="green" />
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <Card className="border-0 shadow-[0_12px_34px_rgb(39_45_42/6%)] ring-1 ring-border">
              <CardHeader className="border-b pb-4"><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><CardTitle className="text-base font-bold">{selectedAccount ? `${selectedAccount.handle} ${contentView === "canvas" ? "横向运营树" : "内容规划与生产表"}` : "账号内容规划"}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{contentView === "canvas" ? "店铺 → 账号 → 负责人 → 内容规划，点击节点可逐级收缩或展开" : "可新增规划，也可点击任意一行修改已有规划"} · {timeWindow.label}{ownerContext ? ` · ${ownerContext}` : ""}</p></div><div className="flex flex-col gap-2 sm:flex-row"><div className="relative min-w-[230px]"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input name="opsSearch" autoComplete="off" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索编号、选题或负责人…" disabled={!selectedAccount} aria-label="搜索编号、选题或负责人" /></div><Button onClick={() => openNewItem()} disabled={!selectedAccount}><Plus aria-hidden="true" />新增规划</Button><Button variant="outline" onClick={exportCsv} disabled={!selectedAccount}><Download aria-hidden="true" />导出当前视图</Button></div></div><div className="mt-1 flex flex-wrap gap-2"><OpsFilterPill active={filter === "all"} label={`全部 ${stats.total}`} onClick={() => setFilter("all")} /><OpsFilterPill active={filter === "review"} label={`待复核 · ${stats.review}`} onClick={() => setFilter("review")} /><OpsFilterPill active={filter === "ready"} label={`可发布 · ${stats.ready}`} onClick={() => setFilter("ready")} /><OpsFilterPill active={filter === "published"} label={`已发布 · ${stats.published}`} onClick={() => setFilter("published")} /></div></CardHeader>
              {contentView === "table" ? (
                <CardContent className="px-0"><Table><TableHeader><TableRow className="bg-muted/35 hover:bg-muted/35"><TableHead className="pl-5">内容 / 选题</TableHead><TableHead>计划发布</TableHead><TableHead>制作状态</TableHead><TableHead>合规</TableHead><TableHead>负责人</TableHead><TableHead className="w-24">操作</TableHead></TableRow></TableHeader><TableBody>
                  {loading && <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在载入运营数据…</TableCell></TableRow>}
                  {!loading && !selectedAccount && <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground">这个店铺还没有账号。<Button variant="link" onClick={() => openAccountEditor(null, selectedStore?.id || "")}>添加账号</Button></TableCell></TableRow>}
                  {!loading && selectedAccount && !filteredItems.length && <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground">当前时间范围内没有符合条件的内容。<Button variant="link" onClick={() => { setSearch(""); setFilter("all"); setSelectedOwner("all"); }}>清除筛选</Button></TableCell></TableRow>}
                  {!loading && filteredItems.map((item) => <TableRow key={item.id} className="group h-[70px] cursor-pointer" onClick={() => openEditItem(item)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openEditItem(item); } }}><TableCell className="min-w-[310px] pl-5"><div className="flex items-start gap-3"><span className="mt-0.5 font-mono text-xs font-bold text-primary">{item.contentCode}</span><div className="min-w-0"><p className="max-w-[360px] truncate font-semibold">{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{item.contentType}</p></div></div></TableCell><TableCell className="font-medium tabular-nums">{formatDate(item.plannedDate)}</TableCell><TableCell><Badge variant="outline" className={stageClass[item.stage] || stageClass["选题池"]}>{item.stage}</Badge></TableCell><TableCell><OpsComplianceState value={item.compliance} /></TableCell><TableCell><span className="ops-avatar-chip">{item.owner.slice(0, 1).toUpperCase()}</span>{item.owner}</TableCell><TableCell><Button size="sm" variant="ghost" aria-label={`编辑规划 ${item.contentCode}`} onClick={(event) => { event.stopPropagation(); openEditItem(item); }}><Pencil aria-hidden="true" />编辑规划</Button></TableCell></TableRow>)}
                </TableBody></Table></CardContent>
              ) : <CardContent className="p-4"><OpsHorizontalTreeCanvas store={selectedStore} account={selectedAccount} items={filteredItems} loading={loading} onEdit={openEditItem} onAdd={() => openNewItem()} onAddAccount={() => openAccountEditor(null, selectedStore?.id || "")} onClear={() => { setSearch(""); setFilter("all"); setSelectedOwner("all"); }} /></CardContent>}
            </Card>

            <aside className="space-y-4">
              <Card className="border-0 bg-primary text-primary-foreground shadow-[0_14px_30px_rgb(27_72_61/16%)] ring-0"><CardHeader><span className="mb-2 grid h-9 w-9 place-items-center rounded-lg bg-white/10"><ShieldCheck className="h-4 w-4" aria-hidden="true" /></span><CardTitle className="font-bold">{selectedAccount ? `账号 ${selectedAccount.prefix} 发布闸门` : "发布闸门"}</CardTitle></CardHeader><CardContent className="space-y-3 text-xs"><OpsCheckItem done text="产品外观与液体颜色一致" /><OpsCheckItem done text="频次：每周使用 2–3 次" /><OpsCheckItem text="商品卡实际绑定状态" /><OpsCheckItem text="AI 内容标记已添加" /><Button className="mt-2 w-full bg-white text-primary hover:bg-white/90" onClick={() => setFilter("review")} disabled={!selectedAccount}>查看待复核内容</Button></CardContent></Card>
              <Card className="border-0 shadow-[0_12px_34px_rgb(39_45_42/6%)] ring-1 ring-border"><CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-sm font-bold">当前账号定位</CardTitle>{selectedAccount && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="编辑当前账号" onClick={() => openAccountEditor(selectedAccount)}><Pencil aria-hidden="true" /></Button>}</CardHeader><CardContent className="space-y-4">{selectedAccount ? <><div><p className="font-bold">{selectedAccount.displayName}</p><p className="mt-1 text-xs text-muted-foreground">{selectedAccount.handle} · 编号 {selectedAccount.prefix}</p></div><div className="rounded-lg bg-muted/70 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">内容方向</p><p className="mt-1 text-xs leading-5">{selectedAccount.focus || "暂未填写，可在新账号创建时设置。"}</p></div><p className="text-xs leading-5 text-muted-foreground">{selectedAccount.tone || "暂未填写账号语气。"}</p><OpsChannelProgress label="当前范围完成节奏" subtitle="已发布 + 待发布" value={currentProgress} />{nextAccount && <Button className="w-full" variant="outline" onClick={() => selectAccount(nextAccount)}>切换到 {nextAccount.prefix} · {nextAccount.handle}</Button>}</> : <div className="py-5 text-center"><Users className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" /><p className="mt-3 text-sm font-bold">还没有可查看的账号</p><Button className="mt-3" size="sm" onClick={() => openAccountEditor(null, selectedStore?.id || "")}>添加账号</Button></div>}</CardContent></Card>
            </aside>
          </section>
        </div>
      </section>
    </main>
  );

  return (
    <div className="ops-workbench-theme min-h-screen">
      {renderOriginalWorkspace()}
      <div className="hidden" aria-hidden="true">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" aria-labelledby="ops-title">
          <div className="h-1 bg-[linear-gradient(90deg,#18181b_0_24%,#7c3aed_24%_42%,#0f766e_42%_62%,#d97706_62%_78%,#e4e4e7_78%)]" />
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="ops-title" className="text-xl font-semibold tracking-tight text-zinc-950 text-balance">渠道内容协作表</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                  <Wifi className="h-3 w-3" aria-hidden="true" />
                  {syncing ? "同步中…" : "共享数据 · 已同步"}
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-500">所有同事共同编辑同一份内容计划。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {me?.isAdmin && (
                <Button asChild variant="outline">
                  <Link href="/forms/history"><History aria-hidden="true" />更改记录</Link>
                </Button>
              )}
              <Button variant="outline" onClick={exportCsv} disabled={!filteredItems.length}>
                <Download aria-hidden="true" />导出当前结果
              </Button>
              <Button onClick={() => openNewItem()} disabled={!selectedAccount}>
                <Plus aria-hidden="true" />新增规划
              </Button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border bg-white p-4 shadow-sm sm:p-5" aria-labelledby="hierarchy-title">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="store-picker" id="hierarchy-title">店铺</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem_2.25rem] gap-2">
                  <select
                    id="store-picker"
                    name="store"
                    className="h-9 w-full min-w-0 rounded-md border bg-white px-3 text-sm text-zinc-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                    value={selectedStoreId}
                    onChange={(event) => {
                      const storeId = event.target.value;
                      setSelectedStoreId(storeId);
                      setSelectedAccountId(workspace.accounts.find((account) => account.storeId === storeId)?.id || "");
                    }}
                  >
                    {!workspace.stores.length && <option value="">尚未添加店铺</option>}
                    {workspace.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
                  <Button variant="outline" size="icon" aria-label="编辑当前店铺" onClick={() => selectedStore && openStoreEditor(selectedStore)} disabled={!selectedStore}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="outline" size="icon" aria-label="新增店铺" onClick={() => openStoreEditor(null)}>
                    <Plus aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-picker">账号</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem_2.25rem] gap-2">
                  <select
                    id="account-picker"
                    name="account"
                    className="h-9 w-full min-w-0 rounded-md border bg-white px-3 text-sm text-zinc-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                    value={selectedAccountId}
                    onChange={(event) => setSelectedAccountId(event.target.value)}
                    disabled={!storeAccounts.length}
                  >
                    {!storeAccounts.length && <option value="">这个店铺还没有账号</option>}
                    {storeAccounts.map((account) => <option key={account.id} value={account.id}>{account.prefix} · {account.displayName} · {account.handle}</option>)}
                  </select>
                  <Button variant="outline" size="icon" aria-label="编辑当前账号" onClick={() => selectedAccount && openAccountEditor(selectedAccount)} disabled={!selectedAccount}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="outline" size="icon" aria-label="新增账号" onClick={() => openAccountEditor(null)} disabled={!selectedStore}>
                    <Plus aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
              {workspace.latestChangeAt ? `最近同步 ${formatTime(workspace.latestChangeAt)}` : "已载入原填表数据"}
            </div>
          </div>
          {selectedAccount && (
            <div className="mt-4 flex flex-col gap-1 rounded-xl bg-zinc-50 px-4 py-3 text-xs sm:flex-row sm:items-center sm:gap-3">
              <span className="font-semibold text-zinc-800">{selectedAccount.displayName}</span>
              <span className="text-zinc-500" translate="no">{selectedAccount.handle}</span>
              {selectedAccount.focus && <span className="text-zinc-500 sm:border-l sm:pl-3">{selectedAccount.focus}</span>}
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="当前账号概览">
          <Metric label="内容规划" value={stats.total} icon={<CalendarDays />} tone="zinc" />
          <Metric label="制作进行中" value={stats.active} icon={<BarChart3 />} tone="violet" />
          <Metric label="待合规复核" value={stats.review} icon={<ShieldCheck />} tone="amber" />
          <Metric label="已经发布" value={stats.published} icon={<CheckCircle2 />} tone="emerald" />
        </section>

        <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" aria-labelledby="content-table-title">
          <div className="border-b px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 id="content-table-title" className="text-base font-semibold">{selectedAccount ? `${selectedAccount.prefix} · 内容规划` : "内容规划"}</h2>
                <p className="mt-0.5 text-xs text-zinc-500">{filteredItems.length} 条符合当前条件</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:flex">
                <div className="relative sm:col-span-2 xl:w-64">
                  <Label htmlFor="content-search" className="sr-only">搜索内容</Label>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                  <Input id="content-search" name="search" autoComplete="off" className="pl-9" placeholder="搜索编号、选题、负责人…" value={search} onChange={(event) => setSearch(event.target.value)} />
                </div>
                <FilterSelect label="时间范围" value={periodFilter} onValueChange={(value) => setPeriodFilter(value as PeriodFilter)} options={[{ value: "all", label: "全部日期" }, { value: "week", label: "本周" }, { value: "month", label: "本月" }]} />
                <FilterSelect label="制作状态" value={stageFilter} onValueChange={setStageFilter} options={[{ value: "all", label: "全部状态" }, ...OPS_STAGES.map((stage) => ({ value: stage, label: stage }))]} />
                <FilterSelect label="负责人" value={ownerFilter} onValueChange={setOwnerFilter} options={[{ value: "all", label: "全部负责人" }, ...owners.map((owner) => ({ value: owner, label: owner }))]} />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />载入协作表…
            </div>
          ) : !selectedAccount ? (
            <EmptyState icon={<UsersRound />} title="先添加一个账号" action="添加账号" onAction={() => openAccountEditor(null)} disabled={!selectedStore} />
          ) : !filteredItems.length ? (
            <EmptyState icon={<Search />} title="当前条件下没有内容" action="清除筛选" onAction={() => { setSearch(""); setStageFilter("all"); setOwnerFilter("all"); setPeriodFilter("all"); }} />
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-zinc-50 hover:bg-zinc-50">
                      <TableHead className="pl-5">内容 / 选题</TableHead>
                      <TableHead>计划日期</TableHead>
                      <TableHead>制作状态</TableHead>
                      <TableHead>合规</TableHead>
                      <TableHead>负责人</TableHead>
                      <TableHead className="text-right">播放 / 点击 / 订单</TableHead>
                      <TableHead className="w-20"><span className="sr-only">操作</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleItems.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="min-w-[300px] pl-5">
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 shrink-0 font-mono text-xs font-semibold text-violet-700" translate="no">{item.contentCode}</span>
                            <div className="min-w-0">
                              <p className="max-w-[410px] truncate text-sm font-medium text-zinc-950" title={item.title}>{item.title}</p>
                              <p className="mt-1 text-xs text-zinc-500">{item.contentType}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{item.plannedDate}</TableCell>
                        <TableCell><Badge variant="outline" className={stageClass[item.stage]}>{item.stage}</Badge></TableCell>
                        <TableCell><ComplianceBadge value={item.compliance} /></TableCell>
                        <TableCell className="whitespace-nowrap">{item.owner}</TableCell>
                        <TableCell className="whitespace-nowrap text-right text-xs tabular-nums text-zinc-500">{item.views.toLocaleString("zh-CN")} / {item.clicks.toLocaleString("zh-CN")} / {item.ordersCount.toLocaleString("zh-CN")}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" aria-label={`编辑 ${item.contentCode}`} onClick={() => openEditItem(item)}><Pencil aria-hidden="true" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="divide-y md:hidden">
                {visibleItems.map((item) => (
                  <article key={item.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-semibold text-violet-700" translate="no">{item.contentCode}</p>
                        <h3 className="mt-1 break-words text-sm font-semibold text-zinc-950">{item.title}</h3>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={`编辑 ${item.contentCode}`} onClick={() => openEditItem(item)}><Pencil aria-hidden="true" /></Button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <Badge variant="outline" className={stageClass[item.stage]}>{item.stage}</Badge>
                      <ComplianceBadge value={item.compliance} />
                      <span>{item.plannedDate}</span>
                      <span>{item.owner}</span>
                    </div>
                  </article>
                ))}
              </div>
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-zinc-500">
                  <span>第 {Math.min(page, pageCount)} / {pageCount} 页</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</Button>
                    <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      </div>

      <Dialog open={itemOpen} onOpenChange={(open) => !saving && setItemOpen(open)}>
        <DialogContent className="ops-workbench-theme max-h-[92vh] max-w-3xl overflow-y-auto overscroll-contain rounded-2xl bg-popover p-0 text-popover-foreground" aria-describedby={undefined}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            void saveItem(submitter?.dataset.action === "save-and-new");
          }}>
            <div className="border-b bg-popover px-6 py-5">
              <DialogHeader>
                <DialogTitle>{itemBase ? `编辑 ${itemBase.contentCode}` : "新增内容规划"}</DialogTitle>
                <DialogDescription>规划会保存到所选店铺和账号下，之后仍可随时修改。</DialogDescription>
              </DialogHeader>
            </div>
            <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
              <FormSelect label="所属账号" value={itemDraft.accountId} onValueChange={(value) => setItemDraft((current) => ({ ...current, accountId: value, contentCode: itemBase ? current.contentCode : nextCode(value) }))} options={workspace.accounts.map((account) => ({ value: account.id, label: `${account.prefix} · ${account.displayName} · ${account.handle}` }))} />
              <FormInput label="内容编号" name="contentCode" required value={itemDraft.contentCode} onChange={(value) => setItemDraft((current) => ({ ...current, contentCode: value.toUpperCase() }))} placeholder="例如 A06…" />
              <div className="sm:col-span-2"><FormInput label="内容选题" name="title" required value={itemDraft.title} onChange={(value) => setItemDraft((current) => ({ ...current, title: value }))} placeholder="一句话说清视频主题…" /></div>
              <FormSelect label="内容类型" value={itemDraft.contentType} onValueChange={(value) => setItemDraft((current) => ({ ...current, contentType: value }))} options={OPS_CONTENT_TYPES.map((value) => ({ value, label: value }))} />
              <FormInput label="计划发布日期" name="plannedDate" required type="date" value={itemDraft.plannedDate} onChange={(value) => setItemDraft((current) => ({ ...current, plannedDate: value }))} />
              <FormSelect label="制作状态" value={itemDraft.stage} onValueChange={(value) => setItemDraft((current) => ({ ...current, stage: value }))} options={OPS_STAGES.map((value) => ({ value, label: value }))} />
              <FormSelect label="合规状态" value={itemDraft.compliance} onValueChange={(value) => setItemDraft((current) => ({ ...current, compliance: value }))} options={OPS_COMPLIANCE_STATES.map((value) => ({ value, label: value }))} />
              <FormInput label="负责人" name="owner" required value={itemDraft.owner} onChange={(value) => setItemDraft((current) => ({ ...current, owner: value }))} placeholder="例如 Lina…" />
              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="item-hook">开头 Hook</Label>
                <Textarea id="item-hook" name="hook" autoComplete="off" value={itemDraft.hook} onChange={(event) => setItemDraft((current) => ({ ...current, hook: event.target.value }))} placeholder="填写口播开头或画面钩子…" />
              </div>
              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="item-cta">CTA</Label>
                <Textarea id="item-cta" name="cta" autoComplete="off" value={itemDraft.cta} onChange={(event) => setItemDraft((current) => ({ ...current, cta: event.target.value }))} placeholder="填写行动引导…" />
              </div>
              <div className="grid grid-cols-3 gap-3 sm:col-span-2">
                <NumberInput label="播放量" name="views" value={itemDraft.views} onChange={(value) => setItemDraft((current) => ({ ...current, views: value }))} />
                <NumberInput label="商品点击" name="clicks" value={itemDraft.clicks} onChange={(value) => setItemDraft((current) => ({ ...current, clicks: value }))} />
                <NumberInput label="订单数" name="ordersCount" value={itemDraft.ordersCount} onChange={(value) => setItemDraft((current) => ({ ...current, ordersCount: value }))} />
              </div>
              {itemConflict && (
                <div className="sm:col-span-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" aria-live="polite">
                  <p className="font-medium">同事刚修改了这条内容</p>
                  <p className="mt-1 text-xs leading-5">{itemConflict.error}</p>
                  {itemConflict.fields.length > 0 && <p className="mt-1 text-xs">重叠字段：{changedFieldLabels(itemConflict.fields)}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={loadCurrentItem}>采用同事版本</Button>
                    <Button type="button" size="sm" onClick={keepMyItemChanges}>保留我的改动</Button>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter className="border-t bg-muted/50 px-6 py-4">
              {itemBase && (
                <Button type="button" variant="destructive" className="sm:mr-auto" disabled={saving} onClick={() => {
                  setItemOpen(false);
                  setDeleteTarget({ entity: "item", id: itemBase.id, version: itemBase.version, label: itemBase.contentCode, detail: "删除后仍可由管理员在更改记录中查看原内容。" });
                }}><Trash2 aria-hidden="true" />删除</Button>
              )}
              <Button type="button" variant="outline" onClick={() => setItemOpen(false)} disabled={saving}>取消</Button>
              <Button type="submit" variant="outline" disabled={saving}>
                {saving && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {saving ? "保存中…" : "保存规划"}
              </Button>
              {!itemBase && (
                <Button type="submit" data-action="save-and-new" disabled={saving}>
                  <Plus aria-hidden="true" />{saving ? "保存中…" : "保存并新增"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(hierarchyEditor)} onOpenChange={(open) => !open && !saving && setHierarchyEditor(null)}>
        <DialogContent className="ops-workbench-theme max-h-[90vh] max-w-xl overflow-y-auto overscroll-contain rounded-2xl bg-popover p-0 text-popover-foreground" aria-describedby={undefined}>
          {hierarchyEditor && (
            <form onSubmit={(event) => { event.preventDefault(); void saveHierarchy(); }}>
              <div className="border-b bg-popover px-6 py-5">
                <DialogHeader>
                  <DialogTitle>{hierarchyEditor.entity === "store" ? (hierarchyEditor.base ? "编辑店铺" : "新增店铺") : (hierarchyEditor.base ? "编辑账号" : "新增账号")}</DialogTitle>
                </DialogHeader>
              </div>
              <div className="space-y-5 px-6 py-5">
                {hierarchyEditor.entity === "store" ? (
                  <FormInput label="店铺名称" name="storeName" required value={storeName} onChange={setStoreName} placeholder="例如 Storetwo Botanical Care…" />
                ) : (
                  <>
                    <FormSelect label="所属店铺" value={accountDraft.storeId} onValueChange={(value) => setAccountDraft((current) => ({ ...current, storeId: value }))} options={workspace.stores.map((store) => ({ value: store.id, label: store.name }))} />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormInput label="账号" name="handle" required value={accountDraft.handle} onChange={(value) => setAccountDraft((current) => ({ ...current, handle: value }))} placeholder="例如 @brandaccount…" />
                      <FormInput label="显示名称" name="displayName" required value={accountDraft.displayName} onChange={(value) => setAccountDraft((current) => ({ ...current, displayName: value }))} placeholder="账号显示名称…" />
                      <FormInput label="内容编号前缀" name="prefix" required value={accountDraft.prefix} onChange={(value) => setAccountDraft((current) => ({ ...current, prefix: value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} placeholder="例如 C…" />
                    </div>
                    <div className="space-y-2"><Label htmlFor="account-focus">内容方向</Label><Textarea id="account-focus" name="focus" autoComplete="off" value={accountDraft.focus} onChange={(event) => setAccountDraft((current) => ({ ...current, focus: event.target.value }))} placeholder="例如：成分教育 · FAQ · 使用方法…" /></div>
                    <div className="space-y-2"><Label htmlFor="account-tone">账号语气</Label><Textarea id="account-tone" name="tone" autoComplete="off" value={accountDraft.tone} onChange={(event) => setAccountDraft((current) => ({ ...current, tone: event.target.value }))} placeholder="例如：冷静可信、生活化…" /></div>
                  </>
                )}
                {hierarchyConflict && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" aria-live="polite">
                    <p className="font-medium">同事刚修改了这条记录</p>
                    <p className="mt-1 text-xs leading-5">{hierarchyConflict.error}</p>
                    <Button type="button" size="sm" className="mt-3" onClick={keepMyHierarchyChanges}>保留我的改动</Button>
                  </div>
                )}
              </div>
              <DialogFooter className="border-t bg-muted/50 px-6 py-4">
                {hierarchyEditor.base && (
                  <Button type="button" variant="destructive" className="sm:mr-auto" disabled={saving} onClick={() => {
                    const base = hierarchyEditor.base!;
                    setHierarchyEditor(null);
                    setDeleteTarget({
                      entity: hierarchyEditor.entity,
                      id: base.id,
                      version: base.version,
                      label: hierarchyEditor.entity === "store" ? (base as OpsStore).name : (base as OpsAccount).displayName,
                      detail: hierarchyEditor.entity === "store" ? "这个店铺下的账号和内容规划也会一起删除。" : "这个账号下的内容规划也会一起删除。",
                    });
                  }}><Trash2 aria-hidden="true" />删除</Button>
                )}
                <Button type="button" variant="outline" onClick={() => setHierarchyEditor(null)} disabled={saving}>取消</Button>
                <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? "保存中…" : "保存"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="ops-workbench-theme max-w-md rounded-2xl bg-popover text-popover-foreground">
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-red-50 text-red-600"><Trash2 aria-hidden="true" /></div>
            <DialogTitle>删除“{deleteTarget?.label}”？</DialogTitle>
            <DialogDescription>{deleteTarget?.detail}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>先不删除</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>{deleting && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{deleting ? "删除中…" : "确认删除"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OpsNativeSelect({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`} {...props}>{children}</select>;
}

function OpsStoreCard({ store, accountCount, active, expanded, contentCount, onClick, onEdit }: { store: OpsStore; accountCount: number; active: boolean; expanded: boolean; contentCount: number; onClick: () => void; onEdit: () => void }) {
  return (
    <div className={`flex min-h-[98px] min-w-[280px] max-w-[360px] flex-1 items-center gap-1 rounded-xl border p-2 transition-[transform,border-color,box-shadow,background-color] ${active ? "border-primary bg-primary text-primary-foreground shadow-[0_10px_26px_rgb(27_72_61/16%)]" : "bg-background hover:border-primary/40 hover:shadow-sm"}`}>
      <button type="button" aria-pressed={active} aria-expanded={active ? expanded : undefined} onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${active ? "bg-white/10" : "bg-secondary text-primary"}`}><Building2 className="h-5 w-5" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{store.name}</span><span className={`mt-1 block text-[11px] ${active ? "text-white/70" : "text-muted-foreground"}`}>{accountCount} 个账号 · 当前 {contentCount} 条内容</span></span>
      </button>
      <Button variant="ghost" size="icon" aria-label={`编辑店铺 ${store.name}`} className={`h-8 w-8 ${active ? "text-white hover:bg-white/10 hover:text-white" : ""}`} onClick={onEdit}><Pencil aria-hidden="true" /></Button>
      {active && <button type="button" aria-label={expanded ? "收起账号" : "展开账号"} onClick={onClick} className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">{expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}</button>}
    </div>
  );
}

function OpsAccountCard({ account, active, index, onClick, onEdit }: { account: OpsAccount; active: boolean; index: number; onClick: () => void; onEdit: () => void }) {
  const color = ["bg-teal-50 text-teal-700", "bg-orange-50 text-orange-700", "bg-blue-50 text-blue-700", "bg-violet-50 text-violet-700"][index % 4];
  return (
    <div className={`group flex min-h-[124px] min-w-[330px] flex-1 items-start gap-1 rounded-2xl border p-2 shadow-[0_8px_26px_rgb(39_45_42/4%)] transition-[transform,border-color,box-shadow,background-color] xl:max-w-[430px] ${active ? "border-primary bg-primary text-primary-foreground ring-2 ring-primary/15" : "bg-card hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_12px_30px_rgb(39_45_42/8%)]"}`}>
      <button type="button" aria-pressed={active} onClick={onClick} className="flex min-w-0 flex-1 items-center gap-4 rounded-xl p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl text-sm font-black ${active ? "bg-white/10 text-white" : color}`}>{account.prefix}</span>
        <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-bold">{account.displayName}</span>{active && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-bold">当前查看</span>}</span><span className={`mt-1 block truncate text-xs ${active ? "text-white/70" : "text-muted-foreground"}`}>{account.handle}</span><span className={`mt-3 block truncate text-[11px] ${active ? "text-white/80" : "text-muted-foreground"}`} title={account.focus || "暂未填写内容方向"}><strong className={active ? "text-white" : "text-foreground"}>内容方向：</strong>{account.focus || "暂未填写"}</span></span>
      </button>
      <Button variant="ghost" size="icon" aria-label={`编辑账号 ${account.handle}`} className={`mt-1 h-8 w-8 shrink-0 ${active ? "text-white hover:bg-white/10 hover:text-white" : ""}`} onClick={onEdit}><Pencil aria-hidden="true" /></Button>
    </div>
  );
}

interface OpsReferenceVideo {
  accountId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  streamUrl: string;
}

function OpsReferenceVideoPanel({ account, revision }: { account: OpsAccount; revision: number }) {
  const [expanded, setExpanded] = useState(false);
  const [video, setVideo] = useState<OpsReferenceVideo | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpanded(false);
    setVideo(null);
    setError("");
  }, [account.id]);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch(`/api/forms/reference-video?accountId=${encodeURIComponent(account.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { video?: OpsReferenceVideo | null; error?: string };
        if (!response.ok) throw new Error(payload.error || "读取参考视频失败。");
        setVideo(payload.video || null);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "读取参考视频失败。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [account.id, expanded, revision]);

  const upload = async (file: File) => {
    if (!file.size || file.size > 100 * 1024 * 1024) {
      setError("单个参考视频不能超过 100MB。");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const params = new URLSearchParams({ accountId: account.id, filename: file.name, size: String(file.size) });
      const response = await fetch(`/api/forms/reference-video?${params.toString()}`, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const payload = await response.json() as { video?: OpsReferenceVideo | null; error?: string };
      if (!response.ok) throw new Error(payload.error || "上传参考视频失败。");
      setVideo(payload.video || null);
      toast.success(`${account.handle} 的参考视频已上传`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传参考视频失败。");
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`确定移除 ${account.handle} 的参考视频吗？`)) return;
    setUploading(true);
    setError("");
    try {
      const response = await fetch(`/api/forms/reference-video?accountId=${encodeURIComponent(account.id)}`, { method: "DELETE" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "移除参考视频失败。");
      setVideo(null);
      toast.success(`${account.handle} 的参考视频已移除`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除参考视频失败。");
    } finally {
      setUploading(false);
    }
  };

  const status = uploading ? "上传中" : loading ? "读取中" : video ? "已添加" : "待添加";
  return (
    <div className="mt-3 overflow-hidden rounded-xl border bg-muted/25">
      <button type="button" className="flex w-full items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-primary"><Video className="h-4 w-4" aria-hidden="true" /></span><span className="min-w-0"><span className="block text-xs font-bold">账号参考视频案例</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{account.handle} · 每个账号独立上传和保存自己的参考案例</span></span></span>
        <span className="flex shrink-0 items-center gap-2"><Badge variant="outline" className={`bg-card text-[10px] ${video ? "border-emerald-200 text-emerald-700" : "text-muted-foreground"}`}>{status}</Badge>{expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}</span>
      </button>
      {expanded && <div className="border-t p-3">
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v" className="sr-only" aria-label={`为 ${account.handle} 选择参考视频`} disabled={uploading} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} />
        {loading ? <div className="grid aspect-video w-full max-w-[640px] place-items-center rounded-xl border bg-card/80 text-sm text-muted-foreground"><span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取参考视频…</span></div> : video ? <div className="max-w-[720px]"><div className="relative overflow-hidden rounded-xl border bg-black"><video key={video.streamUrl} src={video.streamUrl} controls playsInline preload="metadata" className="aspect-video w-full object-contain"><track kind="captions" src="data:text/vtt;charset=utf-8,WEBVTT%0A%0A" srcLang="en" label="无字幕" default /></video>{uploading && <div className="absolute inset-0 grid place-items-center bg-black/55 text-sm font-semibold text-white"><span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在上传新视频…</span></div>}</div><div className="mt-3 flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-sm font-semibold">{video.filename}</p><p className="mt-1 text-[11px] text-muted-foreground">{formatBytes(video.sizeBytes)} · 更新于 {formatStoredTime(video.updatedAt)}</p></div><div className="flex shrink-0 flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}><RefreshCw aria-hidden="true" />替换视频</Button><Button type="button" size="sm" variant="destructive" disabled={uploading} onClick={() => void remove()}><Trash2 aria-hidden="true" />移除</Button></div></div></div> : <div className="grid aspect-video w-full max-w-[640px] place-items-center rounded-xl border border-dashed bg-card/80 px-5 text-center"><div><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-secondary text-primary"><Video className="h-5 w-5" aria-hidden="true" /></span><p className="mt-3 text-sm font-bold">直接上传账号参考视频</p><p className="mt-1 text-xs leading-5 text-muted-foreground">支持 MP4、MOV、WebM、M4V，单个不超过 100MB。上传后可在线播放，也可以随时替换或移除。</p><Button type="button" className="mt-4" disabled={uploading} onClick={() => inputRef.current?.click()}>{uploading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Plus aria-hidden="true" />}{uploading ? "正在上传…" : "选择视频并上传"}</Button></div></div>}
        {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/25 bg-red-50 px-3 py-2 text-xs text-destructive">{error}</p>}
      </div>}
    </div>
  );
}

function OpsSidebarAccount({ account, active, onClick }: { account: OpsAccount; active: boolean; onClick: () => void }) {
  return <Button className="h-auto w-full justify-start py-2" variant={active ? "default" : "ghost"} size="lg" onClick={onClick}><span className={`ops-channel-dot ${active ? "bg-white/10 text-white" : "ops-channel-a"}`}>{account.prefix}</span><span className="min-w-0 text-left"><span className="block max-w-[135px] truncate text-xs">{account.displayName}</span><span className={`block max-w-[135px] truncate text-[10px] ${active ? "text-white/65" : "text-muted-foreground"}`}>{account.handle}</span></span></Button>;
}

function OpsMetricCard({ label, value, unit, note, icon, tone }: { label: string; value: string; unit: string; note: string; icon: ReactNode; tone: "ink" | "amber" | "rose" | "green" }) {
  return <Card className="min-h-0 border-0 py-3 shadow-[0_8px_24px_rgb(39_45_42/5%)] ring-1 ring-border"><CardContent className="flex min-h-[94px] items-center justify-between gap-2 px-3 py-0 sm:px-4"><div className="min-w-0"><p className="truncate text-[11px] font-medium text-muted-foreground sm:text-xs">{label}</p><p className="mt-1 flex items-baseline gap-1"><span className="text-2xl font-bold tracking-[-0.04em] tabular-nums sm:text-3xl">{value}</span><span className="text-[11px] text-muted-foreground sm:text-xs">{unit}</span></p><p className="mt-1 truncate text-[10px] text-muted-foreground sm:text-[11px]">{note}</p></div><div className={`ops-metric-icon ops-metric-${tone} shrink-0`}>{icon}</div></CardContent></Card>;
}

function OpsTimeScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" className={`rounded-md px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`} onClick={onClick} aria-pressed={active}>{label}</button>;
}

function OpsFilterPill({ label, active = false, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return <button type="button" className={`ops-filter-pill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "is-active" : ""}`} onClick={onClick}>{label}</button>;
}

function OpsViewModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" className={`rounded-md px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`} aria-pressed={active} onClick={onClick}>{label}</button>;
}

function OpsHorizontalTreeCanvas({ store, account, items, loading, onEdit, onAdd, onAddAccount, onClear }: { store: OpsStore | null; account: OpsAccount | null; items: OpsContentItem[]; loading: boolean; onEdit: (item: OpsContentItem) => void; onAdd: () => void; onAddAccount: () => void; onClear: () => void }) {
  const ownerGroups = useMemo(() => {
    const grouped = new Map<string, OpsContentItem[]>();
    for (const item of items) {
      const owner = item.owner.trim() || "未分配";
      grouped.set(owner, [...(grouped.get(owner) || []), item]);
    }
    return Array.from(grouped, ([owner, ownerItems]) => ({ owner, items: ownerItems })).sort((left, right) => left.owner.localeCompare(right.owner, "zh-CN"));
  }, [items]);
  const storeKey = `store:${store?.id || "none"}`;
  const accountKey = `account:${account?.id || "none"}`;
  const ownerKeys = ownerGroups.map((group) => `${accountKey}:owner:${group.owner}`);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set());
  const [canvasView, setCanvasView] = useState({ x: 24, y: 24, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(canvasView);
  const canvasHoveredRef = useRef(false);
  const controlPressedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") controlPressedRef.current = true;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") controlPressedRef.current = false;
    };
    const resetControlState = () => {
      controlPressedRef.current = false;
    };
    const handleWheel = (event: WheelEvent) => {
      const rect = viewport.getBoundingClientRect();
      const pointerInside = event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom;
      if ((!pointerInside && !canvasHoveredRef.current) || (!event.ctrlKey && !controlPressedRef.current)) return;
      const deltaPixels = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
      if (!deltaPixels) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const current = viewRef.current;
      const zoomAmount = Math.min(0.18, Math.max(0.025, Math.abs(deltaPixels) * 0.0018));
      const zoomFactor = deltaPixels < 0 ? 1 + zoomAmount : 1 / (1 + zoomAmount);
      const nextScale = Math.min(2, Math.max(0.45, current.scale * zoomFactor));
      const contentX = (pointerX - current.x) / current.scale;
      const contentY = (pointerY - current.y) / current.scale;
      const next = {
        x: pointerX - contentX * nextScale,
        y: pointerY - contentY * nextScale,
        scale: nextScale,
      };
      viewRef.current = next;
      setCanvasView(next);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", resetControlState);
    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", resetControlState);
      window.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, []);

  const applyView = (next: { x: number; y: number; scale: number }) => {
    viewRef.current = next;
    setCanvasView(next);
  };
  const zoom = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = viewRef.current;
    const nextScale = Math.min(2, Math.max(0.45, current.scale * factor));
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    const contentX = (centerX - current.x) / current.scale;
    const contentY = (centerY - current.y) / current.scale;
    applyView({ x: centerX - contentX * nextScale, y: centerY - contentY * nextScale, scale: nextScale });
  };
  const toggle = (key: string) => setCollapsedNodes((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, textarea")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = viewRef.current;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: current.x, viewY: current.y };
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; applyView({ ...viewRef.current, x: drag.viewX + event.clientX - drag.startX, y: drag.viewY + event.clientY - drag.startY }); };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); dragRef.current = null; setDragging(false); };

  if (loading) return <div className="grid h-48 place-items-center text-sm text-muted-foreground"><span><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在载入运营树…</span></div>;
  if (!store || !account) return <div className="grid h-48 place-items-center text-sm text-muted-foreground"><span>这个店铺还没有账号。<Button variant="link" onClick={onAddAccount}>添加账号</Button></span></div>;
  const storeCollapsed = collapsedNodes.has(storeKey);
  const accountCollapsed = collapsedNodes.has(accountKey);

  return (
    <section aria-label="可收缩横向运营树">
      <div className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold">横向树状画布</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">拖动空白处平移 · 鼠标移入画布后按 Ctrl + 滚轮缩放 · 点击节点收缩或展开</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg bg-muted p-1" aria-label="画布缩放控制">
            <Button size="icon" className="h-8 w-8" variant="ghost" aria-label="缩小画布" onClick={() => zoom(0.85)}>−</Button>
            <span className="w-12 text-center text-[11px] font-bold tabular-nums text-muted-foreground">{Math.round(canvasView.scale * 100)}%</span>
            <Button size="icon" className="h-8 w-8" variant="ghost" aria-label="放大画布" onClick={() => zoom(1.18)}>＋</Button>
            <Button size="sm" variant="ghost" onClick={() => applyView({ x: 24, y: 24, scale: 1 })}>复位</Button>
          </div>
          <Button size="sm" variant="outline" onClick={() => setCollapsedNodes(new Set())}>全部展开</Button>
          <Button size="sm" variant="outline" onClick={() => setCollapsedNodes(new Set([storeKey, accountKey, ...ownerKeys]))}>全部收起</Button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className={`relative -mx-1 mt-3 h-[560px] select-none overflow-hidden rounded-xl border bg-muted/20 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ touchAction: "none", backgroundImage: "radial-gradient(circle, rgba(27,72,61,0.14) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={() => { canvasHoveredRef.current = true; }}
        onPointerLeave={() => { canvasHoveredRef.current = false; }}
        onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
        aria-label="可拖动和缩放的横向树状画布"
      >
        <div className="absolute left-0 top-0 will-change-transform" style={{ transform: `translate3d(${canvasView.x}px, ${canvasView.y}px, 0) scale(${canvasView.scale})`, transformOrigin: "0 0" }}>
          <div className="inline-flex min-h-[430px] min-w-[1160px] items-center p-5">
            <OpsTreeNode
              title={store.name}
              subtitle={`${items.length} 条当前规划`}
              marker={<Building2 className="h-5 w-5" />}
              tone="store"
              collapsed={storeCollapsed}
              onToggle={() => toggle(storeKey)}
              className="w-[220px]"
            />
            {!storeCollapsed && (
              <>
                <OpsTreeConnector />
                <OpsTreeNode
                  title={`${account.prefix} · ${account.displayName}`}
                  subtitle={`${account.handle} · ${items.length} 条规划`}
                  marker={<span className="text-sm font-black">{account.prefix}</span>}
                  tone="account"
                  collapsed={accountCollapsed}
                  onToggle={() => toggle(accountKey)}
                  className="w-[240px]"
                />
                {!accountCollapsed && (
                  <>
                    <OpsTreeConnector />
                    <div className="relative border-l border-border py-2">
                      {ownerGroups.map((group) => {
                        const ownerKey = `${accountKey}:owner:${group.owner}`;
                        const ownerCollapsed = collapsedNodes.has(ownerKey);
                        return (
                          <div key={group.owner} className="relative flex items-center py-3 pl-8 before:absolute before:left-0 before:top-1/2 before:h-px before:w-8 before:bg-border before:content-['']">
                            <OpsTreeNode
                              title={group.owner}
                              subtitle={`${group.items.length} 条规划`}
                              marker={<span className="text-sm font-black">{group.owner.slice(0, 1).toUpperCase()}</span>}
                              tone="owner"
                              collapsed={ownerCollapsed}
                              onToggle={() => toggle(ownerKey)}
                              className="w-[180px]"
                            />
                            {!ownerCollapsed && (
                              <>
                                <OpsTreeConnector />
                                <div className="grid w-[520px] grid-cols-2 gap-2">
                                  {group.items.map((item) => <OpsTreePlanCard key={item.id} item={item} onEdit={() => onEdit(item)} />)}
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                      {!ownerGroups.length && (
                        <div className="relative flex items-center py-3 pl-8 before:absolute before:left-0 before:top-1/2 before:h-px before:w-8 before:bg-border before:content-['']">
                          <div className="flex w-[520px] items-center justify-between gap-3 rounded-xl border border-dashed bg-muted/30 p-4 text-xs text-muted-foreground">
                            <span>当前筛选范围内暂无负责人或规划。</span>
                            <div className="flex shrink-0 gap-1">
                              <Button size="sm" variant="ghost" onClick={onClear}>清除筛选</Button>
                              <Button size="sm" onClick={onAdd}><Plus aria-hidden="true" />新增规划</Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function OpsTreeNode({ title, subtitle, marker, tone, collapsed, onToggle, className }: { title: string; subtitle: string; marker: ReactNode; tone: "store" | "account" | "owner"; collapsed: boolean; onToggle: () => void; className: string }) {
  const toneClass = tone === "store" ? "border-primary bg-primary text-primary-foreground shadow-[0_10px_24px_rgb(27_72_61/16%)]" : tone === "account" ? "border-primary/25 bg-card text-card-foreground shadow-[0_8px_22px_rgb(39_45_42/7%)]" : "border-border bg-secondary/65 text-secondary-foreground";
  const markerClass = tone === "store" ? "bg-white/10 text-white" : tone === "account" ? "bg-secondary text-primary" : "bg-card text-primary ring-1 ring-border";
  return <button type="button" className={`flex min-h-[82px] shrink-0 items-center gap-3 rounded-xl border p-3 text-left transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${toneClass} ${className}`} aria-expanded={!collapsed} onClick={onToggle}><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${markerClass}`}>{marker}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{title}</span><span className={`mt-1 block truncate text-[11px] ${tone === "store" ? "text-white/70" : "text-muted-foreground"}`}>{subtitle}</span></span><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${tone === "store" ? "bg-white/10" : "bg-muted"}`}>{collapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}</span></button>;
}

function OpsTreeConnector() { return <span aria-hidden="true" className="h-px w-8 shrink-0 bg-border" />; }

function OpsTreePlanCard({ item, onEdit }: { item: OpsContentItem; onEdit: () => void }) {
  return <button type="button" className="w-[254px] rounded-xl border bg-card p-3 text-left shadow-[0_5px_16px_rgb(39_45_42/5%)] transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_9px_22px_rgb(39_45_42/9%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" onClick={onEdit} aria-label={`编辑规划 ${item.contentCode}，${item.title}`}><div className="flex items-start justify-between gap-2"><span className="font-mono text-[11px] font-bold text-primary">{item.contentCode}</span><span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatDate(item.plannedDate)}</span></div><p className="mt-2 line-clamp-2 text-sm font-semibold leading-5">{item.title}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{item.contentType}</p><div className="mt-3 flex items-center justify-between gap-2 border-t pt-2.5"><Badge variant="outline" className={stageClass[item.stage] || stageClass["选题池"]}>{item.stage}</Badge><OpsComplianceState value={item.compliance} /></div></button>;
}

function OpsComplianceState({ value }: { value: string }) {
  const style = value === "已通过" ? "text-emerald-700" : value === "待复核" ? "text-amber-700" : "text-muted-foreground";
  const dot = value === "已通过" ? "bg-emerald-500" : value === "待复核" ? "bg-amber-500" : "bg-stone-300";
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style}`}><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{value}</span>;
}

function OpsCheckItem({ text, done = false }: { text: string; done?: boolean }) {
  return <div className="flex items-center gap-2"><span className={`grid h-4 w-4 place-items-center rounded-full border ${done ? "border-emerald-300 bg-emerald-300 text-emerald-950" : "border-white/30"}`}>{done && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}</span><span className={done ? "text-white/85" : "text-white/60"}>{text}</span></div>;
}

function OpsChannelProgress({ label, subtitle, value }: { label: string; subtitle: string; value: number }) {
  return <div><div className="mb-2 flex items-end justify-between"><div><p className="text-xs font-bold">{label}</p><p className="text-[11px] text-muted-foreground">{subtitle}</p></div><span className="text-xs font-bold tabular-nums">{value}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-teal-600" style={{ width: `${value}%` }} /></div></div>;
}

function formatBytes(bytes: number): string { if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`; if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`; return `${bytes} B`; }
function formatStoredTime(value: string): string { return value.replace("T", " ").slice(0, 16); }

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: "zinc" | "violet" | "amber" | "emerald" }) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-700",
    violet: "bg-violet-50 text-violet-700",
    amber: "bg-amber-50 text-amber-700",
    emerald: "bg-emerald-50 text-emerald-700",
  };
  return (
    <article className="rounded-2xl border bg-white p-4 shadow-sm sm:p-5">
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl [&_svg]:h-4 [&_svg]:w-4 ${tones[tone]}`} aria-hidden="true">{icon}</div>
      <p className="mt-4 text-2xl font-semibold tabular-nums text-zinc-950">{value.toLocaleString("zh-CN")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{label}</p>
    </article>
  );
}

function ComplianceBadge({ value }: { value: string }) {
  if (value === "已通过") return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />已通过</span>;
  if (value === "待复核") return <span className="text-xs font-medium text-amber-700">待复核</span>;
  return <span className="text-xs text-zinc-500">未检查</span>;
}

function FilterSelect({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="min-w-36" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function FormSelect({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label={label}><SelectValue placeholder={`选择${label}…`} /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

function FormInput({ label, name, value, onChange, placeholder, type = "text", required = false }: { label: string; name: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; required?: boolean }) {
  const id = `ops-${name}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} autoComplete="off" type={type} required={required} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function NumberInput({ label, name, value, onChange }: { label: string; name: string; value: number; onChange: (value: number) => void }) {
  const id = `ops-${name}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="number" inputMode="numeric" min={0} value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} />
    </div>
  );
}

function EmptyState({ icon, title, action, onAction, disabled = false }: { icon: React.ReactNode; title: string; action: string; onAction: () => void; disabled?: boolean }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
      <div className="text-zinc-300 [&_svg]:h-8 [&_svg]:w-8" aria-hidden="true">{icon}</div>
      <p className="mt-3 text-sm font-medium text-zinc-800">{title}</p>
      <Button className="mt-4" size="sm" variant="outline" onClick={onAction} disabled={disabled}>{action}</Button>
    </div>
  );
}
