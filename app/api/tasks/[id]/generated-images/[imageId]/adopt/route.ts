import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  adoptGeneratedImage,
  GeneratedImageRequestError,
} from "@/lib/generated-images";
import { canManageTask } from "@/lib/permissions";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string; imageId: string }> };

export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id, imageId } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail("任务编号无效", 400);
  }
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) {
    return fail("只能验收自己任务的参考图", 403);
  }
  try {
    const image = adoptGeneratedImage({ taskId, imageId });
    logAudit(
      user.username,
      "reference_image_adopt",
      `任务 #${taskId} · ${image.assetKey} · 版本 ${image.version}`,
    );
    return ok({ image, message: "已采用此图并更新实际上传顺序" });
  } catch (error) {
    if (error instanceof GeneratedImageRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
