import { db } from "@/lib/db";
import { fail, ok, withAuth } from "@/lib/api";
import { toTaskOut } from "@/lib/dto";
import { canManageTask } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { abortTaskExecution } from "@/lib/tasks";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(Number(id)) as unknown as TaskRow | undefined;
  if (!row) return fail("任务不存在", 404);
  if (!canManageTask(user, row.created_by)) {
    return fail("只能取消自己创建的任务", 403);
  }
  if (row.status !== "pending" && row.status !== "running") {
    return fail("当前状态的任务不能取消");
  }
  const canceled = db.prepare(
    `UPDATE tasks SET status = 'canceled', message = '已被用户取消', finished_at = ?
     WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(new Date().toISOString(), row.id);
  if (canceled.changes !== 1) {
    return fail("任务状态已变化，无法取消", 409);
  }
  abortTaskExecution(row.id);
  logAudit(user.username, "task_cancel", `取消任务 #${row.id}`);
  const updated = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(row.id) as unknown as TaskRow;
  return ok({ task: toTaskOut(updated, true) });
});
