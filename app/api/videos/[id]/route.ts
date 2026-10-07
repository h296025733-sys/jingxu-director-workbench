import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getThumbnailPath, getVideoPath } from "@/lib/storage";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import { toVideoOut } from "@/lib/dto";
import { canManageVideo } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { deleteTaskRunDirectory } from "@/lib/task-run-storage";
import { isTaskExecutionActive } from "@/lib/tasks";
import { isReferenceImageGenerationActiveForTask } from "@/lib/generated-images";
import { isReferencePreparationActiveForTask } from "@/lib/reference-preparations";
import { isDeliveryPackageConversionActiveForTask } from "@/lib/delivery-packages";
import { isPromptTranslationActiveForTask } from "@/lib/prompt-translations";
import type { TaskRow, VideoRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const VIDEO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validVideoId(id: string): boolean {
  return VIDEO_ID_PATTERN.test(id);
}

export const GET = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) return fail("视频不存在", 404);
  return ok({
    video: toVideoOut(row, canManageVideo(user, row.uploaded_by)),
  });
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);

  const moved: { original: string; tombstone: string }[] = [];
  const deletedTaskIds: number[] = [];
  let deletedVideo: VideoRow | undefined;
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    deletedVideo = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get(id) as unknown as VideoRow | undefined;
    if (!deletedVideo) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("视频不存在", 404);
    }
    if (!canManageVideo(user, deletedVideo.uploaded_by)) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("只能删除自己上传的视频", 403);
    }
    if (db.prepare("SELECT 1 FROM watermark_batch_items WHERE video_id=? AND status='waiting' LIMIT 1").get(id)) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("这个视频已加入去水印批量清单，请先取消待处理记录", 409);
    }
    const usedByVoice = db.prepare(`SELECT 1 FROM personal_voices, json_each(personal_voices.source_ids_json) AS source
      WHERE source.value=? LIMIT 1`).get(id);
    if (usedByVoice) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("这个文件已保存为个人音色的来源，暂不能删除；归档音色不会删除其来源", 409);
    }
    const relatedTasks = db
      .prepare(
        "SELECT * FROM tasks WHERE video_id = ? OR secondary_video_id = ? OR (CASE WHEN json_valid(params_json) THEN json_extract(params_json, '$.voiceReferenceVideoId') END) = ? ORDER BY id",
      )
      .all(id, id, id) as unknown as TaskRow[];
    for (const task of relatedTasks) {
      if (
        task.status === "pending" ||
        task.status === "running" ||
        isTaskExecutionActive(task.id) ||
        isReferenceImageGenerationActiveForTask(task.id) ||
        isReferencePreparationActiveForTask(task.id) ||
        isDeliveryPackageConversionActiveForTask(task.id) ||
        isPromptTranslationActiveForTask(task.id)
      ) {
        db.exec("ROLLBACK");
        transactionStarted = false;
        return fail("这个视频还有任务正在处理，请先取消并等待它结束", 409);
      }
    }

    const candidates = [
      getVideoPath(deletedVideo.stored_name),
      getThumbnailPath(deletedVideo.id),
    ].filter((value): value is string => Boolean(value));
    for (const original of candidates) {
      if (!fs.existsSync(/* turbopackIgnore: true */ original)) continue;
      const tombstone = `${original}.delete-${randomUUID()}`;
      fs.renameSync(/* turbopackIgnore: true */ original, tombstone);
      moved.push({ original, tombstone });
    }
    for (const task of relatedTasks) {
      db.prepare("DELETE FROM task_reference_preparations WHERE task_id = ?").run(
        task.id,
      );
      db.prepare("DELETE FROM task_generated_images WHERE task_id = ?").run(task.id);
      db.prepare("DELETE FROM task_delivery_packages WHERE task_id = ?").run(task.id);
      db.prepare("DELETE FROM task_prompt_translations WHERE task_id = ?").run(task.id);
      db.prepare("DELETE FROM task_assets WHERE task_id = ?").run(task.id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
      deletedTaskIds.push(task.id);
    }
    db.prepare("DELETE FROM videos WHERE id = ?").run(id);
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    for (const item of [...moved].reverse()) {
      try {
        if (
          fs.existsSync(/* turbopackIgnore: true */ item.tombstone) &&
          !fs.existsSync(/* turbopackIgnore: true */ item.original)
        ) {
          fs.renameSync(/* turbopackIgnore: true */ item.tombstone, item.original);
        }
      } catch {
        // The audit/error log from withAuth preserves the primary failure.
      }
    }
    throw error;
  }

  let cleanupWarning = "";
  for (const item of moved) {
    try {
      fs.rmSync(/* turbopackIgnore: true */ item.tombstone, { force: true });
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : String(error);
    }
  }
  for (const taskId of deletedTaskIds) {
    try {
      deleteTaskRunDirectory(taskId);
    } catch (error) {
      console.error(`[导演工作台] 视频删除后清理任务 #${taskId} 产物失败：`, error);
      cleanupWarning ||= "关联任务附件清理失败";
    }
  }
  if (!deletedVideo) throw new Error("视频删除事务未返回记录");
  logAudit(
    user.username,
    "video_delete",
    cleanupWarning
      ? `删除视频 ${deletedVideo.original_name} 及 ${deletedTaskIds.length} 个关联任务；清理异常：${cleanupWarning.slice(0, 300)}`
      : `删除视频 ${deletedVideo.original_name} 及 ${deletedTaskIds.length} 个关联任务`,
  );
  return ok({
    message: cleanupWarning ? "视频记录已删除，但临时文件清理失败，请联系管理员" : "已删除",
  });
});

export const PUT = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) {
    return fail("只能修改自己上传的视频", 403);
  }

  const body = await readJson(req);
  const rawTags = Array.isArray(body.tags) ? body.tags : [];
  const tags = rawTags
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((t) => t.slice(0, 20));
  db.prepare("UPDATE videos SET tags = ? WHERE id = ?").run(
    tags.join(","),
    id,
  );
  const updated = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow;
  return ok({ video: toVideoOut(updated, true) });
});
