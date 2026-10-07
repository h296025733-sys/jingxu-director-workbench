import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism, cpus, freemem, setPriority } from "node:os";
import { concurrencyConfig } from "./concurrency-config";

export interface MediaResources { freeBytes: number; parallelism: number; cpuPercent: number | null }
const GiB = 1024 ** 3;
/** Conservative admission policy, not a promise about future RAM/CPU usage. */
export function mediaParallelism(sample: MediaResources, maximum = 2): number {
  if (!Number.isFinite(sample.freeBytes) || sample.freeBytes < 2 * GiB) return 0;
  if (maximum < 2 || sample.freeBytes < 8 * GiB || sample.parallelism < 12 || sample.cpuPercent === null || sample.cpuPercent >= 70) return 1;
  return 2;
}

function resourceSampler(): () => MediaResources {
  let previous: { idle: number; total: number; at: number } | null = null;
  let cpuPercent: number | null = null;
  return () => {
    const now = Date.now();
    if (!previous || now - previous.at >= 1000) {
      const times = cpus().reduce((sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }), { idle: 0, total: 0 });
      if (previous && times.total > previous.total) {
        cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (times.idle - previous.idle) / (times.total - previous.total))));
      }
      previous = { ...times, at: now };
    }
    return { freeBytes: freemem(), parallelism: availableParallelism(), cpuPercent };
  };
}

interface Waiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  aborted: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createMediaGate(sample: () => MediaResources, maximum = 2) {
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue: Waiter[] = [];
  function remove(waiter: Waiter) {
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.aborted);
  }
  function pump() {
    if (timer) clearTimeout(timer);
    timer = null;
    const limit = mediaParallelism(sample(), maximum);
    while (active < limit && queue.length) {
      const waiter = queue[0]; remove(waiter);
      if (waiter.signal?.aborted) { waiter.reject(new Error("本地处理排队已取消")); continue; }
      active++;
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; active--; pump(); });
    }
    if (queue.length) timer = setTimeout(pump, 1000);
  }
  return {
    acquire(signal?: AbortSignal, onWait?: () => void): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(new Error("本地处理排队已取消"));
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { signal, resolve, reject, aborted: () => {
          remove(waiter); reject(new Error("本地处理排队已取消")); pump();
        }, timer: setTimeout(() => {
          remove(waiter); reject(new Error("本机可用资源长时间不足，请关闭占用较大的程序后重试；素材已保留")); pump();
        }, 30 * 60_000) };
        signal?.addEventListener("abort", waiter.aborted, { once: true });
        queue.push(waiter); pump();
        if (queue.includes(waiter)) { try { onWait?.(); } catch { /* Progress callbacks must not leak a queued permit. */ } }
      });
    },
    refresh: pump,
    snapshot() { const resources = sample(); return { maximum, effectiveLimit: mediaParallelism(resources, maximum), active, waiting: queue.length, freeGiB: Math.round(resources.freeBytes / GiB * 10) / 10, cpuPercent: resources.cpuPercent === null ? null : Math.round(resources.cpuPercent) }; },
  };
}

const holder = globalThis as typeof globalThis & {
  __jingxuMediaGate?: ReturnType<typeof createMediaGate>;
  __jingxuMediaFeedback?: AsyncLocalStorage<(message: string) => void>;
};
const gate = holder.__jingxuMediaGate ??= createMediaGate(resourceSampler(), concurrencyConfig().localMedia);
const feedback = holder.__jingxuMediaFeedback ??= new AsyncLocalStorage<(message: string) => void>();
export const localMediaCapacitySnapshot = () => gate.snapshot();
export function withMediaFeedback<T>(notify: (message: string) => void, run: () => Promise<T>): Promise<T> {
  return feedback.run(notify, run);
}
export async function withLocalMediaSlot<T>(signal: AbortSignal | undefined, run: () => Promise<T>, stage = "本地视频处理"): Promise<T> {
  let waited = false;
  const release = await gate.acquire(signal, () => { waited = true; feedback.getStore()?.(`本机资源繁忙，排队等待${stage}`); });
  try {
    signal?.throwIfAborted();
    if (waited) feedback.getStore()?.(`正在${stage}`);
    return await run();
  } finally { release(); }
}
export function lowerMediaPriority(pid: number | undefined): void {
  if (!pid) return;
  try { setPriority(pid, 10); } catch { /* Best effort; resource admission is independent. */ }
}
