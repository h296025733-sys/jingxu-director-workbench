import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import { canManageTask } from "@/lib/permissions";
import { scheduleTask } from "@/lib/tasks";
import { logAudit } from "@/lib/audit";
import { safeJsonParse } from "@/lib/storage";
import { recordTaskInstruction } from "@/lib/task-instruction-history";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail("任务编号无效", 400);
  }
  const body = await readJson(req, 16 * 1024);
  const note = String(body.note ?? "").trim();
  const action = String(body.action ?? "confirm");
  if (note.length > 3000) return fail("补充内容不能超过 3000 字", 400);
  if (action !== "confirm" && action !== "revise") {
    return fail("操作无效", 400);
  }
  if (action === "revise" && !note) {
    return fail("请先写下需要纠正的地方", 400);
  }

  let updatedParams: Record<string, unknown> = {};
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as unknown as TaskRow | undefined;
    if (!task) {
      db.exec("ROLLBACK");
      return fail("任务不存在", 404);
    }
    if (!canManageTask(user, task.created_by)) {
      db.exec("ROLLBACK");
      return fail("任务不存在", 404);
    }
    if (
      task.feature_id !== "video_breakdown" &&
      task.feature_id !== "video_replication" &&
      task.feature_id !== "omni_video"
    ) {
      db.exec("ROLLBACK");
      return fail("这个任务不需要确认创作理解", 409);
    }
    if (task.status !== "awaiting_confirmation" || !task.result_json) {
      db.exec("ROLLBACK");
      return fail("当前任务不在确认阶段", 409);
    }
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
      .get(task.created_by, task.created_by, task.created_by) as unknown as { count: number };
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
    if (Number(userActive.count) >= 2 || Number(globalActive.count) >= 8) {
      db.exec("ROLLBACK");
      return fail("当前制作队列已满，请等一个任务完成后再继续", 429);
    }
    const result = safeJsonParse(task.result_json);
    const director =
      typeof result.extra === "object" && result.extra
        ? (result.extra as Record<string, unknown>).director
        : null;
    const understanding =
      typeof director === "object" && director
        ? (director as Record<string, unknown>).understanding
        : null;
    const qualityPlan =
      typeof director === "object" && director
        ? (director as Record<string, unknown>).qualityPlan
        : null;
    const routing =
      typeof director === "object" && director
        ? (director as Record<string, unknown>).routing
        : null;
    const currentParams = safeJsonParse(task.params_json);
    updatedParams =
      action === "revise"
        ? {
            ...currentParams,
            analysisConfirmed: false,
            analysisNotes: note,
            previousUnderstanding: understanding,
            previousQualityPlan: qualityPlan,
            previousRouting: routing,
            confirmedUnderstanding: undefined,
            confirmedQualityPlan: undefined,
            confirmedRouting: undefined,
          }
        : {
            ...currentParams,
            analysisConfirmed: true,
            confirmedUnderstanding: understanding,
            confirmedQualityPlan: qualityPlan,
            confirmedRouting: routing,
          };
    const queuedMessage =
      action === "revise"
        ? "收到补充，正在重新理解"
        : "方向已确认，正在排队制作";
    const updated = db.prepare(
      `UPDATE tasks
       SET params_json = ?, status = 'pending', progress = 0,
           message = ?, result_json = NULL,
           error = NULL, started_at = NULL, finished_at = NULL,
           asset_schedule_complete = 0
       WHERE id = ? AND status = 'awaiting_confirmation'`,
    ).run(JSON.stringify(updatedParams), queuedMessage, taskId);
    if (updated.changes !== 1) {
      db.exec("ROLLBACK");
      return fail("任务状态已变化，请刷新后再试", 409);
    }
    if (action === "revise") {
      recordTaskInstruction({
        taskId,
        createdBy: task.created_by,
        kind: "revision",
        instruction: note,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleTask(taskId);
  logAudit(
    user.username,
    action === "revise" ? "task_analysis_revise" : "task_analysis_confirm",
    `${action === "revise" ? "纠正" : "确认"}任务 #${taskId} 的创作理解`,
  );
  return ok({
    message:
      action === "revise"
        ? "收到，我会先重新讲一遍自己的理解"
        : "方向已确认，开始制作提示词和附件",
  });
});
