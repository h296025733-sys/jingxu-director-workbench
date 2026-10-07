function requestSignal(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs = 20_000,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  const timer = window.setTimeout(
    () => controller.abort(new DOMException("请求超时", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function apiGet<T>(url: string, init?: RequestInit): Promise<T> {
  const scope = requestSignal(init?.signal);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: scope.signal });
  } catch (error) {
    if (scope.signal.reason instanceof DOMException && scope.signal.reason.name === "TimeoutError") {
      throw new Error("网络响应较慢，请稍后重试");
    }
    throw error;
  } finally {
    scope.cleanup();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || "请求失败");
  }
  return data as T;
}

export async function apiSend<T>(
  url: string,
  method: "POST" | "PUT" | "DELETE" | "PATCH" = "POST",
  body?: unknown,
): Promise<T> {
  const scope = requestSignal(undefined, 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: scope.signal,
    });
  } catch (error) {
    if (
      scope.signal.reason instanceof DOMException &&
      scope.signal.reason.name === "TimeoutError"
    ) {
      throw new Error("网络响应较慢，请稍后重试");
    }
    throw error;
  } finally {
    scope.cleanup();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || "请求失败");
  }
  return data as T;
}
