import fs from "node:fs";
import { MAX_PENDING_WORK_GLOBAL } from "./concurrency-config";
import path from "node:path";
import { AIClient, getSettings } from "./ai";
import { logAudit } from "./audit";
import type {
  CodexDirectorOutput,
  DirectorInputAsset,
  DirectorRequiredAsset,
  DirectorRouteMode,
  DirectorSkillName,
} from "./codex-director";
import { db } from "./db";
import { DATA_DIR } from "./paths";
import { getAssetPath, getVideoPath, safeJsonParse } from "./storage";
import {
  forcePromptAssetBindings,
  promptContainsTimeRange,
} from "./seedance-prompt-policy";
import { scheduleAutomaticReferenceImages } from "./generated-images";
import { scheduleAutomaticReferencePreparation } from "./reference-preparations";
import { cancelWork, enqueueWork, isWorkQueuedOrActive } from "./work-scheduler";
import type {
  AssetRow,
  ReferenceDeliveryMode,
  TaskDeliveryPackageRow,
  TaskDeliveryPackageState,
  TaskRow,
  VideoRow,
} from "./types";

interface LinkedAssetRow extends AssetRow {
  field_key: string;
  position: number;
}

const DELIVERY_MODES: readonly ReferenceDeliveryMode[] = [
  "text_only",
  "images_text",
  "video_images_text",
];
const VIDEO_DELIVERY_ROUTES = new Set<DirectorRouteMode>([
  "CONTENT_IMITATION",
  "STRICT_REPLICATION",
  "REPAIR",
]);
const MAX_ACTIVE_WORK_PER_USER = 2;
const MAX_ACTIVE_WORK_GLOBAL = MAX_PENDING_WORK_GLOBAL;
const activeControllers = new Map<string, AbortController>();

export class DeliveryPackageRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeliveryPackageRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeDeliveryMode(value: unknown): ReferenceDeliveryMode {
  if (value === "text_only") return "text_only";
  if (value === "video_images_text" || value === "allow_video") {
    return "video_images_text";
  }
  return "images_text";
}

export function inferResultDeliveryMode(
  resultJson: string,
  fallback: unknown,
): ReferenceDeliveryMode {
  const director = resultDirector(safeJsonParse(resultJson));
  const plan = Array.isArray(director?.uploadPlan) ? director.uploadPlan : [];
  if (plan.length === 0) return "text_only";
  if (
    plan.some((item) => {
      const record = asRecord(item);
      return record?.assetKey === "REFERENCE_VIDEO" || record?.type === "video";
    })
  ) {
    return "video_images_text";
  }
  if (plan.some((item) => ["image", "generated"].includes(String(asRecord(item)?.type)))) {
    return "images_text";
  }
  return normalizeDeliveryMode(fallback);
}

export function parseDeliveryMode(value: unknown): ReferenceDeliveryMode | null {
  return DELIVERY_MODES.includes(value as ReferenceDeliveryMode)
    ? (value as ReferenceDeliveryMode)
    : null;
}

function resultDirector(result: unknown): Record<string, unknown> | null {
  const root = asRecord(result);
  const extra = asRecord(root?.extra);
  return asRecord(extra?.director) ?? asRecord(root?.director);
}

function routeFromTask(task: TaskRow): DirectorRouteMode | null {
  const director = resultDirector(safeJsonParse(task.result_json ?? "{}"));
  const routing = asRecord(director?.routing);
  const mode = String(routing?.mode ?? "") as DirectorRouteMode;
  if (
    [
      "ORIGINAL",
      "VIRAL_ADAPTATION",
      "CONTENT_IMITATION",
      "STRICT_REPLICATION",
      "REPAIR",
    ].includes(mode)
  ) {
    return mode;
  }
  if (task.feature_id === "video_replication") return "STRICT_REPLICATION";
  if (task.feature_id === "video_breakdown") return "VIRAL_ADAPTATION";
  return null;
}

export function allowedModesForTask(task: TaskRow): ReferenceDeliveryMode[] {
  const allowed: ReferenceDeliveryMode[] = ["text_only", "images_text"];
  const route = routeFromTask(task);
  if (task.video_id && route && VIDEO_DELIVERY_ROUTES.has(route)) {
    allowed.push("video_images_text");
  }
  return allowed;
}

function assertConvertibleTask(task: TaskRow): void {
  if (task.status !== "succeeded" || !task.result_json) {
    throw new DeliveryPackageRequestError("只有已完成的任务才能切换交付内容", 409);
  }
  const director = resultDirector(safeJsonParse(task.result_json));
  if (!director || director.status !== "ready") {
    throw new DeliveryPackageRequestError("当前结果还不是可直接使用的完整方案", 409);
  }
  if (!Array.isArray(director.prompts) || director.prompts.length !== 1) {
    throw new DeliveryPackageRequestError("当前结果缺少可转换的最终提示词", 409);
  }
}

function selectedPackage(taskId: number): TaskDeliveryPackageRow | undefined {
  return db
    .prepare(
      `SELECT * FROM task_delivery_packages
       WHERE task_id=? AND selected=1 LIMIT 1`,
    )
    .get(taskId) as unknown as TaskDeliveryPackageRow | undefined;
}

/** Lazily records the already-delivered result as the first reusable package. */
function ensureInitialPackage(task: TaskRow): TaskDeliveryPackageRow {
  const existing = selectedPackage(task.id);
  if (existing) return existing;
  assertConvertibleTask(task);
  const params = safeJsonParse(task.params_json);
  const mode = inferResultDeliveryMode(task.result_json!, params.referenceDelivery);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const raced = selectedPackage(task.id);
    if (!raced) {
      db.prepare(
        `INSERT INTO task_delivery_packages
          (task_id, delivery_mode, status, source_result_json, result_json,
           error, selected, created_by, requested_by, created_at, started_at,
           finished_at, updated_at)
         VALUES (?, ?, 'succeeded', ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, delivery_mode) DO UPDATE SET
           status='succeeded', source_result_json=excluded.source_result_json,
           result_json=excluded.result_json, error=NULL, selected=1,
           requested_by=excluded.requested_by, finished_at=excluded.finished_at,
           updated_at=excluded.updated_at`,
      ).run(
        task.id,
        mode,
        task.result_json,
        task.result_json,
        task.created_by,
        task.created_by,
        now,
        task.finished_at ?? now,
        task.finished_at ?? now,
        now,
      );
      db.prepare(
        "UPDATE tasks SET params_json=? WHERE id=? AND status='succeeded'",
      ).run(updateTaskParamsMode(task.params_json, mode), task.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const created = selectedPackage(task.id);
  if (!created) throw new Error("交付套餐初始缓存没有创建成功");
  return created;
}

function publicConversionError(error: string | null): string | null {
  if (!error) return null;
  if (/网络|stream disconnected|transport|timeout|超时/i.test(error)) {
    return "转换时网络中断，原结果仍可使用。点击一次即可重试。";
  }
  if (/额度|quota|rate.?limit|busy|繁忙/i.test(error)) {
    return "生成服务暂时繁忙，原结果仍可使用。稍后点击重试。";
  }
  if (/质量门禁|唯一主职责|不能控制|@图片|@视频|素材职责/i.test(error)) {
    return "这次没有把素材职责写牢，原结果仍可使用。已保留全部素材，点击一次即可自动修正。";
  }
  return error.length > 180
    ? "这次转换没有完成，原结果仍可使用。点击一次即可重试。"
    : error;
}

export function getTaskDeliveryPackageState(
  task: TaskRow,
): TaskDeliveryPackageState {
  const selected = ensureInitialPackage(task);
  const rows = db
    .prepare(
      `SELECT * FROM task_delivery_packages
       WHERE task_id=? ORDER BY updated_at DESC`,
    )
    .all(task.id) as unknown as TaskDeliveryPackageRow[];
  const active = rows.find(
    (row) => row.status === "pending" || row.status === "running",
  );
  const recentFailure = rows.find(
    (row) =>
      row.status === "failed" &&
      row.delivery_mode !== selected.delivery_mode &&
      row.updated_at >= selected.updated_at,
  );
  const conversion = active ?? recentFailure;
  return {
    currentMode: selected.delivery_mode,
    allowedModes: allowedModesForTask(task),
    cachedModes: DELIVERY_MODES.filter((mode) =>
      rows.some((row) => row.delivery_mode === mode && row.status === "succeeded"),
    ),
    conversion: conversion
      ? {
          targetMode: conversion.delivery_mode,
          status: conversion.status as "pending" | "running" | "failed",
          error: publicConversionError(conversion.error),
        }
      : null,
  };
}

function stableAssetKey(fieldKey: string, position: number): string {
  const normalized = fieldKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized || "ASSET"}_${position + 1}`;
}

function linkedAssets(taskId: number): DirectorInputAsset[] {
  const rows = db
    .prepare(
      `SELECT a.*, ta.field_key, ta.position
       FROM task_assets ta
       JOIN assets a ON a.id=ta.asset_id
       WHERE ta.task_id=?
       ORDER BY ta.field_key, ta.position`,
    )
    .all(taskId) as unknown as LinkedAssetRow[];
  return rows.map((row) => ({
    id: row.id,
    key: stableAssetKey(row.field_key, row.position),
    fieldKey: row.field_key,
    name: row.original_name,
    path: getAssetPath(row.stored_name),
    mimeType: row.mime_type,
  }));
}

function hasActiveAttachmentWork(taskId: number): boolean {
  const image = db
    .prepare(
      `SELECT 1 FROM task_generated_images
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(taskId);
  const video = db
    .prepare(
      `SELECT 1 FROM task_reference_preparations
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(taskId);
  return Boolean(image || video);
}

function schedulePackageAssets(task: TaskRow, result: Record<string, unknown>): void {
  let complete = true;
  try {
    scheduleAutomaticReferenceImages({
      taskId: task.id,
      createdBy: task.created_by,
      result,
    });
  } catch (error) {
    complete = false;
    console.error(`[镜序] 任务 #${task.id} 套餐参考图排队失败：`, error);
  }
  try {
    scheduleAutomaticReferencePreparation({
      taskId: task.id,
      createdBy: task.created_by,
      result,
    });
  } catch (error) {
    complete = false;
    console.error(`[镜序] 任务 #${task.id} 套餐参考视频排队失败：`, error);
  }
  if (complete) {
    db.prepare(
      "UPDATE tasks SET asset_schedule_complete=1 WHERE id=? AND status='succeeded'",
    ).run(task.id);
  }
}

function updateTaskParamsMode(paramsJson: string, mode: ReferenceDeliveryMode): string {
  return JSON.stringify({
    ...safeJsonParse(paramsJson),
    referenceDelivery: mode,
  });
}

function preferredConversionSource(
  task: TaskRow,
  targetMode: ReferenceDeliveryMode,
): string {
  if (targetMode === "text_only") return task.result_json!;
  const preferredModes: ReferenceDeliveryMode[] =
    targetMode === "video_images_text"
      ? ["images_text", "video_images_text"]
      : ["video_images_text", "images_text"];
  for (const mode of preferredModes) {
    if (mode === targetMode) continue;
    const row = db
      .prepare(
        `SELECT result_json FROM task_delivery_packages
         WHERE task_id=? AND delivery_mode=? AND status='succeeded'
           AND result_json IS NOT NULL`,
      )
      .get(task.id, mode) as unknown as { result_json: string } | undefined;
    if (row?.result_json) return row.result_json;
  }
  return task.result_json!;
}

function applyCachedPackage(
  task: TaskRow,
  row: TaskDeliveryPackageRow,
): void {
  if (row.status !== "succeeded" || !row.result_json) {
    throw new Error("缓存套餐状态无效");
  }
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE task_delivery_packages SET selected=0 WHERE task_id=?").run(
      task.id,
    );
    const selected = db.prepare(
      `UPDATE task_delivery_packages SET selected=1, updated_at=?
       WHERE task_id=? AND delivery_mode=? AND status='succeeded' AND result_json IS NOT NULL`,
    ).run(now, task.id, row.delivery_mode);
    const updated = db.prepare(
      `UPDATE tasks SET params_json=?, result_json=?, message='已切换交付内容',
                        asset_schedule_complete=0
       WHERE id=? AND status='succeeded'`,
    ).run(
      updateTaskParamsMode(task.params_json, row.delivery_mode),
      row.result_json,
      task.id,
    );
    if (selected.changes !== 1 || updated.changes !== 1) {
      throw new Error("切换缓存套餐时任务状态已变化");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const refreshed = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(task.id) as unknown as TaskRow;
  schedulePackageAssets(refreshed, safeJsonParse(row.result_json));
}

function routeSkill(mode: DirectorRouteMode): DirectorSkillName {
  if (mode === "STRICT_REPLICATION") return "replicate-viral-video";
  if (mode === "VIRAL_ADAPTATION") return "viral-product-director";
  return "omni-video-director";
}

function sourcePromptAnchors(director: Record<string, unknown>): string[] {
  const quality = asRecord(director.qualityPlan);
  const beats = Array.isArray(quality?.storyBeats) ? quality.storyBeats : [];
  const locks = Array.isArray(quality?.replicationLocks)
    ? quality.replicationLocks
    : [];
  return [...beats, ...locks]
    .map((item) => String(asRecord(item)?.promptAnchor ?? "").trim())
    .filter((value) => value.length >= 6);
}

export function normalizePromptAnchor(value: string): string {
  return value
    .replace(
      /@(图片|视频|音频)[1-9]\d*(?:(?:中|里)?的|所示(?:的)?|呈现(?:的)?)?/gu,
      "",
    )
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

export function assertConvertedPackage(
  source: Record<string, unknown>,
  output: CodexDirectorOutput,
  target: ReferenceDeliveryMode,
): void {
  if (output.status !== "ready" || output.prompts.length !== 1) {
    throw new Error("转换没有返回可直接使用的单一提示词");
  }
  const sourceRoute = String(asRecord(source.routing)?.mode ?? "");
  if (output.routing.mode !== sourceRoute) {
    throw new Error("转换改变了已经确认的创作方向");
  }
  const prompt = output.prompts[0].content;
  const normalizedPrompt = normalizePromptAnchor(prompt);
  const lostAnchors = sourcePromptAnchors(source).filter((anchor) => {
    const normalized = normalizePromptAnchor(anchor);
    return normalized.length >= 6 && !normalizedPrompt.includes(normalized);
  });
  if (lostAnchors.length > 0) {
    throw new Error("转换改写了已确认的剧情或动作，请点击重试");
  }
  const sourceExpression = Array.isArray(source.expressionTimeline)
    ? source.expressionTimeline
    : [];
  const missingExpression = sourceExpression
    .map((item) => String(asRecord(item)?.timeRange ?? "").trim())
    .filter(
      (timeRange) => timeRange && !promptContainsTimeRange(prompt, timeRange),
    );
  if (missingExpression.length > 0) {
    throw new Error("转换遗漏了原方案的重要表情时段，请点击重试");
  }

  const sourcePlan = Array.isArray(source.uploadPlan)
    ? source.uploadPlan.flatMap((item) => (asRecord(item) ? [asRecord(item)!] : []))
    : [];
  const sourceRequired = Array.isArray(source.requiredAssets)
    ? source.requiredAssets.flatMap((item) =>
        asRecord(item) ? [asRecord(item)!] : [],
      )
    : [];
  const targetImagePlan = output.uploadPlan.filter((item) =>
    ["image", "generated"].includes(item.type),
  );
  if (target !== "text_only") {
    const sourceImagePlan = sourcePlan.filter((item) =>
      ["image", "generated"].includes(String(item.type)),
    );
    if (sourceImagePlan.length > 0) {
      const sourceKeys = sourceImagePlan.map((item) => String(item.assetKey)).sort();
      const targetKeys = targetImagePlan.map((item) => item.assetKey).sort();
      if (JSON.stringify(sourceKeys) !== JSON.stringify(targetKeys)) {
        throw new Error("转换擅自增加、删除或替换了原套餐的参考图片");
      }
      for (const sourceItem of sourceImagePlan) {
        const targetItem = targetImagePlan.find(
          (item) => item.assetKey === String(sourceItem.assetKey),
        );
        if (
          !targetItem ||
          targetItem.coreResponsibility !== String(sourceItem.coreResponsibility) ||
          targetItem.doNotReference !== String(sourceItem.doNotReference)
        ) {
          throw new Error("转换改变了已有参考图片的职责或禁止项");
        }
      }
    }
    for (const targetAsset of output.requiredAssets) {
      const sourceAsset = sourceRequired.find(
        (item) => String(item.assetKey) === targetAsset.assetKey,
      );
      if (!sourceAsset) continue;
      const sourceShape = {
        kind: String(sourceAsset.kind),
        status: String(sourceAsset.status),
        canGenerate: sourceAsset.canGenerate === true,
        generationPrompt: String(sourceAsset.generationPrompt),
        dependsOnAssetKeys: Array.isArray(sourceAsset.dependsOnAssetKeys)
          ? sourceAsset.dependsOnAssetKeys.map(String)
          : [],
      };
      const targetShape = {
        kind: targetAsset.kind,
        status: targetAsset.status,
        canGenerate: targetAsset.canGenerate,
        generationPrompt: targetAsset.generationPrompt,
        dependsOnAssetKeys: targetAsset.dependsOnAssetKeys,
      };
      if (JSON.stringify(sourceShape) !== JSON.stringify(targetShape)) {
        throw new Error("转换改变了已有参考图的生成规格，无法安全复用");
      }
    }
  }
  if (target === "text_only") {
    if (
      output.uploadPlan.length !== 0 ||
      output.requiredAssets.length !== 0 ||
      /@(图片|视频|音频)[1-9]\d*/u.test(prompt)
    ) {
      throw new Error("纯提示词套餐仍残留附件或 @引用");
    }
    return;
  }
  if (target === "images_text") {
    if (
      output.uploadPlan.length === 0 ||
      output.uploadPlan.some((item) => !["image", "generated"].includes(item.type)) ||
      /@(视频|音频)[1-9]\d*/u.test(prompt)
    ) {
      throw new Error("图片套餐混入了视频、音频或无可用图片");
    }
    return;
  }
  const referenceVideos = output.uploadPlan.filter(
    (item) => item.assetKey === "REFERENCE_VIDEO" && item.type === "video",
  );
  if (referenceVideos.length !== 1 || !prompt.includes(referenceVideos[0].reference)) {
    throw new Error("视频套餐没有唯一、明确绑定的参考视频");
  }
  if (targetImagePlan.length === 0) {
    throw new Error("视频 + 图片套餐没有包含任何参考图片");
  }
}

/**
 * Restore immutable attachment metadata from the accepted source package.
 * Conversion may change whether an asset is delivered and its @ number, but
 * it must not rewrite an adopted image's identity, exclusions, or generation
 * recipe merely because the model paraphrased those fields.
 */
export function stabilizeConvertedPackage(
  source: Record<string, unknown>,
  output: CodexDirectorOutput,
  target: ReferenceDeliveryMode,
): CodexDirectorOutput {
  if (target === "text_only") return output;
  const sourcePlan = Array.isArray(source.uploadPlan)
    ? source.uploadPlan.flatMap((item) => (asRecord(item) ? [asRecord(item)!] : []))
    : [];
  const sourceImages = new Map(
    sourcePlan
      .filter((item) => ["image", "generated"].includes(String(item.type)))
      .map((item) => [String(item.assetKey), item] as const),
  );
  const uploadPlan = output.uploadPlan.map((item) => {
    const original = sourceImages.get(item.assetKey);
    if (!original || !["image", "generated"].includes(item.type)) return item;
    return {
      ...item,
      displayName: String(original.displayName),
      coreResponsibility: String(original.coreResponsibility),
      doNotReference: String(original.doNotReference),
      timeRange: String(original.timeRange),
    };
  });

  const sourceRequired = Array.isArray(source.requiredAssets)
    ? source.requiredAssets.flatMap((item) =>
        asRecord(item) ? [asRecord(item)!] : [],
      )
    : [];
  const sourceRequiredByKey = new Map(
    sourceRequired.map((item) => [String(item.assetKey), item] as const),
  );
  const requiredAssets = output.requiredAssets.map((item) => {
    const original = sourceRequiredByKey.get(item.assetKey);
    if (!original || !sourceImages.has(item.assetKey)) return item;
    return {
      ...item,
      kind: String(original.kind),
      status: String(original.status),
      reason: String(original.reason ?? ""),
      generationPrompt: String(original.generationPrompt),
      canGenerate: original.canGenerate === true,
      dependsOnAssetKeys: Array.isArray(original.dependsOnAssetKeys)
        ? original.dependsOnAssetKeys.map(String)
        : [],
    } as DirectorRequiredAsset;
  });
  const presentRequired = new Set(requiredAssets.map((item) => item.assetKey));
  for (const item of uploadPlan) {
    const original = sourceRequiredByKey.get(item.assetKey);
    if (!original || presentRequired.has(item.assetKey)) continue;
    requiredAssets.push(original as unknown as DirectorRequiredAsset);
    presentRequired.add(item.assetKey);
  }
  const immutableBindings = uploadPlan.flatMap((item) =>
    sourceImages.has(item.assetKey)
      ? [
          {
            reference: item.reference,
            coreResponsibility: item.coreResponsibility,
            doNotReference: item.doNotReference,
          },
        ]
      : [],
  );
  const prompts = output.prompts.map((prompt) => ({
    ...prompt,
    content: forcePromptAssetBindings(prompt.content, immutableBindings),
  }));
  return { ...output, uploadPlan, requiredAssets, prompts };
}

function buildConvertedResult(
  sourceResult: Record<string, unknown>,
  sourceDirector: Record<string, unknown>,
  output: CodexDirectorOutput,
  threadId: string | null,
): Record<string, unknown> {
  const extra = asRecord(sourceResult.extra);
  if (!extra) throw new Error("原任务结果缺少导演交付数据");
  const preservedDirector = {
    ...output,
    routing: sourceDirector.routing,
    understanding: sourceDirector.understanding,
    qualityPlan: sourceDirector.qualityPlan,
    expressionTimeline: sourceDirector.expressionTimeline,
  };
  return {
    ...sourceResult,
    message: output.message,
    extra: {
      ...extra,
      codexThreadId: threadId,
      director: preservedDirector,
    },
  };
}

function failConversion(
  taskId: number,
  mode: ReferenceDeliveryMode,
  error: unknown,
): void {
  const message =
    error instanceof Error
      ? error.message
          .replace(/[A-Za-z]:[\\/][^\r\n"'`<>]*/g, "[服务器路径已隐藏]")
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(-1000)
      : "套餐转换没有完成";
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_delivery_packages
     SET status='failed', error=?, selected=0, finished_at=?, updated_at=?
     WHERE task_id=? AND delivery_mode=? AND status IN ('pending','running')`,
  ).run(message || "套餐转换没有完成", now, now, taskId, mode);
}

async function runConversion(
  taskId: number,
  mode: ReferenceDeliveryMode,
): Promise<void> {
  const workId = `delivery-package:${taskId}:${mode}`;
  const controller = new AbortController();
  activeControllers.set(workId, controller);
  const startedAt = new Date().toISOString();
  const started = db.prepare(
    `UPDATE task_delivery_packages
     SET status='running', started_at=?, error=NULL, updated_at=?
     WHERE task_id=? AND delivery_mode=? AND status='pending'`,
  ).run(startedAt, startedAt, taskId, mode);
  if (started.changes !== 1) {
    activeControllers.delete(workId);
    return;
  }
  try {
    const row = db
      .prepare(
        "SELECT * FROM task_delivery_packages WHERE task_id=? AND delivery_mode=?",
      )
      .get(taskId, mode) as unknown as TaskDeliveryPackageRow | undefined;
    const task = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(taskId) as unknown as TaskRow | undefined;
    if (!row || !task) throw new Error("任务或套餐记录不存在");
    assertConvertibleTask(task);
    const sourceResult = safeJsonParse(row.source_result_json);
    const sourceDirector = resultDirector(sourceResult);
    if (!sourceDirector || sourceDirector.status !== "ready") {
      throw new Error("原交付套餐不是可转换的完整方案");
    }
    const route = String(asRecord(sourceDirector.routing)?.mode ?? "") as DirectorRouteMode;
    if (!allowedModesForTask(task).includes(mode)) {
      throw new Error("当前创作方式不能安全交付原参考视频");
    }
    const evidenceDirectory = path.resolve(
      DATA_DIR,
      "task-runs",
      String(taskId),
      "evidence",
    );
    if (!fs.existsSync(evidenceDirectory)) {
      throw new Error("原任务的已验证素材清单已丢失，无法快速转换");
    }
    const video = task.video_id
      ? (db
          .prepare("SELECT * FROM videos WHERE id=?")
          .get(task.video_id) as unknown as VideoRow | undefined)
      : undefined;
    if (mode === "video_images_text" && !video) {
      throw new Error("当前任务没有参考视频，不能转换为视频套餐");
    }
    const currentParams = safeJsonParse(task.params_json);
    const ai = new AIClient(getSettings());
    const run = await ai.runDirector({
      skillName: routeSkill(route),
      taskId,
      videoName: task.video_name,
      videoPath: video ? getVideoPath(video.stored_name) : "",
      evidenceDirectory,
      contactSheetPath: fs.existsSync(path.join(evidenceDirectory, "contact_sheet.jpg"))
        ? path.join(evidenceDirectory, "contact_sheet.jpg")
        : null,
      params: {
        ...currentParams,
        analysisConfirmed: true,
        referenceDelivery: mode,
        hasReferenceVideo: Boolean(video),
        forceReferenceVideoDelivery: mode === "video_images_text",
        confirmedRouting: sourceDirector.routing,
        confirmedUnderstanding: sourceDirector.understanding,
        confirmedQualityPlan: sourceDirector.qualityPlan,
        deliveryConversionSource: sourceDirector,
      },
      assets: linkedAssets(taskId),
      reasoningEffort: "low",
      signal: controller.signal,
    });
    const stabilizedOutput = stabilizeConvertedPackage(
      sourceDirector,
      run.output,
      mode,
    );
    assertConvertedPackage(sourceDirector, stabilizedOutput, mode);
    const convertedResult = buildConvertedResult(
      sourceResult,
      sourceDirector,
      stabilizedOutput,
      run.threadId,
    );
    const resultJson = JSON.stringify(convertedResult);
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db
        .prepare(
          `SELECT status FROM task_delivery_packages
           WHERE task_id=? AND delivery_mode=?`,
        )
        .get(taskId, mode) as unknown as { status: string } | undefined;
      if (current?.status !== "running") {
        db.exec("ROLLBACK");
        return;
      }
      db.prepare("UPDATE task_delivery_packages SET selected=0 WHERE task_id=?").run(
        taskId,
      );
      const packageUpdate = db.prepare(
        `UPDATE task_delivery_packages
         SET status='succeeded', result_json=?, error=NULL, selected=1,
             finished_at=?, updated_at=?
         WHERE task_id=? AND delivery_mode=? AND status='running'`,
      ).run(resultJson, now, now, taskId, mode);
      const latestTask = db
        .prepare("SELECT params_json FROM tasks WHERE id=? AND status='succeeded'")
        .get(taskId) as unknown as { params_json: string } | undefined;
      if (!latestTask || packageUpdate.changes !== 1) {
        throw new Error("转换完成时任务状态已变化");
      }
      const taskUpdate = db.prepare(
        `UPDATE tasks SET params_json=?, result_json=?, message='交付内容已转换',
                          asset_schedule_complete=0
         WHERE id=? AND status='succeeded'`,
      ).run(updateTaskParamsMode(latestTask.params_json, mode), resultJson, taskId);
      if (taskUpdate.changes !== 1) throw new Error("转换结果没有保存成功");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const refreshed = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(taskId) as unknown as TaskRow;
    schedulePackageAssets(refreshed, convertedResult);
    logAudit(
      row.requested_by || row.created_by,
      "task_delivery_package_complete",
      `任务 #${taskId} 已转换为 ${mode}`,
    );
  } catch (error) {
    failConversion(taskId, mode, error);
    const row = db
      .prepare(
        "SELECT requested_by, created_by FROM task_delivery_packages WHERE task_id=? AND delivery_mode=?",
      )
      .get(taskId, mode) as unknown as
      | { requested_by: string; created_by: string }
      | undefined;
    logAudit(
      row?.requested_by || row?.created_by || "system",
      "task_delivery_package_failed",
      `任务 #${taskId} 转换为 ${mode} 失败`,
    );
  } finally {
    activeControllers.delete(workId);
  }
}

function enqueueConversion(
  taskId: number,
  mode: ReferenceDeliveryMode,
  owner: string,
  priority = 0,
): void {
  const workId = `delivery-package:${taskId}:${mode}`;
  const queued = enqueueWork({
    id: workId,
    owner,
    kind: "delivery_conversion",
    priority,
    isStillValid: () => {
      const row = db
        .prepare(
          `SELECT status FROM task_delivery_packages
           WHERE task_id=? AND delivery_mode=?`,
        )
        .get(taskId, mode) as unknown as { status: string } | undefined;
      return row?.status === "pending";
    },
    run: () => runConversion(taskId, mode),
    cancel: () => controllerFor(workId)?.abort(new Error("套餐转换已取消")),
    onRemoved: () => {
      failConversion(taskId, mode, new Error("套餐转换已取消"));
    },
  });
  if (!queued && !isWorkQueuedOrActive(workId)) {
    failConversion(taskId, mode, new Error("套餐转换没有进入队列"));
    throw new DeliveryPackageRequestError("转换队列暂时不可用，请重试", 503);
  }
}

function controllerFor(workId: string): AbortController | undefined {
  return activeControllers.get(workId);
}

export function requestDeliveryPackage(options: {
  taskId: number;
  targetMode: ReferenceDeliveryMode;
  actor: string;
}): { queued: boolean; message: string; state: TaskDeliveryPackageState } {
  let task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(options.taskId) as unknown as TaskRow | undefined;
  if (!task) throw new DeliveryPackageRequestError("任务不存在", 404);
  const activeTranslation = db
    .prepare(
      `SELECT 1 FROM task_prompt_translations
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(task.id);
  if (activeTranslation) {
    throw new DeliveryPackageRequestError(
      "英文版正在生成；可先取消翻译，再切换交付内容",
      409,
    );
  }
  assertConvertibleTask(task);
  ensureInitialPackage(task);
  const allowed = allowedModesForTask(task);
  if (!allowed.includes(options.targetMode)) {
    const route = routeFromTask(task);
    const message = !task.video_id
      ? "这个任务没有参考视频，可选择纯提示词或图片 + 提示词"
      : route === "ORIGINAL" || route === "VIRAL_ADAPTATION"
        ? "这个方案是原创或爆点迁移，原视频只用于分析，不适合作为成片参考；可选择纯提示词或图片 + 提示词"
        : "当前方案不适合把原视频交给视频模型";
    throw new DeliveryPackageRequestError(message, 409);
  }
  const current = selectedPackage(task.id);
  if (current?.delivery_mode === options.targetMode) {
    return {
      queued: false,
      message: "当前已经是这个交付内容",
      state: getTaskDeliveryPackageState(task),
    };
  }
  const active = db
    .prepare(
      `SELECT * FROM task_delivery_packages
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(task.id) as unknown as TaskDeliveryPackageRow | undefined;
  if (active) {
    if (active.delivery_mode !== options.targetMode) {
      throw new DeliveryPackageRequestError(
        "另一个交付内容正在转换，完成后再切换",
        409,
      );
    }
    return {
      queued: true,
      message: active.status === "running" ? "正在转换" : "已在转换队列中",
      state: getTaskDeliveryPackageState(task),
    };
  }
  const cached = db
    .prepare(
      `SELECT * FROM task_delivery_packages
       WHERE task_id=? AND delivery_mode=? AND status='succeeded'
         AND result_json IS NOT NULL`,
    )
    .get(task.id, options.targetMode) as unknown as
    | TaskDeliveryPackageRow
    | undefined;
  if (cached) {
    applyCachedPackage(task, cached);
    task = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(task.id) as unknown as TaskRow;
    logAudit(
      options.actor,
      "task_delivery_package_select",
      `任务 #${task.id} 切换到缓存套餐 ${options.targetMode}`,
    );
    return {
      queued: false,
      message: "已立即切换",
      state: getTaskDeliveryPackageState(task),
    };
  }

  const waitsForAttachments = hasActiveAttachmentWork(task.id);

  const ownerActive = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks
          WHERE created_by=? AND status IN ('pending','running')) +
         (SELECT COUNT(*) FROM task_delivery_packages
          WHERE created_by=? AND status IN ('pending','running')) +
         (SELECT COUNT(*) FROM task_prompt_translations
          WHERE created_by=? AND status IN ('pending','running')) AS count`,
    )
    .get(task.created_by, task.created_by, task.created_by) as unknown as { count: number };
  if (Number(ownerActive.count) >= MAX_ACTIVE_WORK_PER_USER) {
    throw new DeliveryPackageRequestError(
      "你已有两个任务或转换在排队，请完成一个后再切换",
      429,
    );
  }
  const globalActive = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running')) +
         (SELECT COUNT(*) FROM task_delivery_packages
          WHERE status IN ('pending','running')) +
         (SELECT COUNT(*) FROM task_prompt_translations
          WHERE status IN ('pending','running')) AS count`,
    )
    .get() as unknown as { count: number };
  if (Number(globalActive.count) >= MAX_ACTIVE_WORK_GLOBAL) {
    throw new DeliveryPackageRequestError("服务器任务队列已满，请稍后再试", 429);
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const freshTask = db
      .prepare("SELECT * FROM tasks WHERE id=? AND status='succeeded'")
      .get(task.id) as unknown as TaskRow | undefined;
    if (!freshTask?.result_json) {
      throw new DeliveryPackageRequestError("任务状态已变化，请刷新后重试", 409);
    }
    const concurrent = db
      .prepare(
        `SELECT 1 FROM task_delivery_packages
         WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
      )
      .get(task.id);
    if (concurrent) {
      throw new DeliveryPackageRequestError("交付内容已经在转换", 409);
    }
    db.prepare(
      `INSERT INTO task_delivery_packages
        (task_id, delivery_mode, status, source_result_json, result_json,
         error, selected, created_by, requested_by, created_at, started_at,
         finished_at, updated_at)
       VALUES (?, ?, 'pending', ?, NULL, NULL, 0, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(task_id, delivery_mode) DO UPDATE SET
         status='pending', source_result_json=excluded.source_result_json,
         result_json=NULL, error=NULL, selected=0,
         requested_by=excluded.requested_by, started_at=NULL,
         finished_at=NULL, updated_at=excluded.updated_at`,
    ).run(
      task.id,
      options.targetMode,
      preferredConversionSource(freshTask, options.targetMode),
      freshTask.created_by,
      options.actor,
      now,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Keep the click as a durable request. When this task still has attachment
  // work, the shared per-owner scheduler finishes those priority-2 jobs first
  // and then performs this priority-3 conversion automatically.
  enqueueConversion(
    task.id,
    options.targetMode,
    task.created_by,
    waitsForAttachments ? 3 : 0,
  );
  logAudit(
    options.actor,
    "task_delivery_package_request",
    `任务 #${task.id} 请求转换为 ${options.targetMode}`,
  );
  return {
    queued: true,
    message: waitsForAttachments
      ? "已排队，当前附件完成后会自动转换"
      : "已开始快速转换，原结果会一直保留",
    state: getTaskDeliveryPackageState(task),
  };
}

export function cancelDeliveryPackageConversion(options: {
  taskId: number;
  actor: string;
}): TaskDeliveryPackageState {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(options.taskId) as unknown as TaskRow | undefined;
  if (!task) throw new DeliveryPackageRequestError("任务不存在", 404);
  const active = db
    .prepare(
      `SELECT * FROM task_delivery_packages
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(task.id) as unknown as TaskDeliveryPackageRow | undefined;
  if (!active) {
    throw new DeliveryPackageRequestError("当前没有正在转换的交付内容", 409);
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_delivery_packages
     SET status='failed', error='已取消切换，原结果保留', selected=0,
         finished_at=?, updated_at=?
     WHERE task_id=? AND delivery_mode=? AND status IN ('pending','running')`,
  ).run(now, now, task.id, active.delivery_mode);
  cancelWork(`delivery-package:${task.id}:${active.delivery_mode}`);
  logAudit(
    options.actor,
    "task_delivery_package_cancel",
    `取消任务 #${task.id} 的套餐转换`,
  );
  return getTaskDeliveryPackageState(task);
}

export function isDeliveryPackageConversionActiveForTask(taskId: number): boolean {
  const dbActive = db
    .prepare(
      `SELECT 1 FROM task_delivery_packages
       WHERE task_id=? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(taskId);
  if (dbActive) return true;
  return DELIVERY_MODES.some((mode) =>
    isWorkQueuedOrActive(`delivery-package:${taskId}:${mode}`),
  );
}
