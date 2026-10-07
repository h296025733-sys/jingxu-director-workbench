import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, withAuth } from "@/lib/api";
import { canManageTask } from "@/lib/permissions";
import {
  cancelTaskPromptTranslation,
  PromptTranslationRequestError,
  requestTaskPromptTranslation,
} from "@/lib/prompt-translations";
import type { TaskRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function taskForUser(taskId: number, username: string, isAdmin: boolean): TaskRow | null {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task || (!isAdmin && task.created_by !== username)) return null;
  return task;
}

export const POST = withAuth<Ctx>(async (_req, ctx, user) => {
  const taskId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return fail("任务编号无效", 400);
  const task = taskForUser(taskId, user.username, user.isAdmin);
  if (!task || !canManageTask(user, task.created_by)) return fail("任务不存在", 404);
  try {
    const result = requestTaskPromptTranslation({ taskId, actor: user.username });
    return NextResponse.json(
      { message: result.message, promptTranslation: result.state },
      { status: result.queued ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof PromptTranslationRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const taskId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return fail("任务编号无效", 400);
  const task = taskForUser(taskId, user.username, user.isAdmin);
  if (!task || !canManageTask(user, task.created_by)) return fail("任务不存在", 404);
  try {
    const state = cancelTaskPromptTranslation({ taskId, actor: user.username });
    return NextResponse.json({ message: "已取消翻译，中文仍可使用", promptTranslation: state });
  } catch (error) {
    if (error instanceof PromptTranslationRequestError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
});

