import { getFeature } from "@/features/registry";
import { normalizeNarrationStatus } from "./narration-delivery-status";
import { safeJsonParse } from "./storage";
import { selectFinalSeedancePrompt } from "./seedance-prompt-display";
import { getEditTemplate, EDIT_TEMPLATE_VERSION } from "./edit-templates";
import type {
  TaskOut,
  TaskRow,
  UserOut,
  UserRow,
  VideoOut,
  VideoRow,
} from "./types";

export function toUserOut(row: UserRow): UserOut {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    disabled: row.disabled === 1,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
  };
}

export function toVideoOut(row: VideoRow, canDelete = false): VideoOut {
  return {
    id: row.id,
    name: row.original_name,
    size: row.size_bytes,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
    uploadedBy: row.uploaded_by,
    canDelete,
    taskCount: Number(row.task_count ?? 0),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function employeeTaskError(value: string | null): string | null {
  if (!value) return null;
  if (
    /stream disconnected|transport error|network error|error decoding response body|连接.*(?:中断|断开)|网络.*(?:中断|断开)/i.test(
      value,
    )
  ) {
    return "网络中断了，素材已经保留。点击“自动修正并继续”即可重新生成，不用再次上传。";
  }
  if (/usage limit|quota|rate.?limit|额度/i.test(value)) {
    return "生成服务暂时繁忙，素材已经保留。稍后点击“自动修正并继续”。";
  }
  if (/quality|质量门禁|输出计划|不一致|剧情节拍|爆点迁移|复刻硬锁/i.test(value)) {
    const nextStep = /产品|product|素材|图片|视频|@/i.test(value)
      ? "若再次出现，请在要求里写清哪张图片或视频负责什么。"
      : /复刻|硬锁|动作|镜头|运镜|节奏/i.test(value)
        ? "若再次出现，请补一句必须保留的动作、镜头或节奏。"
        : /爆点|钩子|剧情|开场/i.test(value)
          ? "若再次出现，请补一句最想保留的开场、剧情或爆点。"
          : "若再次出现，请把最重要的要求补成一句话。";
    return `系统没有把关键要求写牢，未把半成品交给你。点击“自动修正并继续”；${nextStep}`;
  }
  return value.length > 240
    ? "任务没有完成，但素材已经保留。点击“自动修正并继续”；若仍失败，请联系管理员。"
    : value;
}

/**
 * Employee task detail is a delivery view, not a mirror of the persisted
 * director/debug record. Keep only fields the simple result UI consumes.
 */
function toEmployeeTaskResult(value: Record<string, unknown>): Record<string, unknown> {
  const extra = asRecord(value.extra);
  const director = asRecord(extra?.director);
  const finalPrompt = selectFinalSeedancePrompt(
    Array.isArray(director?.prompts)
      ? director.prompts.flatMap((entry) => {
          const prompt = asRecord(entry);
          return prompt
            ? [{
                title: String(prompt.title ?? ""),
                purpose: String(prompt.purpose ?? ""),
                content: String(prompt.content ?? ""),
              }]
            : [];
        })
      : [],
  );
  const safeDirector = director
    ? {
        status: director.status,
        executionCard: director.executionCard,
        prompts: finalPrompt ? [finalPrompt] : [],
        uploadPlan: director.uploadPlan,
        requiredAssets: Array.isArray(director.requiredAssets)
          ? director.requiredAssets.map((entry) => {
              const asset = asRecord(entry);
              if (!asset) return null;
              return {
                kind: asset.kind,
                status: asset.status,
                assetKey: asset.assetKey,
                reason: asset.reason,
                canGenerate: asset.canGenerate,
                dependsOnAssetKeys: asset.dependsOnAssetKeys,
              };
            }).filter(Boolean)
          : [],
        understanding: director.understanding,
      }
    : null;
  const inputAssets = Array.isArray(extra?.inputAssets)
    ? extra.inputAssets.map((entry) => {
        const asset = asRecord(entry);
        if (!asset) return null;
        return {
          assetKey: asset.assetKey,
          name: asset.name,
          type: asset.type,
          url: asset.url,
        };
      }).filter(Boolean)
    : [];
  return {
    placeholder: value.placeholder,
    message: value.message,
    extra: { director: safeDirector, inputAssets },
  };
}

function safeAutoEditArtifactUrl(
  value: unknown,
  taskId: number,
  fileName: "final.mp4",
): string | null {
  const expected = `/api/tasks/${taskId}/artifacts/editing/${fileName}`;
  return value === expected ? expected : null;
}

function safeAutoEditAttentionNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[{}[\]`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact) return null;
  if (
    /(?:edit[-_ ]?plan|schema|asset(?:key)?|thread|job|quality[-_ ]?metrics|qa\b|json\b|\/api\/|[a-z]:\\)/iu.test(
      compact,
    )
  ) return null;
  return compact.slice(0, 120);
}

/** Auto-edit results must never expose the external lab job or absolute paths. */
function toEmployeeAutoEditResult(
  value: Record<string, unknown>,
  taskId: number,
  title = "剪辑成片",
): Record<string, unknown> {
  const extra = asRecord(value.extra);
  const editing = asRecord(extra?.editing);
  const videoUrl = safeAutoEditArtifactUrl(editing?.videoUrl, taskId, "final.mp4");
  const attentionNote = safeAutoEditAttentionNote(editing?.attentionNote);
  const narrationNote = safeAutoEditAttentionNote(editing?.narrationNote);
  const narrationStatus = normalizeNarrationStatus(editing?.narrationStatus);
  const media = Array.isArray(value.media)
    ? value.media.flatMap((entry) => {
        const item = asRecord(entry);
        const url = safeAutoEditArtifactUrl(item?.url, taskId, "final.mp4");
        return item?.type === "video" && url
          ? [{ type: "video", url, title }]
          : [];
      })
    : [];
  const effectiveVideoUrl = videoUrl ?? media[0]?.url;
  return {
    message: typeof value.message === "string" ? value.message.slice(0, 160) : `${title}已生成`,
    media,
    extra: {
      editing: {
        ...(effectiveVideoUrl ? { videoUrl: effectiveVideoUrl } : {}),
        ...(attentionNote ? { attentionNote } : {}),
        ...(narrationNote ? { narrationNote } : {}),
        ...(narrationStatus ? { narrationStatus } : {}),
      },
    },
  };
}

function toEmployeeAutoEditParams(value: Record<string, unknown>): Record<string, unknown> {
  const duration = Number(value.editTargetDuration);
  return {
    ...(getEditTemplate(value.editTemplateId) ? { editTemplateId: value.editTemplateId, editTemplateVersion: EDIT_TEMPLATE_VERSION } : {}),
    brief: typeof value.brief === "string" ? value.brief : "",
    editMode: ["smart", "talking_head", "digital_presenter", "product_demo"].includes(
      String(value.editMode),
    )
      ? value.editMode
      : "smart",
    editTargetDuration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    editAspect: ["auto", "vertical", "horizontal", "source"].includes(
      String(value.editAspect),
    )
      ? value.editAspect
      : "auto",
    editCaptions: value.editCaptions === "off" ? "off" : "auto",
    captionStyle: value.captionStyle === "punchy" ? "punchy" : "clean",
    editAudio: value.editAudio === "mute" ? "mute" : "keep",
    transcribe: value.transcribe !== false,
    editVoice: value.editVoice === "narration" ? "narration" : "original",
    subtitleLanguage: value.subtitleLanguage === "es" ? "es" : "en",
  };
}

export function toTaskOut(
  row: TaskRow,
  canManage = false,
  exposeCreator = false,
  creatorDisplayName?: string,
): TaskOut {
  const feature = getFeature(row.feature_id);
  return {
    id: row.id,
    videoId: row.video_id,
    videoName: row.video_name,
    secondaryVideoId: row.secondary_video_id ?? "",
    secondaryVideoName: row.secondary_video_name ?? "",
    featureId: row.feature_id,
    featureName: feature?.name ?? row.feature_id,
    featureIcon: feature?.icon ?? "🤖",
    params: ["auto_edit", "watermark_removal"].includes(row.feature_id)
      ? row.feature_id === "watermark_removal"
        ? { watermarkOnly: true }
        : toEmployeeAutoEditParams(safeJsonParse(row.params_json))
      : safeJsonParse(row.params_json),
    status: row.status,
    ...(normalizeNarrationStatus(row.edit_narration_status) ? { narrationStatus: normalizeNarrationStatus(row.edit_narration_status) } : {}),
    progress: row.progress,
    message: row.message,
    result: row.result_json
      ? row.feature_id === "voice_clone"
        ? { message: safeJsonParse(row.result_json).message, media: row.status === "succeeded" ? [{ type: "audio", url: `/api/tasks/${row.id}/artifacts/voice/final.wav`, title: row.video_name }] : [] }
        : ["auto_edit", "watermark_removal"].includes(row.feature_id)
        ? toEmployeeAutoEditResult(
            safeJsonParse(row.result_json),
            row.id,
            row.feature_id === "watermark_removal" ? "去水印视频" : "剪辑成片",
          )
        : toEmployeeTaskResult(safeJsonParse(row.result_json))
      : null,
    error: employeeTaskError(row.error),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(exposeCreator
      ? {
          createdBy: row.created_by,
          creatorDisplayName: creatorDisplayName || row.created_by,
        }
      : {}),
    canManage,
  };
}

/**
 * Lightweight list payload. Task results can contain long prompts and asset
 * plans, so list polling must never parse or resend them. The task detail API
 * remains the single source for the full result.
 */
export function toTaskSummaryOut(
  row: TaskRow,
  canManage = false,
  exposeCreator = false,
  creatorDisplayName?: string,
): TaskOut {
  const feature = getFeature(row.feature_id);
  const params = safeJsonParse(row.params_json);
  const safeSummaryParams = row.feature_id === "watermark_removal"
    ? { watermarkOnly: true }
    : row.feature_id === "auto_edit"
    ? (() => {
        const safeAutoEdit = toEmployeeAutoEditParams(params);
        return {
          transcribe: safeAutoEdit.transcribe,
          ...(safeAutoEdit.editTemplateId ? { editTemplateId: safeAutoEdit.editTemplateId } : {}),
          editMode: safeAutoEdit.editMode,
          editCaptions: safeAutoEdit.editCaptions,
          captionStyle: safeAutoEdit.captionStyle,
          subtitleLanguage: safeAutoEdit.subtitleLanguage,
        };
      })()
    : { analysisConfirmed: params.analysisConfirmed === true };
  return {
    id: row.id,
    videoId: row.video_id,
    videoName: row.video_name,
    secondaryVideoId: row.secondary_video_id ?? "",
    secondaryVideoName: row.secondary_video_name ?? "",
    featureId: row.feature_id,
    featureName: feature?.name ?? row.feature_id,
    featureIcon: feature?.icon ?? "🎬",
    params: safeSummaryParams,
    status: row.status,
    ...(normalizeNarrationStatus(row.edit_narration_status) ? { narrationStatus: normalizeNarrationStatus(row.edit_narration_status) } : {}),
    progress: row.progress,
    message: row.message,
    result: null,
    error: employeeTaskError(row.error),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(exposeCreator
      ? {
          createdBy: row.created_by,
          creatorDisplayName: creatorDisplayName || row.created_by,
        }
      : {}),
    canManage,
  };
}
