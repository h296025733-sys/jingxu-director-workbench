import { fail, ok, readJson, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  createGeneratedImageAttempt,
  GeneratedImageRequestError,
  listGeneratedImages,
} from "@/lib/generated-images";
import { canManageTask } from "@/lib/permissions";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function taskIdFrom(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const GET = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = taskIdFrom(id);
  if (!taskId) return fail("任务编号无效", 400);
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) return fail("任务不存在", 404);
  return ok({ images: listGeneratedImages(taskId) });
});

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = taskIdFrom(id);
  if (!taskId) return fail("任务编号无效", 400);
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) {
    return fail("只能为自己创建的任务生成或重做参考图", 403);
  }
  const body = await readJson(req, 8 * 1024);
  const assetKey = String(body.assetKey ?? "").trim();
  if (!assetKey) return fail("请选择要生成的缺失素材", 400);
  try {
    const image = createGeneratedImageAttempt({
      taskId,
      assetKey,
      createdBy: user.username,
    });
    logAudit(
      user.username,
      "reference_image_generate",
      `任务 #${taskId} · ${assetKey} · 版本 ${image.version}`,
    );
    return ok({ image, message: "参考图已进入生成队列" });
  } catch (error) {
    if (error instanceof GeneratedImageRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
