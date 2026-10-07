/**
 * 极简内存登录防爆破：同一用户名+IP 连续失败 5 次锁定 10 分钟。
 * 进程重启后计数清零（内网工具可接受；如需持久化可改存数据库）。
 */
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const TRUST_PROXY_HEADERS = process.env.DW_TRUST_PROXY_HEADERS === "1";

interface Entry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

const attempts = new Map<string, Entry>();

export function getClientIp(req: Request): string {
  if (!TRUST_PROXY_HEADERS) return "direct";
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0].trim();
  const candidate = forwarded || req.headers.get("x-real-ip")?.trim() || "proxy";
  return /^[0-9a-f:.]{2,64}$/i.test(candidate) ? candidate : "proxy";
}

function pruneAttempts(now: number): void {
  for (const [key, entry] of attempts) {
    if (entry.lockedUntil <= now && now - entry.lastSeen > ENTRY_TTL_MS) {
      attempts.delete(key);
    }
  }
  while (attempts.size >= MAX_ENTRIES) {
    const oldestKey = attempts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    attempts.delete(oldestKey);
  }
}

export function getLoginLockRemaining(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  pruneAttempts(now);
  const entry = attempts.get(key) ?? {
    failures: 0,
    lockedUntil: 0,
    lastSeen: now,
  };
  entry.failures += 1;
  entry.lastSeen = now;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.failures = 0;
  }
  attempts.delete(key);
  attempts.set(key, entry);
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}
