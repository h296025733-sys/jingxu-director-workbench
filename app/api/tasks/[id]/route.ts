import { db } from "@/lib/db";
import { fail, ok, withAuth } from "@/lib/api";
import { toTaskOut } from "@/lib/dto";
import { canManageTask } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { deleteTaskRunDirectory } from "@/lib/task-run-storage";
import { isTaskExecutionActive } from "@/lib/tasks";
import { isReferenceImageGenerationActiveForTask } from "@/lib/generated-images";
import { isReferencePreparationActiveForTask } from "@/lib/reference-preparations";
import {
  getTaskDeliveryPackageState,
  isDeliveryPackageConversionActiveForTask,
} from "@/lib/delivery-packages";
import { safeJsonParse } from "@/lib/storage";
import {
  getTaskPromptTranslationState,
  isPromptTranslationActiveForTask,
} from "@/lib/prompt-translations";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function hasConvertibleDirectorResult(resultJson: string): boolean {
  const result = safeJsonParse(resultJson);
  const extra =
    result.extra && typeof result.extra === "object" && !Array.isArray(result.extra)
      ? (result.extra as Record<string, unknown>)
      : null;
  const directorValue = extra?.director ?? result.director;
  const director =
    directorValue && typeof directorValue === "object" && !Array.isArray(directorValue)
      ? (directorValue as Record<string, unknown>)
      : null;
  return (
    director?.status === "ready" &&
    Array.isArray(director.prompts) &&
    director.prompts.length === 1
  );
}

export const GET = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(Number(id)) as unknown as TaskRow | undefined;
  if (!row) return fail("任务不存在", 404);
  if (!canManageTask(user, row.created_by)) return fail("任务不存在", 404);
  const creator = user.isAdmin
    ? (db
        .prepare("SELECT display_name FROM users WHERE username = ?")
        .get(row.created_by) as unknown as { display_name: string } | undefined)
    : undefined;
  let effectiveRow = row;
  let deliveryPackage: ReturnType<typeof getTaskDeliveryPackageState> | undefined;
  if (
    row.status === "succeeded" &&
    row.result_json &&
    hasConvertibleDirectorResult(row.result_json)
  ) {
    deliveryPackage = getTaskDeliveryPackageState(row);
    effectiveRow = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(row.id) as unknown as TaskRow;
  }
  const task = toTaskOut(
    effectiveRow,
    canManageTask(user, effectiveRow.created_by),
    user.isAdmin,
    creator?.display_name,
  );
  if (deliveryPackage) task.deliveryPackage = deliveryPackage;
  if (
    effectiveRow.status === "succeeded" &&
    effectiveRow.result_json &&
    hasConvertibleDirectorResult(effectiveRow.result_json)
  ) {
    task.promptTranslation = getTaskPromptTranslationState(effectiveRow);
  }
  return ok({
    task,
  });
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(Number(id)) as unknown as TaskRow | undefined;
  if (!row) return fail("任务不存在", 404);
  if (!canManageTask(user, row.created_by)) {
    return fail("只能删除自己创建的任务", 403);
  }
  if (row.status === "pending" || row.status === "running") {
    return fail("请先取消正在排队或运行的任务，再执行删除", 409);
  }
  if (isTaskExecutionActive(row.id)) {
    return fail("任务正在结束本地进程，请稍后再删除", 409);
  }
  if (isReferenceImageGenerationActiveForTask(row.id)) {
    return fail("任务的参考图仍在排队或生成中，请完成后再删除", 409);
  }
  if (isReferencePreparationActiveForTask(row.id)) {
    return fail("任务的参考视频仍在排队或处理中，请完成后再删除", 409);
  }
  if (isDeliveryPackageConversionActiveForTask(row.id)) {
    return fail("任务正在切换交付内容，请完成或取消后再删除", 409);
  }
  if (isPromptTranslationActiveForTask(row.id)) {
    return fail("任务正在翻译英文提示词，请完成或取消后再删除", 409);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM task_reference_preparations WHERE task_id = ?").run(
      row.id,
    );
    db.prepare("DELETE FROM task_delivery_packages WHERE task_id = ?").run(row.id);
    db.prepare("DELETE FROM task_prompt_translations WHERE task_id = ?").run(row.id);
    db.prepare("DELETE FROM task_generated_images WHERE task_id = ?").run(row.id);
    db.prepare("DELETE FROM task_assets WHERE task_id = ?").run(row.id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    deleteTaskRunDirectory(row.id);
  } catch (error) {
    console.error(`[导演工作台] 任务 #${row.id} 记录已删除，但产物目录清理失败`, error);
  }
  logAudit(user.username, "task_delete", `删除任务 #${row.id}`);
  return ok({ message: "已删除" });
});
