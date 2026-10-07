/** Recover technical faults without treating refusals, lost auth or quota as outages. */
export function isTransientGenerationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/(?:usage limit|insufficient[_ ]quota|quota.{0,30}(?:exceed|exhaust)|额度|billing|payment required|unauthori[sz]ed|authentication|token.{0,16}expired|login required|\b40[13]\b|content[_ -]?filter|content policy|safety policy|moderation|refus(?:ed|al)|policy violation|不允许生成|违规|拒绝生成|图像服务拒绝|isolation contract violation|unapproved|escaped.{0,20}root|did not close safely|cleanup failed|清理失败|cancel(?:ed|led)|已取消)/iu.test(message)) {
    return false;
  }
  return /(?:IMAGE_NOT_PRODUCED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|network (?:error|unavailable)|connection (?:reset|closed|lost)|stream.{0,35}(?:disconnect|interrupt|closed|ended)|unexpected EOF|premature close|socket hang up|temporarily unavailable|(?:selected )?model is at capacity|server.{0,20}(?:overload|error)|service unavailable|bad gateway|gateway timeout|\b50[0234]\b|\b429\b|rate.?limit|too many requests|网络.*(?:中断|断开|不可用)|连接.*(?:断开|重置)|请求超时)/iu.test(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Generation canceled");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Generation canceled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withTransientGenerationRetry<T>(
  execute: (attempt: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    maxAttempts?: number;
    delayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.min(3, Math.max(1, options.maxAttempts ?? 3));
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await execute(attempt);
    } catch (error) {
      throwIfAborted(options.signal);
      if (attempt >= maxAttempts || !isTransientGenerationError(error)) throw error;
      options.onRetry?.(attempt + 1, error);
      await abortableDelay((options.delayMs ?? 1500) * attempt * attempt, options.signal);
    }
  }
}

/** Pure orchestration; every recovered draft must pass the same validator. */
export async function recoverGeneratedOutput<T>(options: {
  initial: unknown;
  validate: (candidate: unknown) => T;
  issuesFromError: (error: unknown) => string[] | null;
  repairDeterministically: (candidate: unknown, issues: string[]) => unknown;
  repair: (candidate: unknown, issues: string[], attempt: number) => Promise<unknown>;
  checkpoint?: (candidate: unknown, issues: string[]) => void;
  fallback?: (candidate: unknown, issues: string[]) => T | undefined;
  maxRepairs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  let candidate = options.initial;
  const maxRepairs = Math.min(4, Math.max(0, options.maxRepairs ?? 4));
  for (let attempt = 0; ; attempt += 1) {
    let issues: string[] = [];
    let lastError: unknown;
    // Validators can reveal the next fault after a lossless metadata correction.
    // Finish these local repairs before asking the model to rewrite anything.
    for (let localPass = 0; localPass <= 8; localPass += 1) {
      throwIfAborted(options.signal);
      try {
        return options.validate(candidate);
      } catch (error) {
        const found = options.issuesFromError(error);
        if (!found?.length) throw error;
        issues = found;
        lastError = error;
      }
      if (localPass === 8) break;
      const repaired = options.repairDeterministically(candidate, issues);
      if (repaired === candidate || JSON.stringify(repaired) === JSON.stringify(candidate)) break;
      candidate = repaired;
    }
    options.checkpoint?.(candidate, issues);
    if (attempt >= maxRepairs) {
      const fallback = options.fallback?.(candidate, issues);
      if (fallback !== undefined) return fallback;
      throw lastError;
    }
    candidate = await options.repair(candidate, issues, attempt + 1);
  }
}
