import { concurrencyConfig } from "./concurrency-config";

export type WorkKind =
  | "understanding"
  | "director"
  | "delivery_conversion"
  | "prompt_translation"
  | "image"
  | "reference_video"
  | "voice"
  | "editing";
// Voice synthesis will use the same employee-owned queue, not its own unbounded pool.

interface WorkItem {
  id: string;
  owner: string;
  kind: WorkKind;
  priority: number;
  sequence: number;
  enqueuedAt: number;
  run: () => Promise<void>;
  cancel?: () => void;
  isStillValid?: () => boolean;
  onRemoved?: () => void;
}

interface SchedulerRuntime {
  queue: WorkItem[];
  active: Map<string, WorkItem>;
  activeOwners: Set<string>;
  ownerLastDispatch: Map<string, number>;
  ownerLastKind: Map<string, WorkKind>;
  nextSequence: number;
  dispatchSequence: number;
  pumping: boolean;
}

const configuration = concurrencyConfig();
const TOTAL_CONCURRENCY = configuration.total;
const REFERENCE_VIDEO_CONCURRENCY = Math.min(2, TOTAL_CONCURRENCY);
/**
 * Local editing performs transcription, FFmpeg rendering and full-decode QA.
 * Multiple editing pipelines can wait for AI concurrently. Their local subprocess
 * stages separately share the adaptive media gate with director video analysis.
 */
const EDITING_CONCURRENCY = configuration.editing;
const VOICE_CONCURRENCY = 1;
const AGING_INTERVAL_MS = 5 * 60 * 1000;

const holder = globalThis as typeof globalThis & {
  __directorWorkSchedulerRuntime?: SchedulerRuntime;
};
const runtime: SchedulerRuntime =
  holder.__directorWorkSchedulerRuntime ??
  (holder.__directorWorkSchedulerRuntime = {
    queue: [] as WorkItem[],
    active: new Map<string, WorkItem>(),
    activeOwners: new Set<string>(),
    ownerLastDispatch: new Map<string, number>(),
    ownerLastKind: new Map<string, WorkKind>(),
    nextSequence: 1,
    dispatchSequence: 1,
    pumping: false,
  } satisfies SchedulerRuntime);

function activeReferenceVideos(): number {
  let count = 0;
  for (const item of runtime.active.values()) {
    if (item.kind === "reference_video") count += 1;
  }
  return count;
}

function activeEditingJobs(): number {
  let count = 0;
  for (const item of runtime.active.values()) {
    if (item.kind === "editing") count += 1;
  }
  return count;
}

function hasCapacity(kind: WorkKind): boolean {
  if (runtime.active.size >= TOTAL_CONCURRENCY) return false;
  if (kind === "editing") return activeEditingJobs() < EDITING_CONCURRENCY;
  if (kind === "voice") return [...runtime.active.values()].filter((item) => item.kind === "voice").length < VOICE_CONCURRENCY;
  if (
    kind === "reference_video" &&
    activeReferenceVideos() >= REFERENCE_VIDEO_CONCURRENCY
  ) {
    return false;
  }
  return true;
}

function effectivePriority(item: WorkItem, now: number): number {
  const ageBoost = Math.floor((now - item.enqueuedAt) / AGING_INTERVAL_MS);
  return Math.max(0, item.priority - ageBoost);
}

function removeAt(index: number): WorkItem | undefined {
  const [removed] = runtime.queue.splice(index, 1);
  removed?.onRemoved?.();
  return removed;
}

function pruneInvalid(): void {
  for (let index = runtime.queue.length - 1; index >= 0; index -= 1) {
    const item = runtime.queue[index];
    let valid = true;
    try {
      valid = item.isStillValid?.() ?? true;
    } catch {
      valid = false;
    }
    if (!valid) removeAt(index);
  }
}

function bestJobForOwner(owner: string, now: number): WorkItem | null {
  const lastKind = runtime.ownerLastKind.get(owner);
  const candidates = runtime.queue.filter(
    (item) => item.owner === owner && hasCapacity(item.kind),
  );
  candidates.sort((left, right) => {
    const priorityDifference =
      effectivePriority(left, now) - effectivePriority(right, now);
    if (priorityDifference !== 0) return priorityDifference;
    const leftRepeats = left.kind === lastKind ? 1 : 0;
    const rightRepeats = right.kind === lastKind ? 1 : 0;
    if (leftRepeats !== rightRepeats) return leftRepeats - rightRepeats;
    return left.sequence - right.sequence;
  });
  return candidates[0] ?? null;
}

function chooseNext(): WorkItem | null {
  pruneInvalid();
  const now = Date.now();
  const owners = [...new Set(runtime.queue.map((item) => item.owner))].filter(
    (owner) => !runtime.activeOwners.has(owner),
  );
  const candidates = owners
    .map((owner) => bestJobForOwner(owner, now))
    .filter((item): item is WorkItem => Boolean(item));
  candidates.sort((left, right) => {
    const dispatchDifference =
      (runtime.ownerLastDispatch.get(left.owner) ?? 0) -
      (runtime.ownerLastDispatch.get(right.owner) ?? 0);
    if (dispatchDifference !== 0) return dispatchDifference;
    const priorityDifference =
      effectivePriority(left, now) - effectivePriority(right, now);
    if (priorityDifference !== 0) return priorityDifference;
    return left.sequence - right.sequence;
  });
  return candidates[0] ?? null;
}

function start(item: WorkItem): void {
  const index = runtime.queue.findIndex((queued) => queued.id === item.id);
  if (index < 0) return;
  runtime.queue.splice(index, 1);
  runtime.active.set(item.id, item);
  runtime.activeOwners.add(item.owner);
  runtime.ownerLastDispatch.set(item.owner, runtime.dispatchSequence++);
  runtime.ownerLastKind.set(item.owner, item.kind);
  void Promise.resolve()
    .then(item.run)
    .catch((error) => {
      console.error(`[导演工作台] 后台队列项目 ${item.id} 异常退出：`, error);
    })
    .finally(() => {
      runtime.active.delete(item.id);
      runtime.activeOwners.delete(item.owner);
      void pumpWorkScheduler();
    });
}

async function pumpWorkScheduler(): Promise<void> {
  if (runtime.pumping) return;
  runtime.pumping = true;
  try {
    while (true) {
      const item = chooseNext();
      if (!item) break;
      start(item);
    }
  } finally {
    runtime.pumping = false;
  }
}

export function enqueueWork(options: {
  id: string;
  owner: string;
  kind: WorkKind;
  priority: number;
  run: () => Promise<void>;
  cancel?: () => void;
  isStillValid?: () => boolean;
  onRemoved?: () => void;
}): boolean {
  if (!options.owner || runtime.active.has(options.id)) return false;
  if (runtime.queue.some((item) => item.id === options.id)) return false;
  runtime.queue.push({
    ...options,
    priority: Math.max(0, Math.min(9, Math.round(options.priority))),
    sequence: runtime.nextSequence++,
    enqueuedAt: Date.now(),
  });
  void pumpWorkScheduler();
  return true;
}

export function cancelWork(id: string): boolean {
  const queueIndex = runtime.queue.findIndex((item) => item.id === id);
  if (queueIndex >= 0) {
    removeAt(queueIndex);
    void pumpWorkScheduler();
    return true;
  }
  const active = runtime.active.get(id);
  if (!active) return false;
  active.cancel?.();
  return true;
}

export function isWorkQueuedOrActive(id: string): boolean {
  return runtime.active.has(id) || runtime.queue.some((item) => item.id === id);
}

export function workSchedulerSnapshot(): {
  totalConcurrency: number;
  referenceVideoConcurrency: number;
  editingConcurrency: number;
  voiceConcurrency: number;
  active: Array<{ id: string; owner: string; kind: WorkKind }>;
  queued: Array<{ id: string; owner: string; kind: WorkKind }>;
} {
  return {
    totalConcurrency: TOTAL_CONCURRENCY,
    referenceVideoConcurrency: REFERENCE_VIDEO_CONCURRENCY,
    editingConcurrency: EDITING_CONCURRENCY,
    voiceConcurrency: VOICE_CONCURRENCY,
    active: [...runtime.active.values()].map(({ id, owner, kind }) => ({
      id,
      owner,
      kind,
    })),
    queued: runtime.queue.map(({ id, owner, kind }) => ({ id, owner, kind })),
  };
}
