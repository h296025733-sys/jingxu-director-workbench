import { db } from "@/lib/db";
import { MAX_PENDING_WORK_GLOBAL } from "@/lib/concurrency-config";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import { toTaskOut, toTaskSummaryOut } from "@/lib/dto";
import { recoverAutomaticAssetSchedules, scheduleTask } from "@/lib/tasks";
import { getFeature } from "@/features/registry";
import { ownedVoice, verifiedPersonalReference } from "@/lib/personal-voices";
import { canManageTask } from "@/lib/permissions";
import {
  extractInputReferenceMentions,
  inputImageLabel,
  inputVideoLabel,
  parseInputImageLabels,
} from "@/lib/input-reference-labels";
import { recordTaskInstruction } from "@/lib/task-instruction-history";
import { autoEditTranscriptValidationError } from "./auto-edit-params";
import { getEditTemplate, normalizePreviewVoice, previewVoiceGender } from "@/lib/edit-templates";
import type { AssetRow, TaskRow, VideoRow } from "@/lib/types";

interface AssetLink {
  assetId: string;
  fieldKey: string;
  position: number;
}

interface CreatorRow {
  username: string;
  display_name: string;
}

const MAX_ACTIVE_TASKS_PER_USER = 2;
const MAX_ACTIVE_TASKS_GLOBAL = MAX_PENDING_WORK_GLOBAL;

function isMissingRequired(value: unknown, type: string): boolean {
  if (type === "boolean") return value !== true;
  if (type === "file") return !Array.isArray(value) || value.length === 0;
  return value === undefined || value === null || String(value).trim() === "";
}

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  recoverAutomaticAssetSchedules();
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const summaryColumns = `id, video_id, video_name, secondary_video_id,
    secondary_video_name, feature_id,
    CASE
      WHEN feature_id = 'auto_edit' THEN params_json
      WHEN instr(params_json, '"analysisConfirmed":true') > 0
        THEN '{"analysisConfirmed":true}'
      ELSE '{}'
    END AS params_json,
    status, edit_narration_status, progress, message, error, created_by, created_at, started_at,
    finished_at, 0 AS asset_schedule_complete, NULL AS result_json`;
  const rows = (user.isAdmin
    ? status
      ? db.prepare(`SELECT ${summaryColumns} FROM tasks WHERE status = ? ORDER BY id DESC`).all(status)
      : db.prepare(`SELECT ${summaryColumns} FROM tasks ORDER BY id DESC`).all()
    : status
      ? db
          .prepare(
            `SELECT ${summaryColumns} FROM tasks WHERE created_by = ? AND status = ? ORDER BY id DESC`,
          )
          .all(user.username, status)
      : db
          .prepare(`SELECT ${summaryColumns} FROM tasks WHERE created_by = ? ORDER BY id DESC`)
          .all(user.username)) as unknown as TaskRow[];
  const creatorNames = user.isAdmin
    ? new Map(
        (
          db.prepare("SELECT username, display_name FROM users").all() as unknown as CreatorRow[]
        ).map((creator) => [creator.username, creator.display_name]),
      )
    : null;
  return ok({
    tasks: rows.map((row) =>
      toTaskSummaryOut(
        row,
        canManageTask(user, row.created_by),
        user.isAdmin,
        creatorNames?.get(row.created_by),
      ),
    ),
  });
});

export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req);
  const videoId = String(body.videoId ?? "").trim();
  const featureId = String(body.featureId ?? "").trim();
  if (featureId === "voice_clone") return fail("请在声音克隆页面选择个人音色后生成配音");
  const submittedParams =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const secondaryVideoId = featureId === "auto_edit"
    ? String(submittedParams.secondaryVideoId ?? "").trim()
    : "";
  const voiceReferenceVideoId = featureId === "auto_edit"
    ? String(submittedParams.voiceReferenceVideoId ?? "").trim()
    : "";

  const feature = getFeature(featureId);
  if (!feature) return fail("功能不存在或未注册");
  const allowsNoVideo = featureId === "omni_video";

  const video = videoId
    ? (db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(videoId) as unknown as VideoRow | undefined)
    : undefined;
  if (!video && !allowsNoVideo) return fail("请选择有效的视频");
  if (videoId && !video) return fail("请选择有效的视频");
  if (video && !video.mime_type.startsWith("video/")) {
    return fail("主素材必须是视频文件");
  }
  if (video && !user.isAdmin && video.uploaded_by !== user.username) {
    return fail("请选择自己上传的视频", 403);
  }
  const secondaryVideo = secondaryVideoId
    ? (db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(secondaryVideoId) as unknown as VideoRow | undefined)
    : undefined;
  if (secondaryVideoId && !secondaryVideo) return fail("请选择有效的第二段视频");
  if (secondaryVideo && !secondaryVideo.mime_type.startsWith("video/")) {
    return fail("第二段素材必须是视频文件");
  }
  if (secondaryVideo && !user.isAdmin && secondaryVideo.uploaded_by !== user.username) {
    return fail("第二段视频必须是自己上传的", 403);
  }
  if (secondaryVideoId && secondaryVideoId === videoId) {
    return fail("两段视频不能选择同一个文件");
  }
  const voiceReferenceVideo = voiceReferenceVideoId
    ? (db.prepare("SELECT * FROM videos WHERE id = ?").get(voiceReferenceVideoId) as unknown as VideoRow | undefined)
    : undefined;
  if (voiceReferenceVideoId && !voiceReferenceVideo) return fail("克隆音源文件不存在，请重新选择");
  if (
    voiceReferenceVideo &&
    !voiceReferenceVideo.mime_type.startsWith("video/") &&
    !voiceReferenceVideo.mime_type.startsWith("audio/")
  ) {
    return fail("克隆音源只支持视频或音频文件");
  }
  if (voiceReferenceVideo && !user.isAdmin && voiceReferenceVideo.uploaded_by !== user.username) {
    return fail("请选择自己上传的克隆音源文件", 403);
  }
  if (voiceReferenceVideoId && submittedParams.editVoice !== "narration") return fail("先开启画外解说，再选择克隆音源");

  const normalizedParams: Record<string, unknown> = {};
  const assetLinks: AssetLink[] = [];
  const requiredKeys = new Set(feature.inputSchema.required ?? []);
  let totalTextChars = 0;

  for (const [key, field] of Object.entries(feature.inputSchema.properties)) {
    const submitted = submittedParams[key];
    if (field.type === "file") {
      const ids = Array.isArray(submitted)
        ? submitted.map(String).map((id) => id.trim()).filter(Boolean)
        : typeof submitted === "string" && submitted.trim()
          ? [submitted.trim()]
          : [];
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length !== ids.length) return fail(`「${field.title}」包含重复素材`);
      const maxFiles = Math.max(1, field.maxFiles ?? (field.multiple ? 8 : 1));
      if (ids.length > maxFiles) return fail(`「${field.title}」最多上传 ${maxFiles} 个文件`);
      if (!field.multiple && ids.length > 1) return fail(`「${field.title}」只能上传 1 个文件`);

      for (const [position, assetId] of ids.entries()) {
        const asset = db
          .prepare("SELECT * FROM assets WHERE id = ?")
          .get(assetId) as unknown as AssetRow | undefined;
        if (!asset || asset.uploaded_by !== user.username) {
          return fail(`「${field.title}」包含无权使用或不存在的素材`);
        }
        if (!asset.mime_type.startsWith("image/")) {
          return fail(`「${field.title}」只允许图片素材`);
        }
        assetLinks.push({ assetId, fieldKey: key, position });
      }
      normalizedParams[key] = ids;
    } else if (submitted !== undefined) {
      if (field.type === "boolean") {
        if (typeof submitted !== "boolean") return fail(`「${field.title}」必须是确认开关`);
        normalizedParams[key] = submitted;
      } else if (field.type === "number") {
        const numberValue = Number(submitted);
        if (!Number.isFinite(numberValue)) return fail(`「${field.title}」必须是有效数字`);
        if (field.min !== undefined && numberValue < field.min) {
          return fail(`「${field.title}」不能小于 ${field.min}`);
        }
        if (field.max !== undefined && numberValue > field.max) {
          return fail(`「${field.title}」不能大于 ${field.max}`);
        }
        normalizedParams[key] = numberValue;
      } else if (field.type === "select") {
        if (typeof submitted !== "string") return fail(`「${field.title}」选项无效`);
        const allowed = field.enum?.map((option) => option.value) ?? [];
        if (allowed.length > 0 && !allowed.includes(submitted)) {
          return fail(`「${field.title}」选项无效`);
        }
        normalizedParams[key] = submitted;
      } else {
        if (typeof submitted !== "string") return fail(`「${field.title}」必须是文本`);
        const text = submitted.trim();
        const fieldLimit = field.type === "string" ? 1000 : 12000;
        if (text.length > fieldLimit) {
          return fail(`「${field.title}」超过 ${fieldLimit} 字符上限`);
        }
        totalTextChars += text.length;
        if (totalTextChars > 40000) {
          return fail("任务文本参数总长度超过 40000 字符上限");
        }
        normalizedParams[key] = text;
      }
    } else if (field.default !== undefined) {
      normalizedParams[key] = field.default;
    }

    if (requiredKeys.has(key) || field.required) {
      if (isMissingRequired(normalizedParams[key], field.type)) {
        return fail(`请填写或确认「${field.title}」`);
      }
    }
  }
  if (featureId === "auto_edit") {
    const personalVoiceId = String(submittedParams.personalVoiceId ?? "").trim();
    if (personalVoiceId) {
      if (voiceReferenceVideoId) return fail("个人音色和临时上传音源只能选择一种");
      if (normalizedParams.editVoice !== "narration") return fail("选择个人音色需要开启画外解说");
      if (!ownedVoice(personalVoiceId, user.username)) return fail("个人音色不存在", 400);
      try { verifiedPersonalReference(personalVoiceId, user.username); }
      catch { return fail("个人音色尚未准备好，请先在声音克隆页面生成一次试听", 400); }
    }
    normalizedParams.personalVoiceId = personalVoiceId;
    normalizedParams.secondaryVideoId = secondaryVideoId;
    normalizedParams.voiceReferenceVideoId = voiceReferenceVideoId;
    const selectedVoiceProfile = normalizePreviewVoice(
      Object.prototype.hasOwnProperty.call(submittedParams, "editVoiceProfile")
        ? normalizedParams.editVoiceProfile
        : undefined,
      normalizedParams.editNarrator,
    );
    normalizedParams.editVoiceProfile = selectedVoiceProfile;
    normalizedParams.editNarrator = previewVoiceGender(selectedVoiceProfile);
    const template = getEditTemplate(normalizedParams.editTemplateId);
    if (template) normalizedParams.captionStyle = template.captionStyle;
  }

  if (
    typeof normalizedParams.duration === "number" &&
    normalizedParams.duration > 15 &&
    normalizedParams.continuity === "single"
  ) {
    return fail("成片超过 15 秒时，请选择自动判断或分段生成后拼接");
  }
  if (
    featureId === "auto_edit" &&
    typeof normalizedParams.editTargetDuration === "number" &&
    normalizedParams.editTargetDuration > 0 &&
    normalizedParams.editTargetDuration < 4
  ) {
    return fail("目标时长请填 0（自动），或填写 4 到 600 秒");
  }
  const transcriptValidationError = autoEditTranscriptValidationError(
    featureId,
    normalizedParams,
  );
  if (transcriptValidationError) {
    return fail(transcriptValidationError, 400);
  }
  if (!video && normalizedParams.referenceDelivery === "video_images_text") {
    return fail("选择参考视频交付前，请先添加一条参考视频");
  }

  const imageCount = assetLinks.filter(
    (asset) => asset.fieldKey === "referenceImages",
  ).length;
  let inputImageLabels = parseInputImageLabels(
    normalizedParams.inputReferenceLabels,
    imageCount,
  );
  if (!inputImageLabels) {
    if (submittedParams.inputReferenceLabels !== undefined) {
      return fail("图片编号与实际图片不一致，请重新选择图片");
    }
    inputImageLabels = Array.from({ length: imageCount }, (_, index) =>
      inputImageLabel(index + 1),
    );
  }
  normalizedParams.inputReferenceLabels = JSON.stringify(inputImageLabels);
  const allowedInputImages = new Set(inputImageLabels);
  const brief = String(normalizedParams.brief ?? "");
  const allowedInputVideos = new Set<string>();
  if (video) allowedInputVideos.add(inputVideoLabel(1));
  if (featureId === "auto_edit" && secondaryVideo) {
    allowedInputVideos.add(inputVideoLabel(2));
  }
  for (const mention of extractInputReferenceMentions(brief)) {
    if (mention.type === "image" && !allowedInputImages.has(mention.label)) {
      return fail(`需求里的「${mention.label}」没有对应图片`);
    }
    if (mention.type === "video" && !allowedInputVideos.has(mention.label)) {
      if (mention.number > 2) {
        return fail("自动剪辑最多支持 2 条视频，请使用「参考视频1」或「参考视频2」");
      }
      return fail(`需求里提到了「${mention.label}」，请先添加对应视频`);
    }
  }

  const paramsJson = JSON.stringify(normalizedParams);
  let taskId = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const lockedVideo = video
      ? (db
          .prepare("SELECT * FROM videos WHERE id = ?")
          .get(video.id) as unknown as VideoRow | undefined)
      : undefined;
    const lockedSecondaryVideo = secondaryVideo
      ? (db
          .prepare("SELECT * FROM videos WHERE id = ?")
          .get(secondaryVideo.id) as unknown as VideoRow | undefined)
      : undefined;
    if (video && !lockedVideo) {
      db.exec("ROLLBACK");
      return fail("参考视频已被删除，请重新选择", 409);
    }
    if (secondaryVideo && !lockedSecondaryVideo) {
      db.exec("ROLLBACK");
      return fail("第二段视频已被删除，请重新选择", 409);
    }
    if (voiceReferenceVideo && !db.prepare("SELECT 1 FROM videos WHERE id = ? AND uploaded_by = ?").get(voiceReferenceVideo.id, voiceReferenceVideo.uploaded_by)) {
      db.exec("ROLLBACK");
      return fail("克隆音源文件已被删除，请重新选择", 409);
    }
    const lockedAsset = db.prepare(
      "SELECT uploaded_by, mime_type FROM assets WHERE id = ?",
    );
    for (const assetLink of assetLinks) {
      const asset = lockedAsset.get(assetLink.assetId) as unknown as
        | { uploaded_by: string; mime_type: string }
        | undefined;
      if (
        !asset ||
        asset.uploaded_by !== user.username ||
        !asset.mime_type.startsWith("image/")
      ) {
        db.exec("ROLLBACK");
        return fail("参考图已被删除或权限已变更，请重新选择", 409);
      }
    }
    const userActive = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks
            WHERE created_by=? AND status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_delivery_packages
            WHERE created_by=? AND status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_prompt_translations
            WHERE created_by=? AND status IN ('pending','running')) AS count`,
      )
      .get(user.username, user.username, user.username) as unknown as { count: number };
    if (Number(userActive.count) >= MAX_ACTIVE_TASKS_PER_USER) {
      db.exec("ROLLBACK");
      return fail(`每位用户最多同时保留 ${MAX_ACTIVE_TASKS_PER_USER} 个排队或运行任务`, 429);
    }
    const globalActive = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_delivery_packages
            WHERE status IN ('pending','running')) +
           (SELECT COUNT(*) FROM task_prompt_translations
            WHERE status IN ('pending','running')) AS count`,
      )
      .get() as unknown as { count: number };
    if (Number(globalActive.count) >= MAX_ACTIVE_TASKS_GLOBAL) {
      db.exec("ROLLBACK");
      return fail("服务器导演任务队列已满，请稍后再试", 429);
    }
    const duplicate = db
      .prepare(
        `SELECT id FROM tasks
         WHERE created_by = ? AND video_id = ? AND secondary_video_id = ?
           AND feature_id = ? AND params_json = ?
           AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .get(
        user.username,
        lockedVideo?.id ?? "",
        lockedSecondaryVideo?.id ?? "",
        featureId,
        paramsJson,
      ) as unknown as
      | { id: number }
      | undefined;
    if (duplicate) {
      db.exec("ROLLBACK");
      return fail(`相同参数的任务 #${duplicate.id} 已在排队或运行，请勿重复提交`, 409);
    }
    const createdAt = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO tasks (
           video_id, video_name, secondary_video_id, secondary_video_name,
           feature_id, params_json, status, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        lockedVideo?.id ?? "",
        lockedVideo?.original_name ?? "文字与图片创作",
        lockedSecondaryVideo?.id ?? "",
        lockedSecondaryVideo?.original_name ?? "",
        featureId,
        paramsJson,
        user.username,
        createdAt,
      );
    taskId = Number(info.lastInsertRowid);
    recordTaskInstruction({
      taskId,
      createdBy: user.username,
      kind: "create",
      instruction: brief,
      createdAt,
    });
    const link = db.prepare(
      "INSERT INTO task_assets (task_id, asset_id, field_key, position) VALUES (?, ?, ?, ?)",
    );
    for (const asset of assetLinks) {
      link.run(taskId, asset.assetId, asset.fieldKey, asset.position);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleTask(taskId);

  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow;
  return ok({ task: toTaskOut(row, true) });
});
