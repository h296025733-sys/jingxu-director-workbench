import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { canManageTask } from "@/lib/permissions";
import {
  createReferencePreparationAttempt,
  listReferencePreparations,
  ReferencePreparationRequestError,
} from "@/lib/reference-preparations";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function parseTaskId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const GET = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = parseTaskId(id);
  if (!taskId) return fail("任务编号无效", 400);
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) return fail("任务不存在", 404);
  return ok({ preparations: listReferencePreparations(taskId) });
});

export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = parseTaskId(id);
  if (!taskId) return fail("任务编号无效", 400);
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) return fail("任务不存在", 404);
  if (!canManageTask(user, task.created_by)) {
    return fail("只能处理自己任务的参考视频", 403);
  }
  try {
    const preparation = createReferencePreparationAttempt({
      taskId,
      createdBy: user.username,
    });
    logAudit(
      user.username,
      "reference_video_prepare",
      `任务 #${taskId} · 去身份动作参考 · 版本 ${preparation.version}`,
    );
    return ok({ preparation, message: "参考视频已进入本地处理队列" });
  } catch (error) {
    if (error instanceof ReferencePreparationRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
