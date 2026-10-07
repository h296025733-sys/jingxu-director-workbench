import { normalizeWatermarkCleanup } from "./edit-watermarks";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function evenDimension(value: number): number {
  return Math.max(240, Math.min(3840, Math.floor(value / 2) * 2));
}

function sourceOutputSize(video: JsonRecord): { width: number; height: number } {
  let width = Number(video.width);
  let height = Number(video.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("原视频没有可用的画面尺寸");
  }
  const rotation = Number(video.rotation_degrees ?? video.rotation ?? 0);
  if (Number.isFinite(rotation) && Math.abs(rotation % 180) > 89 && Math.abs(rotation % 180) < 91) {
    [width, height] = [height, width];
  }
  const scale = Math.min(1, 3840 / Math.max(width, height));
  return {
    width: evenDimension(width * scale),
    height: evenDimension(height * scale),
  };
}

/**
 * Reduce an intelligent edit proposal to a watermark-only render plan.
 * The model may inspect the supplied contact sheet, but it never gets to cut,
 * retime, mute, crop for aspect, caption, decorate, or reorder the source.
 */
export function buildWatermarkOnlyPlan(options: {
  draftPlan: unknown;
  plannedPlan: unknown;
  analysis: unknown;
  outputFilename?: string;
}): JsonRecord {
  const analysis = record(options.analysis);
  const assets = Array.isArray(analysis.assets) ? analysis.assets : [];
  const asset = assets.map(record).find((item) => item.kind === "video");
  if (!asset || typeof asset.job_path !== "string" || !asset.job_path) {
    throw new Error("去水印任务没有找到原视频");
  }
  const probe = record(asset.probe);
  const video = record(probe.video);
  const duration = Number(probe.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("原视频时长无效");
  }
  const fpsValue = Number(video.fps);
  const fps = Math.max(12, Math.min(60, Number.isFinite(fpsValue) ? fpsValue : 30));
  const { width, height } = sourceOutputSize(video);
  const draft = record(options.draftPlan);
  const planned = record(options.plannedPlan);
  const jobId = String(draft.job_id ?? planned.job_id ?? "");
  if (!jobId) throw new Error("去水印任务缺少剪辑任务编号");

  return {
    schema_version: 1,
    watermark_only: true,
    job_id: jobId,
    intent_summary: "只检查并处理可安全移除的平台或账号水印；完整保留原视频时长、画面、动作、顺序和原声。",
    narrative_regime: "general",
    output: {
      filename: options.outputFilename ?? "watermark-clean.mp4",
      width,
      height,
      fps,
      video_codec: "libx264",
      crf: 20,
      preset: "medium",
      audio_bitrate: "192k",
    },
    clips: [{
      source: asset.job_path,
      kind: "video",
      visual_job: "bridge",
      selection_reason: "完整保留员工上传的唯一原视频，不执行剪辑取舍。",
      exit_condition: "原视频完整播放到自然结尾。",
      start: 0,
      end: duration,
      speed: 1,
      fit: "contain",
      audio_gain_db: 0,
      mute: false,
    }],
    transitions: [],
    picture_in_picture: [],
    overlays: [],
    graphic_annotations: [],
    music: null,
    voiceover: null,
    sfx: [],
    narration: [],
    watermark_cleanup: normalizeWatermarkCleanup({...record(planned.watermark_cleanup), version: 3}, [{
      source: asset.job_path,
      kind: "video",
      durationSeconds: duration,
    }]),
    finishing: {
      preset: "none",
      flashes: [],
      bottom_crop_pixels: 0,
      audio_edge_fade_ms: 0,
      loudness_target_lufs: null,
      true_peak_limit_db: -1.5,
    },
  };
}
