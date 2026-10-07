function bounded(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isSafeInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

/** Admission, cloud execution and local processing are separate budgets. */
export function concurrencyConfig(env = process.env) {
  const total = bounded(env.DW_CODEX_CONCURRENCY, 8, 8);
  return {
    total,
    editing: Math.min(total, bounded(env.DW_EDITING_CONCURRENCY, 3, 3)),
    localMedia: bounded(env.DW_LOCAL_MEDIA_CONCURRENCY, 2, 2),
  };
}

// These are waiting + running requests, not extra processes. Keep owner caps unchanged.
export const MAX_PENDING_WORK_GLOBAL = 32;
