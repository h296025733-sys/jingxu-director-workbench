import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { canManageTask } from "@/lib/permissions";
import {
  cancelReferencePreparationAttempt,
  ReferencePreparationRequestError,
} from "@/lib/reference-preparations";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string; preparationId: string }> };

export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id, preparationId } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail("任务编号无效", 400);
  }
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) {
    return fail("只能取消自己任务的视频处理", 403);
  }
  try {
    const preparation = cancelReferencePreparationAttempt({ taskId, preparationId });
    logAudit(user.username, "reference_video_cancel", `任务 #${taskId} · 去身份动作参考`);
    return ok({ preparation, message: "已取消视频处理" });
  } catch (error) {
    if (error instanceof ReferencePreparationRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
