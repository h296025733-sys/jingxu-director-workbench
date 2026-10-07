import "server-only";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSettings } from "./ai";
import { runReferenceImageGeneration } from "./codex-director";
import { db } from "./db";
import { DATA_DIR } from "./paths";
import { getAssetPath, safeJsonParse } from "./storage";
import { cancelWork, enqueueWork } from "./work-scheduler";
import type {
  AssetRow,
  GeneratedImageOut,
  GeneratedImageRow,
  TaskRow,
} from "./types";

interface RequiredImageCandidate {
  assetKey: string;
  kind: string;
  generationPrompt: string;
  purpose: string;
  avoid: string;
  dependencyAssetKeys: string[];
  canGenerate: boolean;
}

interface LinkedAssetRow extends AssetRow {
  field_key: string;
  position: number;
}

interface GeneratedImageRuntime {
  queuedTaskIds: Map<string, number>;
  active: Map<string, { taskId: number; controller: AbortController }>;
}

const SAFE_ASSET_KEY = /^[A-Z][A-Z0-9_]{1,95}$/;
const SAFE_GENERATED_FILE = /^generated-assets\/[0-9a-f-]{36}\.png$/i;
const MAX_AUTOMATIC_IMAGES_PER_TASK = 8;
const MAX_ACTIVE_GENERATIONS_PER_TASK = 8;
const MAX_ACTIVE_GENERATIONS_GLOBAL = 24;
const MAX_ATTEMPTS_PER_TASK = 32;
const MAX_VERSIONS_PER_ASSET = 12;
const runtimeHolder = globalThis as typeof globalThis & {
  __directorGeneratedImageRuntime?: GeneratedImageRuntime;
};
const runtime =
  runtimeHolder.__directorGeneratedImageRuntime ??
  (runtimeHolder.__directorGeneratedImageRuntime = {
    queuedTaskIds: new Map(),
    active: new Map(),
  } satisfies GeneratedImageRuntime);

export class GeneratedImageRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueAssetKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => SAFE_ASSET_KEY.test(item)),
    ),
  ];
}

function isLegacyGeneratable(kind: string, prompt: string): boolean {
  if (!prompt) return false;
  if (
    /(?:product|packag|logo|brand|certificate|evidence|document|reference_video|audio|产品|包装|商标|品牌|证书|证明|证据|文件|视频|音频)/i.test(
      kind,
    )
  ) {
    return false;
  }
  if (
    /(?:background|scene|environment|style|storyboard|pose|action|wardrobe|背景|场景|环境|画风|风格|分镜|姿势|动作|服装)/i.test(
      kind,
    )
  ) {
    return true;
  }
  if (/(?:character|person|identity|人物|角色|身份)/i.test(kind)) {
    return /(?:虚构|原创|不对应任何现实|非现实人物|fictional|original character|not (?:a )?real person)/i.test(
      prompt,
    );
  }
  return false;
}

function directorRecordFromResult(result: unknown): Record<string, unknown> | null {
  const resultRecord = asRecord(result);
  if (!resultRecord) return null;
  const extra = asRecord(resultRecord.extra);
  return asRecord(extra?.director) ?? asRecord(resultRecord.director);
}

function extractCandidates(result: unknown): RequiredImageCandidate[] {
  const director = directorRecordFromResult(result);
  if (!director || !Array.isArray(director.requiredAssets)) return [];
  const uploadPlan = Array.isArray(director.uploadPlan)
    ? director.uploadPlan.flatMap((raw) => {
        const item = asRecord(raw);
        return item ? [item] : [];
      })
    : [];
  const candidates: RequiredImageCandidate[] = [];
  for (const raw of director.requiredAssets) {
    const item = asRecord(raw);
    if (!item || item.status !== "missing") continue;
    const assetKey = stringValue(item.assetKey);
    const kind = stringValue(item.kind);
    const generationPrompt = stringValue(item.generationPrompt);
    if (!SAFE_ASSET_KEY.test(assetKey)) continue;
    const matchingPlan = uploadPlan.find(
      (planItem) => stringValue(planItem.assetKey) === assetKey,
    );
    const explicitCanGenerate =
      typeof item.canGenerate === "boolean" ? item.canGenerate : null;
    candidates.push({
      assetKey,
      kind: kind || "reference_image",
      generationPrompt,
      purpose: stringValue(matchingPlan?.coreResponsibility),
      avoid: stringValue(matchingPlan?.doNotReference),
      dependencyAssetKeys: uniqueAssetKeys(item.dependsOnAssetKeys).filter(
        (dependency) => dependency !== assetKey,
      ),
      canGenerate:
        explicitCanGenerate ?? isLegacyGeneratable(kind, generationPrompt),
    });
  }

  for (const candidate of candidates) {
    // A dependency may be an uploaded task image used only as source truth and
    // therefore absent from the final Seedance upload plan.
    if (
      candidate.dependencyAssetKeys.length === 0 &&
      /(?:storyboard|分镜)/i.test(candidate.kind)
    ) {
      candidate.dependencyAssetKeys = candidates
        .filter(
          (other) =>
            other.assetKey !== candidate.assetKey &&
            /(?:character|person|identity|background|scene|environment|style|人物|角色|身份|背景|场景|环境|风格|画风)/i.test(
              other.kind,
            ),
        )
        .map((other) => other.assetKey);
    }
  }
  return candidates;
}

function orderedCandidates(candidates: RequiredImageCandidate[]): RequiredImageCandidate[] {
  const byKey = new Map(candidates.map((candidate) => [candidate.assetKey, candidate]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: RequiredImageCandidate[] = [];

  const visit = (candidate: RequiredImageCandidate): void => {
    if (visited.has(candidate.assetKey)) return;
    if (visiting.has(candidate.assetKey)) return;
    visiting.add(candidate.assetKey);
    for (const dependency of candidate.dependencyAssetKeys) {
      const dependencyCandidate = byKey.get(dependency);
      if (dependencyCandidate) visit(dependencyCandidate);
    }
    visiting.delete(candidate.assetKey);
    visited.add(candidate.assetKey);
    ordered.push(candidate);
  };
  for (const candidate of candidates) visit(candidate);
  return ordered;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStringRecord(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function artifactUrl(taskId: number, relativePath: string): string {
  const encoded = relativePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/api/tasks/${taskId}/artifacts/${encoded}`;
}

export function toGeneratedImageOut(row: GeneratedImageRow): GeneratedImageOut {
  const readyPath = generatedImagePath(row);
  return {
    id: row.id,
    taskId: row.task_id,
    assetKey: row.asset_key,
    kind: row.kind,
    version: row.version,
    status: row.status,
    url:
      readyPath && row.file_name
        ? artifactUrl(row.task_id, row.file_name)
        : null,
    width: row.width,
    height: row.height,
    adopted: row.adopted === 1,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listGeneratedImages(taskId: number): GeneratedImageOut[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_generated_images
       WHERE task_id = ?
         AND (
           adopted = 1
           OR version = (
             SELECT MAX(newest.version)
             FROM task_generated_images newest
             WHERE newest.task_id = task_generated_images.task_id
               AND newest.asset_key = task_generated_images.asset_key
           )
         )
       ORDER BY asset_key, version DESC`,
    )
    .all(taskId) as unknown as GeneratedImageRow[];
  return rows.map(toGeneratedImageOut);
}

function stableAssetKey(fieldKey: string, position: number): string {
  const normalized = fieldKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized || "ASSET"}_${position + 1}`;
}

function taskLinkedImages(
  taskId: number,
): Map<string, { id: string; label: string; path: string }> {
  const rows = db
    .prepare(
      `SELECT a.*, ta.field_key, ta.position
       FROM task_assets ta
       JOIN assets a ON a.id = ta.asset_id
       WHERE ta.task_id = ?
       ORDER BY ta.field_key, ta.position`,
    )
    .all(taskId) as unknown as LinkedAssetRow[];
  return new Map(
    rows.map((row) => [
      stableAssetKey(row.field_key, row.position),
      {
        id: row.id,
        label: `${stableAssetKey(row.field_key, row.position)} · ${row.original_name}`,
        path: getAssetPath(row.stored_name),
      },
    ]),
  );
}

function generatedImagePath(row: GeneratedImageRow): string | null {
  if (
    row.status !== "succeeded" ||
    !row.file_name ||
    !SAFE_GENERATED_FILE.test(row.file_name)
  ) {
    return null;
  }
  const taskRoot = path.resolve(DATA_DIR, "task-runs", String(row.task_id));
  const candidate = path.resolve(taskRoot, ...row.file_name.split("/"));
  if (!candidate.startsWith(`${taskRoot}${path.sep}`)) return null;
  return fs.existsSync(/* turbopackIgnore: true */ candidate) ? candidate : null;
}

function generationReferences(row: GeneratedImageRow): {
  references: { label: string; path: string }[];
  bindings: Record<string, string>;
} {
  const references: { label: string; path: string }[] = [];
  const bindings: Record<string, string> = {};
  const linked = taskLinkedImages(row.task_id);
  const dependencyKeys = parseStringArray(row.dependency_keys_json);
  const latestGenerated = db.prepare(
    `SELECT * FROM task_generated_images
     WHERE task_id = ? AND asset_key = ? AND status = 'succeeded'
     ORDER BY adopted DESC, version DESC LIMIT 1`,
  );

  if (row.version > 1) {
    const previousVersion = db
      .prepare(
        `SELECT * FROM task_generated_images
         WHERE task_id = ? AND asset_key = ? AND status = 'succeeded' AND version < ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(row.task_id, row.asset_key, row.version) as unknown as
      | GeneratedImageRow
      | undefined;
    const previousPath = previousVersion
      ? generatedImagePath(previousVersion)
      : null;
    if (previousVersion && previousPath) {
      references.push({
        label: `${row.asset_key} 上一版候选（保留合格的身份/场景设计，只修正重做提示中的验收问题）`,
        path: previousPath,
      });
    }
  }

  for (const dependency of dependencyKeys) {
    const uploaded = linked.get(dependency);
    if (uploaded) {
      references.push(uploaded);
      bindings[dependency] = `uploaded:${uploaded.id}`;
      continue;
    }
    if (dependency === "REFERENCE_VIDEO") {
      const contactSheet = path.resolve(
        DATA_DIR,
        "task-runs",
        String(row.task_id),
        "evidence",
        "contact_sheet.jpg",
      );
      if (fs.existsSync(/* turbopackIgnore: true */ contactSheet)) {
        references.push({
          label: "REFERENCE_VIDEO 取证接触表（只参考动作、镜头与构图，不参考原人物身份）",
          path: contactSheet,
        });
        bindings[dependency] = "reference-video:source";
      }
      continue;
    }
    const generated = latestGenerated.get(
      row.task_id,
      dependency,
    ) as unknown as GeneratedImageRow | undefined;
    const generatedPath = generated ? generatedImagePath(generated) : null;
    if (!generated || !generatedPath) {
      throw new Error(`依赖参考图 ${dependency} 尚未成功生成`);
    }
    references.push({
      label: `${dependency} 的${generated.adopted === 1 ? "已采用版本" : "最新候选版本"}`,
      path: generatedPath,
    });
    bindings[dependency] = `generated:${generated.id}:v${generated.version}`;
  }

  if (/(?:storyboard|分镜)/i.test(row.kind) && references.length < 8) {
    const contactSheet = path.resolve(
      DATA_DIR,
      "task-runs",
      String(row.task_id),
      "evidence",
      "contact_sheet.jpg",
    );
    if (
      fs.existsSync(/* turbopackIgnore: true */ contactSheet) &&
      !references.some((reference) => reference.path === contactSheet)
    ) {
      references.push({
        label: "参考视频取证接触表（只参考动作、镜头与构图）",
        path: contactSheet,
      });
    }
  }

  return { references: references.slice(0, 8), bindings };
}

function safeGenerationFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/IMAGE_NOT_PRODUCED/u.test(raw)) {
    return "图片服务暂未返回可用图片，已尝试自动恢复；当前方案和素材都已保留，可继续重做这一张，不用重做整条任务。";
  }
  if (/usage limit|quota|额度/i.test(raw)) {
    return "生成服务的可用额度不足，方案和素材已保留。请管理员恢复额度后继续，不用重做整条任务。";
  }
  if (/unauthori[sz]ed|authentication|token.{0,16}expired|login required|\b401\b/i.test(raw)) {
    return "生成服务登录已失效，请管理员重新登录；当前方案和素材已保留。";
  }
  const sanitized = raw
    .replace(/file:\/\/[A-Za-z]:[\\/][^\s"'`<>]*/gi, "[服务器路径已隐藏]")
    .replace(/\\\\[^\s"'`<>]+(?:[\\/][^\s"'`<>]*)*/g, "[服务器路径已隐藏]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'`<>]*/g, "[服务器路径已隐藏]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(-500);
  return sanitized || "参考图生成失败，请稍后重做";
}

async function runGeneratedImage(id: string): Promise<void> {
  const queuedTaskId = runtime.queuedTaskIds.get(id);
  runtime.queuedTaskIds.delete(id);
  const controller = new AbortController();
  if (queuedTaskId) runtime.active.set(id, { taskId: queuedTaskId, controller });

  const started = db
    .prepare(
      `UPDATE task_generated_images
       SET status = 'running', started_at = ?, error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(new Date().toISOString(), id);
  if (started.changes !== 1) {
    runtime.active.delete(id);
    return;
  }

  const row = db
    .prepare("SELECT * FROM task_generated_images WHERE id = ?")
    .get(id) as unknown as GeneratedImageRow | undefined;
  if (!row) {
    runtime.active.delete(id);
    return;
  }
  runtime.active.set(id, { taskId: row.task_id, controller });

  try {
    const task = db
      .prepare("SELECT id FROM tasks WHERE id = ? AND status = 'succeeded'")
      .get(row.task_id);
    if (!task) throw new Error("所属导演任务不存在或尚未成功完成");
    const referenceBundle = generationReferences(row);
    db.prepare(
      `UPDATE task_generated_images SET dependency_versions_json=?
       WHERE id=? AND status='running'`,
    ).run(JSON.stringify(referenceBundle.bindings), row.id);
    const result = await runReferenceImageGeneration({
      taskId: row.task_id,
      generationId: row.id,
      assetKey: row.asset_key,
      kind: row.kind,
      purpose: row.purpose,
      generationPrompt: row.prompt,
      avoid: row.avoid,
      references: referenceBundle.references,
      settings: getSettings(),
      signal: controller.signal,
      onProgress: (message) => {
        db.prepare("UPDATE task_generated_images SET summary=? WHERE id=? AND status='running'")
          .run(message, row.id);
      },
    });
    db.prepare(
      `UPDATE task_generated_images
       SET status = 'succeeded', file_name = ?, mime_type = 'image/png',
           width = ?, height = ?, summary = ?, risks_json = ?, codex_thread_id = ?,
           error = NULL, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      result.relativePath,
      result.width,
      result.height,
      result.summary,
      JSON.stringify(result.risks),
      result.threadId,
      new Date().toISOString(),
      row.id,
    );
  } catch (error) {
    console.error(`[导演工作台] 任务 #${row.task_id} 参考图 ${row.asset_key} 生成失败：`, error);
    const message = safeGenerationFailure(error);
    db.prepare(
      `UPDATE task_generated_images
       SET status = 'failed', error = ?, adopted = 0, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(message, new Date().toISOString(), row.id);
  } finally {
    runtime.active.delete(id);
  }
}

function scheduleGeneratedImage(
  id: string,
  taskId: number,
  automatic: boolean,
): void {
  if (runtime.queuedTaskIds.has(id) || runtime.active.has(id)) return;
  const row = db
    .prepare("SELECT created_by, status FROM task_generated_images WHERE id = ?")
    .get(id) as unknown as
    | { created_by: string; status: string }
    | undefined;
  if (!row || row.status !== "pending") return;
  runtime.queuedTaskIds.set(id, taskId);
  const accepted = enqueueWork({
    id: `image:${id}`,
    owner: row.created_by,
    kind: "image",
    priority: automatic ? 2 : 1,
    isStillValid: () => {
      const current = db
        .prepare("SELECT status FROM task_generated_images WHERE id = ?")
        .get(id) as unknown as { status: string } | undefined;
      return current?.status === "pending";
    },
    onRemoved: () => runtime.queuedTaskIds.delete(id),
    run: () => runGeneratedImage(id),
    cancel: () => runtime.active.get(id)?.controller.abort(new Error("参考图生成已取消")),
  });
  if (!accepted) runtime.queuedTaskIds.delete(id);
}

function insertAttempt(
  taskId: number,
  createdBy: string,
  candidate: RequiredImageCandidate,
  version: number,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_generated_images
      (id, task_id, asset_key, kind, version, prompt, purpose, avoid,
       dependency_keys_json, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    taskId,
    candidate.assetKey,
    candidate.kind,
    version,
    candidate.generationPrompt,
    candidate.purpose,
    candidate.avoid,
    JSON.stringify(candidate.dependencyAssetKeys),
    createdBy,
    new Date().toISOString(),
  );
  return id;
}

function candidateMatchesAttempt(
  candidate: RequiredImageCandidate,
  attempt: Pick<
    GeneratedImageRow,
    | "kind"
    | "prompt"
    | "purpose"
    | "avoid"
    | "dependency_keys_json"
  >,
): boolean {
  return (
    candidate.kind === attempt.kind &&
    candidate.generationPrompt === attempt.prompt &&
    candidate.purpose === attempt.purpose &&
    candidate.avoid === attempt.avoid &&
    JSON.stringify(candidate.dependencyAssetKeys) ===
      JSON.stringify(parseStringArray(attempt.dependency_keys_json))
  );
}

export function scheduleAutomaticReferenceImages(options: {
  taskId: number;
  createdBy: string;
  result: unknown;
}): number {
  const candidates = orderedCandidates(
    extractCandidates(options.result).filter(
      (candidate) => candidate.canGenerate && candidate.generationPrompt,
    ),
  ).slice(0, MAX_AUTOMATIC_IMAGES_PER_TASK);
  if (candidates.length === 0) return 0;

  const scheduled: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = db
      .prepare("SELECT id FROM tasks WHERE id = ? AND status = 'succeeded'")
      .get(options.taskId);
    if (!task) throw new Error("Cannot schedule images for an unfinished task");
    for (const candidate of candidates) {
      const latest = db
        .prepare(
          `SELECT * FROM task_generated_images
           WHERE task_id=? AND asset_key=? ORDER BY version DESC LIMIT 1`,
        )
        .get(options.taskId, candidate.assetKey) as unknown as
        | GeneratedImageRow
        | undefined;
      if (
        latest &&
        latest.status !== "failed" &&
        candidateMatchesAttempt(candidate, latest)
      ) {
        continue;
      }
      const version = Number(latest?.version ?? 0) + 1;
      if (version > MAX_VERSIONS_PER_ASSET) continue;
      if (latest && !candidateMatchesAttempt(candidate, latest)) {
        // Never let an adopted image from an older, incompatible specification
        // silently satisfy the newly selected delivery package.
        db.prepare(
          "UPDATE task_generated_images SET adopted=0 WHERE task_id=? AND asset_key=?",
        ).run(options.taskId, candidate.assetKey);
      }
      scheduled.push(
        insertAttempt(options.taskId, options.createdBy, candidate, version),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const id of scheduled) scheduleGeneratedImage(id, options.taskId, true);
  return scheduled.length;
}

export function createGeneratedImageAttempt(options: {
  taskId: number;
  assetKey: string;
  createdBy: string;
}): GeneratedImageOut {
  let createdId = "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(options.taskId) as unknown as TaskRow | undefined;
    if (!task) throw new GeneratedImageRequestError("任务不存在", 404);
    if (task.status !== "succeeded" || !task.result_json) {
      throw new GeneratedImageRequestError("导演任务成功后才能生成参考图", 409);
    }
    const result = safeJsonParse(task.result_json);
    const candidate = extractCandidates(result).find(
      (item) => item.assetKey === options.assetKey,
    );
    if (!candidate) {
      throw new GeneratedImageRequestError("导演结果中没有这个缺失素材", 404);
    }
    if (!candidate.canGenerate || !candidate.generationPrompt) {
      throw new GeneratedImageRequestError(
        "该素材没有可安全生成的依据；真实产品只有在关联产品原图时才能整理成干净参考图",
        409,
      );
    }
    const taskAttempts = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_generated_images WHERE task_id = ?",
          )
          .get(options.taskId) as unknown as { count: number }
      ).count,
    );
    if (taskAttempts >= MAX_ATTEMPTS_PER_TASK) {
      throw new GeneratedImageRequestError(
        `每个任务最多保留 ${MAX_ATTEMPTS_PER_TASK} 次参考图尝试`,
        429,
      );
    }
    const activeForTask = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM task_generated_images
             WHERE task_id = ? AND status IN ('pending', 'running')`,
          )
          .get(options.taskId) as unknown as { count: number }
      ).count,
    );
    if (activeForTask >= MAX_ACTIVE_GENERATIONS_PER_TASK) {
      throw new GeneratedImageRequestError("该任务的参考图仍在排队，请稍后再试", 429);
    }
    const globalActive = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_generated_images WHERE status IN ('pending', 'running')",
          )
          .get() as unknown as { count: number }
      ).count,
    );
    if (globalActive >= MAX_ACTIVE_GENERATIONS_GLOBAL) {
      throw new GeneratedImageRequestError("参考图生成队列已满，请稍后再试", 429);
    }
    const activeSameKey = db
      .prepare(
        `SELECT id FROM task_generated_images
         WHERE task_id = ? AND asset_key = ? AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .get(options.taskId, options.assetKey);
    if (activeSameKey) {
      throw new GeneratedImageRequestError("这张参考图已在排队或生成中", 409);
    }
    const currentVersion = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM task_generated_images WHERE task_id = ? AND asset_key = ?`,
          )
          .get(options.taskId, options.assetKey) as unknown as { version: number }
      ).version,
    );
    if (currentVersion >= MAX_VERSIONS_PER_ASSET) {
      throw new GeneratedImageRequestError(
        `每个素材最多保留 ${MAX_VERSIONS_PER_ASSET} 个候选版本`,
        429,
      );
    }
    const latestSucceeded = db
      .prepare(
        `SELECT risks_json FROM task_generated_images
         WHERE task_id = ? AND asset_key = ? AND status = 'succeeded'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(options.taskId, options.assetKey) as unknown as
      | { risks_json: string }
      | undefined;
    const previousRisks = latestSucceeded
      ? parseStringArray(latestSucceeded.risks_json)
          .map((risk) => risk.trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const attemptCandidate: RequiredImageCandidate = previousRisks.length
      ? {
          ...candidate,
          generationPrompt:
            `${candidate.generationPrompt}\n\n` +
            `这是重做版本。必须在保持原身份、场景与职责不变的前提下修正上一版验收问题：${previousRisks.join("；")}`,
        }
      : candidate;
    createdId = insertAttempt(
      options.taskId,
      options.createdBy,
      attemptCandidate,
      currentVersion + 1,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleGeneratedImage(createdId, options.taskId, false);
  const row = db
    .prepare("SELECT * FROM task_generated_images WHERE id = ?")
    .get(createdId) as unknown as GeneratedImageRow;
  return toGeneratedImageOut(row);
}

export function cancelGeneratedImageAttempt(options: {
  taskId: number;
  imageId: string;
}): GeneratedImageOut {
  const row = db
    .prepare("SELECT * FROM task_generated_images WHERE id=? AND task_id=?")
    .get(options.imageId, options.taskId) as unknown as GeneratedImageRow | undefined;
  if (!row) throw new GeneratedImageRequestError("参考图候选不存在", 404);
  if (row.status !== "pending" && row.status !== "running") {
    throw new GeneratedImageRequestError("这张图片当前不需要取消", 409);
  }
  db.prepare(
    `UPDATE task_generated_images
     SET status='failed', adopted=0, error='已取消', finished_at=?
     WHERE id=? AND task_id=? AND status IN ('pending','running')`,
  ).run(new Date().toISOString(), row.id, row.task_id);
  cancelWork(`image:${row.id}`);
  const updated = db
    .prepare("SELECT * FROM task_generated_images WHERE id=?")
    .get(row.id) as unknown as GeneratedImageRow;
  return toGeneratedImageOut(updated);
}

export function adoptGeneratedImage(options: {
  taskId: number;
  imageId: string;
}): GeneratedImageOut {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT * FROM task_generated_images
         WHERE id = ? AND task_id = ?`,
      )
      .get(options.imageId, options.taskId) as unknown as GeneratedImageRow | undefined;
    if (!row) throw new GeneratedImageRequestError("参考图候选不存在", 404);
    if (row.status !== "succeeded" || !generatedImagePath(row)) {
      throw new GeneratedImageRequestError("只有成功生成且文件完整的候选图才能采用", 409);
    }
    db.prepare(
      `UPDATE task_generated_images SET adopted = 0
       WHERE task_id = ? AND asset_key = ?`,
    ).run(row.task_id, row.asset_key);
    db.prepare(
      "UPDATE task_generated_images SET adopted = 1 WHERE id = ?",
    ).run(row.id);

    // A downstream storyboard/pose image is only compatible with the exact
    // upstream versions used during its generation. Adopting a different
    // identity/scene version recursively clears stale downstream adoptions.
    const changedBindings = new Map<string, string | null>([
      [row.asset_key, `generated:${row.id}:v${row.version}`],
    ]);
    let changed = true;
    while (changed) {
      changed = false;
      const adoptedRows = db
        .prepare(
          `SELECT * FROM task_generated_images
           WHERE task_id=? AND adopted=1 AND id<>?`,
        )
        .all(row.task_id, row.id) as unknown as GeneratedImageRow[];
      for (const candidate of adoptedRows) {
        const dependencies = parseStringArray(candidate.dependency_keys_json);
        const bindings = parseStringRecord(candidate.dependency_versions_json);
        const incompatible = dependencies.some((dependency) => {
          if (!changedBindings.has(dependency)) return false;
          const expected = changedBindings.get(dependency);
          return expected === null || bindings[dependency] !== expected;
        });
        if (!incompatible) continue;
        db.prepare(
          "UPDATE task_generated_images SET adopted=0 WHERE id=?",
        ).run(candidate.id);
        changedBindings.set(candidate.asset_key, null);
        changed = true;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const adopted = db
    .prepare("SELECT * FROM task_generated_images WHERE id = ?")
    .get(options.imageId) as unknown as GeneratedImageRow;
  return toGeneratedImageOut(adopted);
}

export function isReferenceImageGenerationActiveForTask(taskId: number): boolean {
  for (const queuedTaskId of runtime.queuedTaskIds.values()) {
    if (queuedTaskId === taskId) return true;
  }
  for (const active of runtime.active.values()) {
    if (active.taskId === taskId) return true;
  }
  return false;
}
