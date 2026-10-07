import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

const STRICT_TASK_ID = /^[1-9]\d*$/;

interface TaskRunsRoot {
  resolved: string;
  canonical: string;
}

interface OrphanCleanupOptions {
  processEpochMs: number;
  taskExists: (taskId: number) => boolean;
}

let orphanCleanupStarted = false;

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function getExistingTaskRunsRoot(): TaskRunsRoot | null {
  const resolved = path.resolve(DATA_DIR, "task-runs");
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("task-runs root is not a physical directory");
  }

  const canonical = fs.realpathSync.native(
    /* turbopackIgnore: true */ resolved,
  );
  if (!samePath(resolved, canonical)) {
    throw new Error("task-runs root resolves outside its configured path");
  }
  return { resolved, canonical };
}

function resolveExistingTaskRun(
  root: TaskRunsRoot,
  taskIdText: string,
): { resolved: string; canonical: string; stat: fs.Stats } | null {
  if (!STRICT_TASK_ID.test(taskIdText)) {
    throw new Error("task run id is not a strict positive integer");
  }
  const taskId = Number(taskIdText);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task run id is outside the safe integer range");
  }

  const resolved = path.resolve(root.resolved, taskIdText);
  if (!samePath(path.dirname(resolved), root.resolved)) {
    throw new Error("task run path escaped task-runs");
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("task run is not a physical directory");
  }

  const canonical = fs.realpathSync.native(
    /* turbopackIgnore: true */ resolved,
  );
  if (
    !isWithin(root.canonical, canonical) ||
    !samePath(path.dirname(canonical), root.canonical)
  ) {
    throw new Error("canonical task run path escaped task-runs");
  }
  return { resolved, canonical, stat };
}

function assertPhysicalTaskRunTree(
  taskRunRoot: string,
  canonicalTaskRunRoot: string,
): number {
  const pending = [taskRunRoot];
  let newestMtimeMs = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stat = fs.lstatSync(/* turbopackIgnore: true */ current);
    if (stat.isSymbolicLink()) {
      throw new Error("task run contains a reparse point or symbolic link");
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error("task run contains an unsupported filesystem entry");
    }

    const canonicalCurrent = fs.realpathSync.native(
      /* turbopackIgnore: true */ current,
    );
    if (
      !samePath(canonicalCurrent, canonicalTaskRunRoot) &&
      !isWithin(canonicalTaskRunRoot, canonicalCurrent)
    ) {
      throw new Error("canonical task run child escaped its directory");
    }
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);

    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(
      /* turbopackIgnore: true */ current,
      { withFileTypes: true },
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error("task run contains a reparse point or symbolic link");
      }
      pending.push(path.join(/* turbopackIgnore: true */ current, entry.name));
    }
  }
  return newestMtimeMs;
}

/**
 * Remove the run directory for a task whose database record is already gone.
 * Callers decide how to report failures; this function never weakens path checks.
 */
export function deleteTaskRunDirectory(taskId: number): boolean {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task id is not a strict positive integer");
  }
  const root = getExistingTaskRunsRoot();
  if (!root) return false;
  const target = resolveExistingTaskRun(root, String(taskId));
  if (!target) return false;

  assertPhysicalTaskRunTree(target.resolved, target.canonical);
  const finalTarget = resolveExistingTaskRun(root, String(taskId));
  if (!finalTarget || !samePath(finalTarget.canonical, target.canonical)) {
    throw new Error("task run changed during cleanup validation");
  }
  assertPhysicalTaskRunTree(finalTarget.resolved, finalTarget.canonical);
  fs.rmSync(/* turbopackIgnore: true */ finalTarget.resolved, {
    recursive: true,
    force: true,
  });
  return true;
}

/**
 * Best-effort production startup reconciliation for DELETE crash leftovers.
 * It only removes old, strict numeric directories with no matching task record.
 */
export function cleanupOrphanTaskRunsOnce(options: OrphanCleanupOptions): void {
  if (orphanCleanupStarted || process.env.NODE_ENV !== "production") return;
  orphanCleanupStarted = true;
  if (!Number.isFinite(options.processEpochMs) || options.processEpochMs <= 0) {
    console.error("[Director Workbench] Refusing task-run scan with invalid process epoch");
    return;
  }

  let root: TaskRunsRoot | null;
  try {
    root = getExistingTaskRunsRoot();
  } catch (error) {
    console.error("[Director Workbench] Failed to validate task-runs root:", error);
    return;
  }
  if (!root) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(/* turbopackIgnore: true */ root.resolved, {
      withFileTypes: true,
    });
  } catch (error) {
    console.error("[Director Workbench] Failed to scan orphan task runs:", error);
    return;
  }

  for (const entry of entries) {
    if (!STRICT_TASK_ID.test(entry.name)) continue;
    const taskId = Number(entry.name);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) continue;
    if (entry.isSymbolicLink()) {
      console.error(`[Director Workbench] Refusing redirected task run #${taskId}`);
      continue;
    }
    if (!entry.isDirectory()) continue;

    try {
      const target = resolveExistingTaskRun(root, entry.name);
      if (!target || target.stat.mtimeMs >= options.processEpochMs) continue;
      if (options.taskExists(taskId)) continue;

      const newestMtimeMs = assertPhysicalTaskRunTree(
        target.resolved,
        target.canonical,
      );
      if (newestMtimeMs >= options.processEpochMs) continue;

      const finalTarget = resolveExistingTaskRun(root, entry.name);
      if (
        !finalTarget ||
        !samePath(finalTarget.canonical, target.canonical) ||
        finalTarget.stat.mtimeMs >= options.processEpochMs ||
        options.taskExists(taskId)
      ) {
        continue;
      }
      const finalNewestMtimeMs = assertPhysicalTaskRunTree(
        finalTarget.resolved,
        finalTarget.canonical,
      );
      if (
        finalNewestMtimeMs >= options.processEpochMs ||
        options.taskExists(taskId)
      ) {
        continue;
      }
      fs.rmSync(/* turbopackIgnore: true */ finalTarget.resolved, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.error(
        `[Director Workbench] Failed to reconcile orphan task run #${taskId}:`,
        error,
      );
    }
  }
}
