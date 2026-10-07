import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, readJson, withAuth } from "@/lib/api";
import { canManageTask } from "@/lib/permissions";
import {
  cancelDeliveryPackageConversion,
  DeliveryPackageRequestError,
  parseDeliveryMode,
  requestDeliveryPackage,
} from "@/lib/delivery-packages";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function taskForUser(taskId: number, username: string, isAdmin: boolean): TaskRow | null {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task || (!isAdmin && task.created_by !== username)) return null;
  return task;
}

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail("任务编号无效", 400);
  }
  const task = taskForUser(taskId, user.username, user.isAdmin);
  if (!task || !canManageTask(user, task.created_by)) {
    return fail("任务不存在", 404);
  }
  const body = await readJson(req, 4 * 1024);
  const targetMode = parseDeliveryMode(body.targetMode);
  if (!targetMode) return fail("交付内容无效", 400);
  try {
    const result = requestDeliveryPackage({
      taskId,
      targetMode,
      actor: user.username,
    });
    return NextResponse.json(
      {
        message: result.message,
        deliveryPackage: result.state,
      },
      { status: result.queued ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof DeliveryPackageRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail("任务编号无效", 400);
  }
  const task = taskForUser(taskId, user.username, user.isAdmin);
  if (!task || !canManageTask(user, task.created_by)) {
    return fail("任务不存在", 404);
  }
  try {
    const state = cancelDeliveryPackageConversion({
      taskId,
      actor: user.username,
    });
    return NextResponse.json({
      message: "已取消切换，原结果仍可使用",
      deliveryPackage: state,
    });
  } catch (error) {
    if (error instanceof DeliveryPackageRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});
