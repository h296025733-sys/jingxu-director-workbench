import "server-only";
import { MAX_PENDING_WORK_GLOBAL } from "./concurrency-config";

import { createHash } from "node:crypto";
import { getSettings } from "./ai";
import { logAudit } from "./audit";
import { runPromptTranslation } from "./codex-director";
import { db } from "./db";
import { selectFinalSeedancePrompt } from "./seedance-prompt-display";
import { safeJsonParse } from "./storage";
import type {
  TaskPromptTranslationRow,
  TaskPromptTranslationState,
  TaskRow,
} from "./types";
import { cancelWork, enqueueWork, isWorkQueuedOrActive } from "./work-scheduler";

const activeControllers = new Map<string, AbortController>();
const MAX_ACTIVE_WORK_PER_USER = 2;
const MAX_ACTIVE_WORK_GLOBAL = MAX_PENDING_WORK_GLOBAL;

export class PromptTranslationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PromptTranslationRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function currentPrompt(task: TaskRow): string {
  if (task.status !== "succeeded" || !task.result_json) {
    throw new PromptTranslationRequestError("任务还没有可翻译的提示词", 409);
  }
  const result = safeJsonParse(task.result_json);
  const extra = asRecord(result.extra);
  const director = asRecord(extra?.director) ?? asRecord(result.director);
  if (director?.status !== "ready" || !Array.isArray(director.prompts)) {
    throw new PromptTranslationRequestError("任务还没有可翻译的提示词", 409);
  }
  const prompt = selectFinalSeedancePrompt(
    director.prompts.flatMap((entry) => {
      const record = asRecord(entry);
      return record
        ? [
            {
              title: String(record.title ?? ""),
              purpose: String(record.purpose ?? ""),
              content: String(record.content ?? ""),
            },
          ]
        : [];
    }),
  );
  if (!prompt?.content.trim()) {
    throw new PromptTranslationRequestError("任务还没有可翻译的提示词", 409);
  }
  return prompt.content.trim();
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function workId(taskId: number, sourceHash: string): string {
  return `prompt-translation:${taskId}:${sourceHash}`;
}

function rowFor(taskId: number, sourceHash: string): TaskPromptTranslationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM task_prompt_translations
       WHERE task_id=? AND source_hash=? AND language='en'`,
    )
    .get(taskId, sourceHash) as unknown as TaskPromptTranslationRow | undefined;
}

export function getTaskPromptTranslationState(
  task: TaskRow,
): TaskPromptTranslationState {
  let prompt: string;
  try {
    prompt = currentPrompt(task);
  } catch {
    return { language: "en", status: "idle", translatedPrompt: null, error: null };
  }
  const row = rowFor(task.id, promptHash(prompt));
  if (!row) {
    return { language: "en", status: "idle", translatedPrompt: null, error: null };
  }
  return {
    language: "en",
    status: row.status,
    translatedPrompt:
      row.status === "succeeded" ? row.translated_prompt : null,
    error: row.status === "failed" ? row.error : null,
  };
}

function failTranslation(
  taskId: number,
  sourceHash: string,
  message: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_prompt_translations
     SET status='failed', translated_prompt=NULL, error=?, finished_at=?, updated_at=?
     WHERE task_id=? AND source_hash=? AND language='en'
       AND status IN ('pending','running')`,
  ).run(message, now, now, taskId, sourceHash);
}

function publicFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/usage limit|quota|额度/iu.test(value)) {
    return "翻译服务暂时繁忙，中文仍可使用，稍后再试一次";
  }
  if (/取消/iu.test(value)) return "已取消翻译，中文仍可使用";
  return "英文没有翻译好，中文仍可使用，点击再试一次即可";
}

async function runTranslation(taskId: number, sourceHash: string): Promise<void> {
  const id = workId(taskId, sourceHash);
  const controller = new AbortController();
  activeControllers.set(id, controller);
  const now = new Date().toISOString();
  const started = db.prepare(
    `UPDATE task_prompt_translations
     SET status='running', started_at=?, error=NULL, updated_at=?
     WHERE task_id=? AND source_hash=? AND language='en' AND status='pending'`,
  ).run(now, now, taskId, sourceHash);
  if (started.changes !== 1) {
    activeControllers.delete(id);
    return;
  }
  let actor = "system";
  try {
    const row = rowFor(taskId, sourceHash);
    const task = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(taskId) as unknown as TaskRow | undefined;
    if (!row || !task) throw new Error("任务或翻译记录不存在");
    actor = row.requested_by || row.created_by;
    const latestSource = currentPrompt(task);
    if (promptHash(latestSource) !== sourceHash || latestSource !== row.source_prompt) {
      throw new Error("提示词已经更新，请翻译最新版本");
    }
    const translatedPrompt = await runPromptTranslation({
      sourcePrompt: row.source_prompt,
      settings: getSettings(),
      signal: controller.signal,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      const latestTask = db
        .prepare("SELECT * FROM tasks WHERE id=?")
        .get(taskId) as unknown as TaskRow | undefined;
      if (!latestTask || promptHash(currentPrompt(latestTask)) !== sourceHash) {
        throw new Error("提示词已经更新，请翻译最新版本");
      }
      const finishedAt = new Date().toISOString();
      const updated = db.prepare(
        `UPDATE task_prompt_translations
         SET status='succeeded', translated_prompt=?, error=NULL,
             finished_at=?, updated_at=?
         WHERE task_id=? AND source_hash=? AND language='en' AND status='running'`,
      ).run(translatedPrompt, finishedAt, finishedAt, taskId, sourceHash);
      if (updated.changes !== 1) throw new Error("翻译状态已经变化");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    logAudit(actor, "task_prompt_translation_complete", `任务 #${taskId} 英文提示词完成`);
  } catch (error) {
    console.error(`[镜序] 任务 #${taskId} 英文提示词失败：`, error);
    failTranslation(taskId, sourceHash, publicFailure(error));
    logAudit(actor, "task_prompt_translation_failed", `任务 #${taskId} 英文提示词失败`);
  } finally {
    activeControllers.delete(id);
  }
}

function enqueueTranslation(task: TaskRow, sourceHash: string): void {
  const id = workId(task.id, sourceHash);
  const queued = enqueueWork({
    id,
    owner: task.created_by,
    kind: "prompt_translation",
    priority: 0,
    isStillValid: () => rowFor(task.id, sourceHash)?.status === "pending",
    run: () => runTranslation(task.id, sourceHash),
    cancel: () => activeControllers.get(id)?.abort(new Error("英文翻译已取消")),
    onRemoved: () => failTranslation(task.id, sourceHash, "已取消翻译，中文仍可使用"),
  });
  if (!queued && !isWorkQueuedOrActive(id)) {
    failTranslation(task.id, sourceHash, "翻译队列暂时不可用，中文仍可使用");
    throw new PromptTranslationRequestError("翻译队列暂时不可用，请再试一次", 503);
  }
}

export function requestTaskPromptTranslation(options: {
  taskId: number;
  actor: string;
}): { queued: boolean; message: string; state: TaskPromptTranslationState } {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(options.taskId) as unknown as TaskRow | undefined;
  if (!task) throw new PromptTranslationRequestError("任务不存在", 404);
  const deliveryActive = db
    .prepare(
      `SELECT 1 FROM task_delivery_packages
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(task.id);
  if (deliveryActive) {
    throw new PromptTranslationRequestError(
      "交付内容正在切换，完成或取消后再生成英文版",
      409,
    );
  }
  const prompt = currentPrompt(task);
  const sourceHash = promptHash(prompt);
  const existing = rowFor(task.id, sourceHash);
  if (existing?.status === "succeeded" && existing.translated_prompt) {
    return {
      queued: false,
      message: "英文版本已就绪",
      state: getTaskPromptTranslationState(task),
    };
  }
  if (existing?.status === "pending" || existing?.status === "running") {
    return {
      queued: true,
      message: existing.status === "running" ? "正在翻译" : "已在翻译队列中",
      state: getTaskPromptTranslationState(task),
    };
  }
  const anotherActive = db
    .prepare(
      `SELECT source_hash FROM task_prompt_translations
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(task.id) as unknown as { source_hash: string } | undefined;
  if (anotherActive) {
    failTranslation(task.id, anotherActive.source_hash, "提示词已更新，已停止旧版翻译");
    cancelWork(workId(task.id, anotherActive.source_hash));
  }

  const active = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE created_by=? AND status IN ('pending','running')) +
       (SELECT COUNT(*) FROM task_delivery_packages WHERE created_by=? AND status IN ('pending','running')) +
       (SELECT COUNT(*) FROM task_prompt_translations WHERE created_by=? AND status IN ('pending','running')) AS owner_count,
       (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running')) +
       (SELECT COUNT(*) FROM task_delivery_packages WHERE status IN ('pending','running')) +
       (SELECT COUNT(*) FROM task_prompt_translations WHERE status IN ('pending','running')) AS global_count`,
  ).get(task.created_by, task.created_by, task.created_by) as unknown as {
    owner_count: number;
    global_count: number;
  };
  if (Number(active.owner_count) >= MAX_ACTIVE_WORK_PER_USER) {
    throw new PromptTranslationRequestError("你已有两项工作在排队，完成一项后再翻译", 429);
  }
  if (Number(active.global_count) >= MAX_ACTIVE_WORK_GLOBAL) {
    throw new PromptTranslationRequestError("服务器任务队列已满，请稍后再试", 429);
  }

  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_prompt_translations
      (task_id, source_hash, language, status, source_prompt, translated_prompt,
       error, created_by, requested_by, created_at, started_at, finished_at, updated_at)
     VALUES (?, ?, 'en', 'pending', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(task_id, source_hash, language) DO UPDATE SET
       status='pending', source_prompt=excluded.source_prompt,
       translated_prompt=NULL, error=NULL, requested_by=excluded.requested_by,
       started_at=NULL, finished_at=NULL, updated_at=excluded.updated_at`,
  ).run(
    task.id,
    sourceHash,
    prompt,
    task.created_by,
    options.actor,
    createdAt,
    createdAt,
  );
  enqueueTranslation(task, sourceHash);
  logAudit(options.actor, "task_prompt_translation_request", `任务 #${task.id} 请求英文提示词`);
  return {
    queued: true,
    message: "正在生成英文版本，中文仍可使用",
    state: getTaskPromptTranslationState(task),
  };
}

export function cancelTaskPromptTranslation(options: {
  taskId: number;
  actor: string;
}): TaskPromptTranslationState {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(options.taskId) as unknown as TaskRow | undefined;
  if (!task) throw new PromptTranslationRequestError("任务不存在", 404);
  const prompt = currentPrompt(task);
  const sourceHash = promptHash(prompt);
  const row = rowFor(task.id, sourceHash);
  if (!row || (row.status !== "pending" && row.status !== "running")) {
    throw new PromptTranslationRequestError("当前没有正在进行的英文翻译", 409);
  }
  failTranslation(task.id, sourceHash, "已取消翻译，中文仍可使用");
  cancelWork(workId(task.id, sourceHash));
  logAudit(options.actor, "task_prompt_translation_cancel", `取消任务 #${task.id} 英文提示词`);
  return getTaskPromptTranslationState(task);
}

export function isPromptTranslationActiveForTask(taskId: number): boolean {
  const rows = db
    .prepare(
      `SELECT source_hash, status FROM task_prompt_translations
       WHERE task_id=?`,
    )
    .all(taskId) as unknown as Array<{ source_hash: string; status: string }>;
  return (
    rows.some((row) => row.status === "pending" || row.status === "running") ||
    rows.some((row) => isWorkQueuedOrActive(workId(taskId, row.source_hash)))
  );
}
