import { concurrencyConfig } from "./concurrency-config";

interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}
interface CapacityRuntime { active: number; limit: number; waiting: Waiter[] }
const holder = globalThis as typeof globalThis & { __jingxuCodexCapacity?: CapacityRuntime };
// Next route chunks can instantiate a module more than once. All features must share one gate.
const state = holder.__jingxuCodexCapacity ??= {
  active: 0, limit: concurrencyConfig().total, waiting: [],
};
function pump(): void {
  while (state.active < state.limit && state.waiting.length) {
    const waiter = state.waiting.shift()!;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal.aborted) { waiter.reject(new Error("Codex execution was canceled while queued")); continue; }
    state.active += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      state.active -= 1;
      pump();
    });
  }
}
/** Acquire inside an employee-owned work item; release in finally, including subprocess failure. */
export function acquireCodexExecutionSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error("Codex execution was canceled before queueing"));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, onAbort: () => {
      const index = state.waiting.indexOf(waiter);
      if (index >= 0) state.waiting.splice(index, 1);
      reject(new Error("Codex execution was canceled while queued"));
    } };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    state.waiting.push(waiter);
    pump();
  });
}
export function codexCapacitySnapshot() {
  return { limit: state.limit, active: state.active, waiting: state.waiting.length };
}
