/**
 * Deterministic quality gates for automatic edits.
 *
 * This module deliberately separates plan facts from post-render measurements.
 * It does not pretend that a heuristic can judge story or taste. Callers may use
 * errors as retry/blocking reasons and warnings as concrete review instructions.
 */

export type AutoEditQualitySeverity = "error" | "warning";

export interface AutoEditQualityIssue {
  code:
    | "ROTATED_OUTPUT"
    | "ROTATED_SOURCE"
    | "LETTERBOX_RISK"
    | "VISIBLE_BLACK_BORDER"
    | "REPEATED_SOURCE_SPAN"
    | "REPEATED_RENDERED_SHOT"
    | "MECHANICAL_CLIP_DURATIONS"
    | "STATIC_OPENING"
    | "CAPTION_OUTSIDE_SAFE_AREA"
    | "CAPTION_TIMING"
    | "CAPTION_COLLISION"
    | "AUDIO_GAIN_JUMP"
    | "MISSING_AUDIO_EDGE_FADE"
    | "AUDIO_CUT_DISCONTINUITY";
  severity: AutoEditQualitySeverity;
  message: string;
  atSeconds?: number;
  details?: Record<string, number | string | boolean>;
}

export interface AutoEditQualityResult {
  passed: boolean;
  issues: AutoEditQualityIssue[];
  errorCount: number;
  warningCount: number;
}

export interface AutoEditSourceFact {
  source: string;
  width?: number;
  height?: number;
  rotationDegrees?: number;
}

export interface AutoEditRenderedDuplicate {
  firstSeconds: number;
  secondSeconds: number;
  similarity: number;
}

export interface AutoEditAudioCutMeasurement {
  atSeconds: number;
  beforeRmsDb?: number;
  afterRmsDb?: number;
  normalizedSampleJump?: number;
}

export interface AutoEditPostRenderMetrics {
  displayRotationDegrees?: number;
  blackBorderRatio?: number;
  openingFreezeSeconds?: number;
  openingMotionScore?: number;
  renderedDuplicates?: AutoEditRenderedDuplicate[];
  audioCuts?: AutoEditAudioCutMeasurement[];
}

interface PlanOutput {
  width?: unknown;
  height?: unknown;
}

interface PlanClip {
  source?: unknown;
  kind?: unknown;
  start?: unknown;
  end?: unknown;
  duration?: unknown;
  speed?: unknown;
  fit?: unknown;
  mute?: unknown;
  audio_gain_db?: unknown;
}

interface PlanOverlay {
  kind?: unknown;
  preset?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  align?: unknown;
}

interface PlanTransition {
  after_clip?: unknown;
  duration?: unknown;
}

interface EditPlanLike {
  output?: PlanOutput;
  clips?: PlanClip[];
  transitions?: PlanTransition[];
  overlays?: PlanOverlay[];
  finishing?: {
    audio_edge_fade_ms?: unknown;
  };
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clipDuration(clip: PlanClip): number | null {
  const start = finite(clip.start);
  const end = finite(clip.end);
  const speed = finite(clip.speed) ?? 1;
  // For video, the executable timeline is always derived from the selected
  // source span and speed. Some historical plans carry a stale `duration`
  // placeholder; trusting it would make cadence and cut-time QA inspect the
  // wrong timeline. Images have no start/end span and use duration directly.
  if (clip.kind === "video") {
    if (start === null || end === null || end <= start || speed <= 0) return null;
    return (end - start) / speed;
  }
  const explicit = finite(clip.duration);
  return explicit !== null && explicit > 0 ? explicit : null;
}

function normalizedRotation(value: number): number {
  const rotation = ((value % 360) + 360) % 360;
  return rotation > 180 ? rotation - 360 : rotation;
}

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function overlapRatio(left: PlanClip, right: PlanClip): number {
  const leftStart = finite(left.start);
  const leftEnd = finite(left.end);
  const rightStart = finite(right.start);
  const rightEnd = finite(right.end);
  if (
    leftStart === null || leftEnd === null || rightStart === null || rightEnd === null ||
    leftEnd <= leftStart || rightEnd <= rightStart
  ) return 0;
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  return overlap / Math.min(leftEnd - leftStart, rightEnd - rightStart);
}

function makeResult(issues: AutoEditQualityIssue[]): AutoEditQualityResult {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return { passed: errorCount === 0, issues, errorCount, warningCount };
}

/** Audit facts that are already present in an edit plan. */
export function auditAutoEditPlanQuality(
  plan: EditPlanLike,
  sources: readonly AutoEditSourceFact[] = [],
): AutoEditQualityResult {
  const issues: AutoEditQualityIssue[] = [];
  const clips = Array.isArray(plan.clips) ? plan.clips : [];
  const transitions = Array.isArray(plan.transitions) ? plan.transitions : [];
  const overlays = Array.isArray(plan.overlays) ? plan.overlays : [];
  const outputWidth = finite(plan.output?.width);
  const outputHeight = finite(plan.output?.height);
  const sourceByName = new Map(sources.map((source) => [source.source, source]));

  let timelineSeconds = 0;
  const durations: number[] = [];
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const duration = clipDuration(clip);
    if (duration !== null) {
      durations.push(duration);
      timelineSeconds += duration;
    }
    const sourceName = typeof clip.source === "string" ? clip.source : "";
    const source = sourceByName.get(sourceName);
    const rotation = source?.rotationDegrees;
    if (typeof rotation === "number" && Math.abs(normalizedRotation(rotation)) > 1) {
      issues.push({
        code: "ROTATED_SOURCE",
        // Phone MOV files commonly carry -90/90 degree display metadata and
        // FFmpeg autorotates them correctly. The rendered-output rotation gate
        // below is the authoritative blocker; source metadata is review context.
        severity: "warning",
        message: `第 ${index + 1} 个镜头的源视频带有 ${normalizedRotation(rotation)}° 显示旋转信息，请核对成片方向。`,
        details: { clipIndex: index, rotationDegrees: normalizedRotation(rotation) },
      });
    }
    if (
      clip.fit === "contain" && source?.width && source.height && outputWidth && outputHeight
    ) {
      const sourceAspect = source.width / source.height;
      const outputAspect = outputWidth / outputHeight;
      if (Math.abs(Math.log(sourceAspect / outputAspect)) > 0.08) {
        issues.push({
          code: "LETTERBOX_RISK",
          severity: "warning",
          message: `第 ${index + 1} 个镜头使用 contain 且与成片画幅不匹配，会产生明显黑边。`,
          details: { clipIndex: index, sourceAspect, outputAspect },
        });
      }
    }
  }
  const transitionDurationByBoundary = new Map<number, number>();
  for (const transition of transitions) {
    const afterClip = finite(transition.after_clip);
    const duration = finite(transition.duration);
    if (
      afterClip === null || !Number.isInteger(afterClip) || duration === null || duration <= 0
    ) continue;
    transitionDurationByBoundary.set(afterClip, duration);
    timelineSeconds = Math.max(0, timelineSeconds - duration);
  }

  for (let left = 0; left < clips.length; left += 1) {
    for (let right = left + 1; right < clips.length; right += 1) {
      if (clips[left].source !== clips[right].source || clips[left].kind !== "video") continue;
      const overlap = overlapRatio(clips[left], clips[right]);
      if (overlap >= 0.8) {
        issues.push({
          code: "REPEATED_SOURCE_SPAN",
          severity: "error",
          message: `第 ${left + 1} 和 ${right + 1} 个镜头重复使用了同一段源画面。`,
          details: { firstClip: left, secondClip: right, overlapRatio: overlap },
        });
      }
    }
  }

  if (durations.length >= 6) {
    const variation = coefficientOfVariation(durations);
    const roundedBuckets = new Set(durations.map((duration) => Math.round(duration * 10)));
    const sorted = [...durations].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    const nearMedianShare = durations.filter((duration) => Math.abs(duration - median) <= 0.35)
      .length / durations.length;
    if (
      (variation < 0.10 && roundedBuckets.size <= 2) ||
      (durations.length >= 8 && nearMedianShare >= 0.70)
    ) {
      issues.push({
        code: "MECHANICAL_CLIP_DURATIONS",
        severity: "warning",
        message: "连续镜头时长几乎完全一样，看起来像机械均切，需按动作和语义重新定切点。",
        details: {
          clipCount: durations.length,
          durationVariation: variation,
          medianDuration: median,
          nearMedianShare,
        },
      });
    }
  }

  const captionOverlays = overlays.filter((overlay) => overlay.kind === "caption");
  for (let index = 0; index < captionOverlays.length; index += 1) {
    const overlay = captionOverlays[index];
    const start = finite(overlay.start);
    const end = finite(overlay.end);
    if (start === null || end === null) continue;
    const duration = end - start;
    const textLength = typeof overlay.text === "string"
      ? [...overlay.text.replace(/\s/gu, "")].length
      : 0;
    const text = typeof overlay.text === "string" ? overlay.text : "";
    const containsCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
    const emphasisPreset = overlay.preset === "fine_hook" || overlay.preset === "fine_micro";
    const minimumReadableSeconds = Math.max(
      emphasisPreset ? 0.30 : 0.38,
      textLength / (containsCjk ? 9 : 22),
    );
    if (duration < minimumReadableSeconds || duration > 8 || end > timelineSeconds + 0.05) {
      issues.push({
        code: "CAPTION_TIMING",
        severity: duration < 0.28 || end > timelineSeconds + 0.05 ? "error" : "warning",
        message: `第 ${index + 1} 条字幕的显示时长或时间边界不合理。`,
        atSeconds: start,
        details: { captionIndex: index, duration, minimumReadableSeconds, timelineSeconds },
      });
    }
    const x = finite(overlay.x);
    const y = finite(overlay.y);
    if (outputWidth && outputHeight && x !== null && y !== null) {
      // AutoLab accepts normalized placement in generated plans and absolute
      // pixels in older plans. Normalize both before applying the same gate.
      const normalizedX = x >= 0 && x <= 1 ? x : x / outputWidth;
      const normalizedY = y >= 0 && y <= 1 ? y : y / outputHeight;
      const unsafe = normalizedX < 0.05 || normalizedX > 0.95 ||
        normalizedY < 0.08 || normalizedY > 0.84;
      if (unsafe) {
        issues.push({
          code: "CAPTION_OUTSIDE_SAFE_AREA",
          severity: "error",
          message: `第 ${index + 1} 条字幕中心点超出竖屏发布安全区。`,
          atSeconds: start,
          details: {
            captionIndex: index,
            x,
            y,
            normalizedX,
            normalizedY,
            outputWidth,
            outputHeight,
          },
        });
      }
    }
    for (let otherIndex = index + 1; otherIndex < captionOverlays.length; otherIndex += 1) {
      const otherStart = finite(captionOverlays[otherIndex].start);
      const otherEnd = finite(captionOverlays[otherIndex].end);
      if (otherStart === null || otherEnd === null) continue;
      const overlap = Math.min(end, otherEnd) - Math.max(start, otherStart);
      if (overlap > 0.12) {
        issues.push({
          code: "CAPTION_COLLISION",
          severity: "error",
          message: `第 ${index + 1} 和 ${otherIndex + 1} 条口播字幕同时出现。`,
          atSeconds: Math.max(start, otherStart),
          details: { firstCaption: index, secondCaption: otherIndex, overlapSeconds: overlap },
        });
      }
    }
  }

  let cursor = 0;
  let audibleCutCount = 0;
  for (let index = 1; index < clips.length; index += 1) {
    const previousDuration = clipDuration(clips[index - 1]);
    if (previousDuration !== null) cursor += previousDuration;
    const transitionDuration = transitionDurationByBoundary.get(index - 1) ?? 0;
    cursor = Math.max(0, cursor - transitionDuration);
    const previousGain = finite(clips[index - 1].audio_gain_db) ?? 0;
    const nextGain = finite(clips[index].audio_gain_db) ?? 0;
    const audibleCut = clips[index - 1].kind === "video" && clips[index].kind === "video" &&
      clips[index - 1].mute !== true && clips[index].mute !== true;
    const hardAudioCut = audibleCut && transitionDuration <= 0;
    if (hardAudioCut) audibleCutCount += 1;
    if (hardAudioCut && Math.abs(nextGain - previousGain) >= 10) {
      issues.push({
        code: "AUDIO_GAIN_JUMP",
        severity: "warning",
        message: `第 ${index} 与 ${index + 1} 个镜头的原声增益相差过大，切点容易爆音或音量突变。`,
        atSeconds: cursor,
        details: { previousGainDb: previousGain, nextGainDb: nextGain },
      });
    }
  }
  const audioEdgeFadeMs = finite(plan.finishing?.audio_edge_fade_ms);
  if (audibleCutCount > 0 && (audioEdgeFadeMs === null || audioEdgeFadeMs < 8)) {
    issues.push({
      code: "MISSING_AUDIO_EDGE_FADE",
      severity: audibleCutCount >= 3 ? "error" : "warning",
      message: audibleCutCount >= 3
        ? `成片保留了 ${audibleCutCount} 个原声硬切点，但没有至少 8ms 的边缘淡化。`
        : "原声切点没有足够的边缘淡化，容易产生喀哒声。",
      details: { audibleCutCount, audioEdgeFadeMs: audioEdgeFadeMs ?? 0 },
    });
  }
  return makeResult(issues);
}

/** Audit measurements made from the final rendered video/audio. */
export function auditAutoEditPostRenderQuality(
  metrics: AutoEditPostRenderMetrics,
): AutoEditQualityResult {
  const issues: AutoEditQualityIssue[] = [];
  if (
    typeof metrics.displayRotationDegrees === "number" &&
    Math.abs(normalizedRotation(metrics.displayRotationDegrees)) > 1
  ) {
    issues.push({
      code: "ROTATED_OUTPUT",
      severity: "error",
      message: `成片仍带有 ${normalizedRotation(metrics.displayRotationDegrees)}° 旋转信息。`,
      details: { rotationDegrees: normalizedRotation(metrics.displayRotationDegrees) },
    });
  }
  if (typeof metrics.blackBorderRatio === "number" && metrics.blackBorderRatio >= 0.015) {
    issues.push({
      code: "VISIBLE_BLACK_BORDER",
      severity: metrics.blackBorderRatio >= 0.05 ? "error" : "warning",
      message: "成片检测到持续画面黑边，需重新构图或填充画幅。",
      details: { blackBorderRatio: metrics.blackBorderRatio },
    });
  }
  const openingFreeze = metrics.openingFreezeSeconds ?? 0;
  const openingMotion = metrics.openingMotionScore;
  if (openingFreeze >= 0.8 || (typeof openingMotion === "number" && openingMotion < 0.008)) {
    issues.push({
      code: "STATIC_OPENING",
      severity: openingFreeze >= 1.2 ? "error" : "warning",
      message: "首秒缺少可感知动作，不适合当短视频动作钩子。",
      atSeconds: 0,
      details: { openingFreezeSeconds: openingFreeze, openingMotionScore: openingMotion ?? -1 },
    });
  }
  for (const duplicate of metrics.renderedDuplicates ?? []) {
    if (duplicate.similarity < 0.985 || Math.abs(duplicate.secondSeconds - duplicate.firstSeconds) < 0.5) continue;
    issues.push({
      code: "REPEATED_RENDERED_SHOT",
      severity: duplicate.similarity >= 0.995 ? "error" : "warning",
      message: "成片中出现了高度重复的非相邻画面。",
      atSeconds: duplicate.secondSeconds,
      details: { firstSeconds: duplicate.firstSeconds, similarity: duplicate.similarity },
    });
  }
  for (const cut of metrics.audioCuts ?? []) {
    const before = cut.beforeRmsDb;
    const after = cut.afterRmsDb;
    const rmsDelta = typeof before === "number" && typeof after === "number"
      ? Math.abs(after - before)
      : 0;
    const sampleJump = cut.normalizedSampleJump ?? 0;
    if (rmsDelta >= 10 || sampleJump >= 0.32) {
      issues.push({
        code: "AUDIO_CUT_DISCONTINUITY",
        // A quiet breath followed by a word or a physical click can legitimately
        // change window RMS by >18dB. Without a sample discontinuity it is a
        // listening warning, not proof that the render is broken.
        severity: sampleJump >= 0.55 ? "error" : "warning",
        message: sampleJump >= 0.55 ? "音频切点存在明显采样突变，需检查爆音并调整边缘或切点。" : "音频切点附近响度变化较大；请核对是否为正常开口或操作声，不要直接删去原声。",
        atSeconds: cut.atSeconds,
        details: { rmsDeltaDb: rmsDelta, normalizedSampleJump: sampleJump },
      });
    }
  }
  return makeResult(issues);
}

export function mergeAutoEditQualityResults(
  ...results: readonly AutoEditQualityResult[]
): AutoEditQualityResult {
  return makeResult(results.flatMap((result) => result.issues));
}
