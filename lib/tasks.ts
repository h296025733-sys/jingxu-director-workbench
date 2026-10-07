import fs from "node:fs";
import path from "node:path";
import { getSettings, AIClient } from "./ai";
import { getFeature } from "@/features/registry";
import { getAssetPath, getVideoPath, safeJsonParse } from "./storage";
import { DATA_DIR } from "./paths";
import { db } from "./db";
import { narrationStatusFromResult } from "./narration-delivery-status";
import { verifiedPersonalReference } from "./personal-voices";
import { scheduleAutomaticReferenceImages } from "./generated-images";
import { scheduleAutomaticReferencePreparation } from "./reference-preparations";
import { cancelWork, enqueueWork, isWorkQueuedOrActive } from "./work-scheduler";
import type { FeatureAsset } from "@/features/base";
import type { AssetRow, TaskRow, VideoRow } from "./types";

interface LinkedAssetRow extends AssetRow {
  field_key: string;
  position: number;
}

const activeControllers = new Map<number, AbortController>();
const AUTOMATIC_ASSET_RECOVERY_INTERVAL_MS = 30_000;
let lastAutomaticAssetRecoveryAt = 0;

function safeTaskFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    /stream disconnected|transport error|network error|error decoding response body|连接.*(?:中断|断开)|网络.*(?:中断|断开)/i.test(
      raw,
    )
  ) {
    return "网络中断了，素材已经保留。点击“自动修正并继续”即可重新生成，不用再次上传。";
  }
  if (/usage limit|insufficient[_ ]quota|quota|额度/i.test(raw)) {
    return "生成服务的可用额度不足，原要求和素材已保留。请管理员恢复额度后继续，不用重复提交。";
  }
  if (/unauthori[sz]ed|authentication|token.{0,16}expired|login required|\b401\b/i.test(raw)) {
    return "生成服务登录已失效，原要求和素材已保留。请管理员重新登录后继续。";
  }
  if (/rate.?limit|\b429\b/i.test(raw)) {
    return "生成服务暂时限流，原要求和素材已保留，稍后可继续。";
  }
  if (/\b(?:SQLITE_|ENOENT|EACCES|EPERM|EBUSY)\b/i.test(raw)) {
    return "任务执行遇到服务器内部错误，请联系管理员";
  }
  const sanitized = raw
    .replace(/file:\/\/[A-Za-z]:[\\/][^\s"'`<>]*/gi, "[服务器路径已隐藏]")
    .replace(/\\\\[^\s"'`<>]+(?:[\\/][^\s"'`<>]*)*/g, "[服务器路径已隐藏]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'`<>]*/g, "[服务器路径已隐藏]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(-1200);
  return sanitized || "任务没有完成，但素材已经保留。点击“自动修正并继续”。";
}

export function scheduleTask(taskId: number): void {
  const task = db
    .prepare("SELECT created_by, status, params_json, feature_id FROM tasks WHERE id = ?")
    .get(taskId) as unknown as
    | {
        created_by: string;
        status: string;
        params_json: string;
        feature_id: string;
      }
    | undefined;
  if (!task || task.status !== "pending") return;
  const understandingOnly = safeJsonParse(task.params_json).analysisConfirmed !== true;
  const workKind = task.feature_id === "voice_clone" ? "voice" : ["auto_edit", "watermark_removal"].includes(task.feature_id)
    ? "editing"
    : understandingOnly
      ? "understanding"
      : "director";
  enqueueWork({
    id: `task:${taskId}`,
    owner: task.created_by,
    kind: workKind,
    priority: workKind === "editing" ? 2 : understandingOnly ? 0 : 1,
    isStillValid: () => {
      const current = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(taskId) as unknown as { status: string } | undefined;
      return current?.status === "pending";
    },
    run: () => runTask(taskId),
    cancel: () => {
      activeControllers.get(taskId)?.abort(new Error("任务已被用户取消"));
    },
  });
}

/** 取消真实的本地取证进程 / Codex 子进程，而不只是修改数据库状态。 */
export function abortTaskExecution(taskId: number): boolean {
  const removedOrSignaled = cancelWork(`task:${taskId}`);
  const controller = activeControllers.get(taskId);
  if (controller) controller.abort(new Error("任务已被用户取消"));
  return removedOrSignaled || Boolean(controller);
}

/** True until a running task has finished tearing down its child processes. */
export function isTaskExecutionActive(taskId: number): boolean {
  return activeControllers.has(taskId) || isWorkQueuedOrActive(`task:${taskId}`);
}

function stableAssetKey(fieldKey: string, position: number): string {
  const normalized = fieldKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized || "ASSET"}_${position + 1}`;
}

function linkedAssets(taskId: number): FeatureAsset[] {
  const rows = db
    .prepare(
      `SELECT a.*, ta.field_key, ta.position
       FROM task_assets ta
       JOIN assets a ON a.id = ta.asset_id
       WHERE ta.task_id = ?
       ORDER BY ta.field_key, ta.position`,
    )
    .all(taskId) as unknown as LinkedAssetRow[];
  return rows.map((row) => ({
    id: row.id,
    fieldKey: row.field_key,
    key: stableAssetKey(row.field_key, row.position),
    name: row.original_name,
    path: getAssetPath(row.stored_name),
    mimeType: row.mime_type,
    url: `/api/assets/${encodeURIComponent(row.id)}/file`,
  }));
}

export async function runTask(taskId: number): Promise<void> {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task || task.status === "canceled") return;

  const video = task.video_id
    ? (db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(task.video_id) as unknown as VideoRow | undefined)
    : undefined;
  const secondaryVideo = task.secondary_video_id
    ? (db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(task.secondary_video_id) as unknown as VideoRow | undefined)
    : undefined;
  const taskParams = safeJsonParse(task.params_json);
  const voiceReferenceVideoId = task.feature_id === "auto_edit" ? String(taskParams.voiceReferenceVideoId ?? "") : "";
  const voiceReferenceVideo = voiceReferenceVideoId
    ? (db.prepare("SELECT * FROM videos WHERE id = ?").get(voiceReferenceVideoId) as unknown as VideoRow | undefined)
    : undefined;
  const controller = new AbortController();
  activeControllers.set(taskId, controller);

  const started = db.prepare(
    `UPDATE tasks SET status = 'running', started_at = ?, progress = 5, message = '任务已启动'
     WHERE id = ? AND status = 'pending'`,
  ).run(new Date().toISOString(), taskId);
  if (started.changes !== 1) {
    activeControllers.delete(taskId);
    return;
  }

  try {
    const feature = getFeature(task.feature_id);
    if (!feature) throw new Error(`功能「${task.feature_id}」未注册`);
    if (!video && !["omni_video", "voice_clone"].includes(task.feature_id)) {
      throw new Error("参考视频记录不存在");
    }
    if (task.secondary_video_id && !secondaryVideo) {
      throw new Error("第二段视频记录不存在");
    }
    if (voiceReferenceVideoId && !voiceReferenceVideo) throw new Error("克隆音源文件已被删除，请重新选择");
    const videoPath = video ? getVideoPath(video.stored_name) : "";
    if (video && !fs.existsSync(videoPath)) {
      throw new Error("参考视频文件已丢失");
    }
    const secondaryVideoPath = secondaryVideo
      ? getVideoPath(secondaryVideo.stored_name)
      : "";
    if (secondaryVideo && !fs.existsSync(secondaryVideoPath)) {
      throw new Error("第二段视频文件已丢失");
    }
    const voiceReferenceVideoPath = voiceReferenceVideo ? getVideoPath(voiceReferenceVideo.stored_name) : "";
    if (voiceReferenceVideo && !fs.existsSync(voiceReferenceVideoPath)) throw new Error("克隆音源文件已丢失");

    const outputDir = path.resolve(DATA_DIR, "task-runs", String(taskId));
    const expectedPrefix = `${path.resolve(DATA_DIR, "task-runs")}${path.sep}`;
    if (!outputDir.startsWith(expectedPrefix)) throw new Error("任务产物目录无效");
    fs.mkdirSync(outputDir, { recursive: true });

    const ai = new AIClient(getSettings());
    const context = {
      taskId,
      createdBy: task.created_by,
      preparedVoiceReferenceDir: task.feature_id === "auto_edit" && taskParams.personalVoiceId
        ? verifiedPersonalReference(String(taskParams.personalVoiceId), task.created_by, true) : undefined,
      videoId: task.video_id,
      videoPath,
      videoName: task.video_name,
      secondaryVideoId: task.secondary_video_id,
      secondaryVideoPath,
      secondaryVideoName: task.secondary_video_name,
      voiceReferenceVideoPath,
      outputDir,
      params: taskParams,
      assets: linkedAssets(taskId),
      ai,
      signal: controller.signal,
      updateProgress: (percent: number, message?: string) => {
        const pct = Math.max(0, Math.min(99, Math.round(percent)));
        db.prepare(
          "UPDATE tasks SET progress = ?, message = ? WHERE id = ? AND status = 'running'",
        ).run(pct, message ?? null, taskId);
      },
    };

    const result = await feature.run(context);
    const current = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as unknown as { status: string } | undefined;
    if (!current || current.status === "canceled") return;

    const params = safeJsonParse(task.params_json);
    const director =
      result.extra && typeof result.extra.director === "object"
        ? (result.extra.director as Record<string, unknown>)
        : null;
    const directorNeedsInput = director?.status === "needs_input";
    const needsDirectionConfirmation =
      (task.feature_id === "video_breakdown" ||
        task.feature_id === "video_replication" ||
        task.feature_id === "omni_video") &&
      (params.analysisConfirmed !== true || directorNeedsInput);
    if (needsDirectionConfirmation) {
      db.prepare(
        `UPDATE tasks SET status = 'awaiting_confirmation', progress = 100,
                          message = '先确认我有没有理解对', result_json = ?,
                          asset_schedule_complete = 0, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(JSON.stringify(result), new Date().toISOString(), taskId);
      return;
    }

    const completed = db.prepare(
      `UPDATE tasks SET status = 'succeeded', progress = 100, message = ?, result_json = ?,
                        asset_schedule_complete = 0, edit_narration_status = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      result.message ?? "完成",
      JSON.stringify(result),
      task.feature_id === "auto_edit" ? narrationStatusFromResult(taskParams, result) ?? null : null,
      new Date().toISOString(),
      taskId,
    );
    if (completed.changes === 1 && ["auto_edit", "watermark_removal", "voice_clone"].includes(task.feature_id)) {
      db.prepare(
        "UPDATE tasks SET asset_schedule_complete=1 WHERE id=? AND status='succeeded'",
      ).run(taskId);
    } else if (completed.changes === 1) {
      let schedulingSucceeded = true;
      try {
        scheduleAutomaticReferenceImages({
          taskId,
          createdBy: task.created_by,
          result,
        });
      } catch (error) {
        schedulingSucceeded = false;
        // The director result remains valid even when image scheduling itself fails.
        // Keep the raw diagnostic server-side; the UI can still offer a manual retry.
        console.error(
          `[导演工作台] 任务 #${taskId} 自动参考图排队失败：`,
          error,
        );
      }
      try {
        scheduleAutomaticReferencePreparation({
          taskId,
          createdBy: task.created_by,
          result,
        });
      } catch (error) {
        schedulingSucceeded = false;
        // The director report remains available even if local media preparation
        // could not be queued. The task owner can retry from the result panel.
        console.error(
          `[导演工作台] 任务 #${taskId} 自动参考视频处理排队失败：`,
          error,
        );
      }
      if (schedulingSucceeded) {
        db.prepare(
          "UPDATE tasks SET asset_schedule_complete=1 WHERE id=? AND status='succeeded'",
        ).run(taskId);
      }
    }
  } catch (error) {
    const current = db
      .prepare("SELECT status, progress FROM tasks WHERE id = ?")
      .get(taskId) as unknown as { status: string; progress: number } | undefined;
    if (!current || current.status === "canceled") return;
    console.error(`[导演工作台] 任务 #${taskId} 执行失败：`, error);
    const message = safeTaskFailure(error);
    db.prepare(
      `UPDATE tasks SET status = 'failed', progress = ?, message = ?, error = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      Math.max(current.progress, 10),
      message,
      message,
      new Date().toISOString(),
      taskId,
    );
  } finally {
    activeControllers.delete(taskId);
  }
}

/**
 * Repairs the tiny crash window between saving a successful director result
 * and queueing its automatic images/reference-video preparation. Existing
 * pre-feature tasks were marked complete by the migration and are not charged.
 */
export function recoverAutomaticAssetSchedules(): number {
  const now = Date.now();
  if (now - lastAutomaticAssetRecoveryAt < AUTOMATIC_ASSET_RECOVERY_INTERVAL_MS) {
    return 0;
  }
  lastAutomaticAssetRecoveryAt = now;
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status='succeeded' AND result_json IS NOT NULL AND asset_schedule_complete=0
       ORDER BY id ASC LIMIT 20`,
    )
    .all() as unknown as TaskRow[];
  let recovered = 0;
  for (const row of rows) {
    try {
      if (["auto_edit", "watermark_removal", "voice_clone"].includes(row.feature_id)) {
        db.prepare(
          "UPDATE tasks SET asset_schedule_complete=1 WHERE id=? AND asset_schedule_complete=0",
        ).run(row.id);
        recovered += 1;
        continue;
      }
      const result = safeJsonParse(row.result_json ?? "{}");
      scheduleAutomaticReferenceImages({
        taskId: row.id,
        createdBy: row.created_by,
        result,
      });
      scheduleAutomaticReferencePreparation({
        taskId: row.id,
        createdBy: row.created_by,
        result,
      });
      db.prepare(
        "UPDATE tasks SET asset_schedule_complete=1 WHERE id=? AND asset_schedule_complete=0",
      ).run(row.id);
      recovered += 1;
    } catch (error) {
      console.error(`[导演工作台] 恢复任务 #${row.id} 的自动素材排队失败：`, error);
    }
  }
  return recovered;
}
