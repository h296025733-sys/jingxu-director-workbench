import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { canManageTask } from "@/lib/permissions";
import {
  adoptReferencePreparation,
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
    return fail("只能验收自己任务的参考视频", 403);
  }
  try {
    const preparation = adoptReferencePreparation({ taskId, preparationId });
    logAudit(
      user.username,
      "reference_video_adopt",
      `任务 #${taskId} · 去身份动作参考 · 版本 ${preparation.version}`,
    );
    return ok({
      preparation,
      message: "已采用此处理版，实际素材上传顺序已更新",
    });
  } catch (error) {
    if (error instanceof ReferencePreparationRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
