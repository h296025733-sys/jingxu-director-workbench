import { db } from "@/lib/db";
import { MAX_PENDING_WORK_GLOBAL } from "@/lib/concurrency-config";
import { fail, ok, withAuth } from "@/lib/api";
import { toTaskOut } from "@/lib/dto";
import { scheduleTask } from "@/lib/tasks";
import { getFeature } from "@/features/registry";
import { canManageTask } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import type { TaskRow } from "@/lib/types";
import {
  reuseVideoEvidenceForRetry,
  shouldReuseVideoEvidenceForRetry,
} from "@/lib/video-evidence";
import { isDeliveryPackageConversionActiveForTask } from "@/lib/delivery-packages";
import { normalizeAutoEditTranscriptForRetry } from "../../auto-edit-params";

type Ctx = { params: Promise<{ id: string }> };

const MAX_ACTIVE_TASKS_PER_USER = 2;
const MAX_ACTIVE_TASKS_GLOBAL = MAX_PENDING_WORK_GLOBAL;

function normalizeRetryParams(
  paramsJson: string,
  feature: NonNullable<ReturnType<typeof getFeature>>,
): string {
  let params: Record<string, unknown>;
  try {
    const parsed = JSON.parse(paramsJson) as unknown;
    params =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
  } catch {
    params = {};
  }

  // A retry may come from an older form. Keep the confirmed creative phase,
  // but never revive choices that the current feature no longer offers.
  for (const [key, field] of Object.entries(feature.inputSchema.properties)) {
    if (field.type !== "select") continue;
    const allowed = field.enum?.map((option) => option.value) ?? [];
    if (typeof params[key] === "string" && allowed.includes(params[key] as string)) {
      continue;
    }
    if (field.default !== undefined) params[key] = field.default;
    else delete params[key];
  }
  params = normalizeAutoEditTranscriptForRetry(feature.id, params);
  delete params.resolution;
  delete params.aspectRatio;
  delete params.rightsConfirmed;
  return JSON.stringify(params);
}

/**
 * 重试任务：以原视频、原功能、原参数创建一个新任务。
 * 适用于失败、取消或已完成的任务（相当于再跑一次）。
 */
export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(Number(id)) as unknown as TaskRow | undefined;
  if (!row) return fail("任务不存在", 404);
  if (row.feature_id === "voice_clone" && row.created_by !== user.username) return fail("个人音色只能由所属账号使用", 403);
  if (!canManageTask(user, row.created_by)) {
    return fail("只能重试自己创建的任务", 403);
  }
  if (row.status === "pending" || row.status === "running") {
    return fail("排队或运行中的任务不能重试，请等待完成或先取消", 409);
  }
  if (isDeliveryPackageConversionActiveForTask(row.id)) {
    return fail("任务正在切换交付内容，请完成或取消后再重试", 409);
  }

  const feature = getFeature(row.feature_id);
  if (!feature) return fail("功能「" + row.feature_id + "」未注册", 400);
  const retryParamsJson = normalizeRetryParams(row.params_json, feature);

  let taskId = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const userActive = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks
            WHERE created_by=? AND status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_delivery_packages
            WHERE created_by=? AND status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_prompt_translations
            WHERE created_by=? AND status IN ('pending','running')) AS count`,
      )
      .get(user.username, user.username, user.username) as unknown as { count: number };
    if (Number(userActive.count) >= MAX_ACTIVE_TASKS_PER_USER) {
      db.exec("ROLLBACK");
      return fail(`每位用户最多同时保留 ${MAX_ACTIVE_TASKS_PER_USER} 个排队或运行任务`, 429);
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
    if (Number(globalActive.count) >= MAX_ACTIVE_TASKS_GLOBAL) {
      db.exec("ROLLBACK");
      return fail("服务器导演任务队列已满，请稍后再试", 429);
    }
    const duplicate = db
      .prepare(
        `SELECT id FROM tasks
         WHERE created_by = ? AND video_id = ? AND secondary_video_id = ?
           AND feature_id = ? AND params_json = ?
           AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .get(
        user.username,
        row.video_id,
        row.secondary_video_id,
        row.feature_id,
        retryParamsJson,
      ) as unknown as
      | { id: number }
      | undefined;
    if (duplicate) {
      db.exec("ROLLBACK");
      return fail(`相同参数的任务 #${duplicate.id} 已在排队或运行，请勿重复重试`, 409);
    }
    const info = db
      .prepare(
        `INSERT INTO tasks (
           video_id, video_name, secondary_video_id, secondary_video_name,
           feature_id, params_json, status, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        row.video_id,
        row.video_name,
        row.secondary_video_id,
        row.secondary_video_name,
        row.feature_id,
        retryParamsJson,
        user.username,
        new Date().toISOString(),
      );
    taskId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO task_assets (task_id, asset_id, field_key, position)
       SELECT ?, asset_id, field_key, position FROM task_assets WHERE task_id = ?`,
    ).run(taskId, row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (shouldReuseVideoEvidenceForRetry(row.video_id, retryParamsJson)) {
    try {
      reuseVideoEvidenceForRetry(row.id, taskId);
    } catch (error) {
      // Evidence reuse is only a speed path. A rejected/partial source must fall
      // back to normal local extraction, never make the retry fail.
      console.error("[Director Workbench] Retry evidence reuse skipped:", error);
    }
  }
  scheduleTask(taskId);

  const created = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow;
  logAudit(user.username, "task_retry", `重试任务 #${row.id} -> 新任务 #${taskId}`);
  return ok({ task: toTaskOut(created, true), message: "已重新创建任务" });
});
