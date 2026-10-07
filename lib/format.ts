export const TASK_STATUS_META: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; pulse?: boolean }
> = {
  pending: { label: "排队中", variant: "secondary" },
  running: { label: "执行中", variant: "default", pulse: true },
  awaiting_confirmation: { label: "等你确认", variant: "secondary" },
  succeeded: { label: "成功", variant: "outline" },
  failed: { label: "失败", variant: "destructive" },
  canceled: { label: "已取消", variant: "secondary" },
};

export function taskStatusMeta(task: {status:string; featureId?:string; message?:string|null; narrationStatus?:string}) {
  if (task.status === "succeeded" && task.featureId === "watermark_removal") {
    if (/待完善|未处理|未完成|未能安全/u.test(task.message ?? "")) return {label:"去水印待完善",variant:"secondary" as const,pulse:false};
    if (/未发现|没有发现/u.test(task.message ?? "")) return {label:"未检出水印",variant:"secondary" as const,pulse:false};
    return {label:"已处理，请核对",variant:"outline" as const,pulse:false};
  }
  if (task.status === "succeeded" && task.featureId === "auto_edit" && task.narrationStatus) {
    if (task.narrationStatus === "partial") return {label:"配音待完善",variant:"secondary" as const,pulse:false};
    if (task.narrationStatus === "incomplete") return {label:"配音待完成",variant:"secondary" as const,pulse:false};
    if (task.narrationStatus === "delivered") return TASK_STATUS_META.succeeded;
  }
  if (task.status === "succeeded" && task.featureId === "auto_edit" &&
      /配音.*未完成|不含.*画外解说|解说未通过|未形成可安全配入/u.test(task.message ?? "")) {
    return {label:"配音待完成",variant:"secondary" as const,pulse:false};
  }
  return TASK_STATUS_META[task.status] ?? {label:task.status,variant:"outline" as const,pulse:false};
}

export const FEATURE_STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
  ready: {
    label: "已可用",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  developing: {
    label: "开发中",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
};

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    dateTimeFormatter
      .formatToParts(d)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1).toUpperCase();
}
