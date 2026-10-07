import type { AutoEditPostRenderMetrics } from "./auto-edit-quality-gates";

export interface StrictAutoEditQualityMetrics extends AutoEditPostRenderMetrics {
  audioPresent: boolean;
  displayRotationDegrees: number;
  blackBorderRatio: number;
  openingFreezeSeconds: number;
  openingMotionScore: number;
  renderedDuplicates: NonNullable<AutoEditPostRenderMetrics["renderedDuplicates"]>;
  audioCuts: NonNullable<AutoEditPostRenderMetrics["audioCuts"]>;
}

const ROOT_FIELDS = new Set([
  "audioPresent", "displayRotationDegrees", "blackBorderRatio",
  "openingFreezeSeconds", "openingMotionScore", "renderedDuplicates", "audioCuts",
]);
const DUPLICATE_FIELDS = new Set(["firstSeconds", "secondSeconds", "similarity"]);
const AUDIO_CUT_FIELDS = new Set([
  "atSeconds", "beforeRmsDb", "afterRmsDb", "normalizedSampleJump",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: Set<string>, label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label}字段不完整或含未知字段`);
  }
}

function numberIn(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label}超出可用范围`);
  }
  return value;
}

function time(value: unknown, durationSeconds: number | undefined, label: string): number {
  return numberIn(value, 0, durationSeconds ?? 6 * 60 * 60, label);
}

export function parseAutoEditQualityMetrics(
  value: unknown,
  options: {
    durationSeconds?: number;
    expectedAudioCutTimes?: readonly number[];
  } = {},
): StrictAutoEditQualityMetrics {
  if (options.durationSeconds !== undefined &&
      (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0)) {
    throw new Error("成片时长无效");
  }
  const root = record(value, "质量测量");
  exactFields(root, ROOT_FIELDS, "质量测量");
  if (typeof root.audioPresent !== "boolean") throw new Error("音轨探针证据无效");
  if (!Array.isArray(root.renderedDuplicates) || root.renderedDuplicates.length > 120) {
    throw new Error("重复画面测量数量无效");
  }
  if (!Array.isArray(root.audioCuts) || root.audioCuts.length > 64) {
    throw new Error("音频切点测量数量无效");
  }
  const renderedDuplicates = root.renderedDuplicates.map((entry, index) => {
    const item = record(entry, `重复画面 ${index + 1}`);
    exactFields(item, DUPLICATE_FIELDS, `重复画面 ${index + 1}`);
    const firstSeconds = time(item.firstSeconds, options.durationSeconds, "重复画面首次时间");
    const secondSeconds = time(item.secondSeconds, options.durationSeconds, "重复画面再次时间");
    if (secondSeconds - firstSeconds < 0.5) throw new Error("重复画面时间顺序无效");
    return {
      firstSeconds, secondSeconds,
      similarity: numberIn(item.similarity, 0, 1, "重复画面相似度"),
    };
  });
  const audioCuts = root.audioCuts.map((entry, index) => {
    const item = record(entry, `音频切点 ${index + 1}`);
    exactFields(item, AUDIO_CUT_FIELDS, `音频切点 ${index + 1}`);
    return {
      atSeconds: time(item.atSeconds, options.durationSeconds, "音频切点时间"),
      beforeRmsDb: numberIn(item.beforeRmsDb, -120, 24, "切点前响度"),
      afterRmsDb: numberIn(item.afterRmsDb, -120, 24, "切点后响度"),
      normalizedSampleJump: numberIn(item.normalizedSampleJump, 0, 4, "切点波形跳变"),
    };
  });
  if (!root.audioPresent && audioCuts.length > 0) {
    throw new Error("探针显示无音轨，但却包含音频切点测量");
  }
  if (options.expectedAudioCutTimes !== undefined) {
    if (!Array.isArray(options.expectedAudioCutTimes)) {
      throw new Error("预期音频切点必须是数组");
    }
    const expectedAudioCutTimes = options.expectedAudioCutTimes.slice(0, 64).map(
      (entry, index) => time(entry, options.durationSeconds, `预期音频切点 ${index + 1}`),
    );
    if (root.audioPresent) {
      if (audioCuts.length !== expectedAudioCutTimes.length) {
        throw new Error("音频切点测量数量与剪辑计划不一致");
      }
      for (let index = 0; index < expectedAudioCutTimes.length; index += 1) {
        // The Python tool serializes milliseconds and FFmpeg seek timestamps
        // may differ by one or two frames. 80ms accepts that rounding without
        // allowing a neighboring cut to masquerade as the requested one.
        if (Math.abs(audioCuts[index].atSeconds - expectedAudioCutTimes[index]) > 0.08) {
          throw new Error(`音频切点 ${index + 1} 测量时间与剪辑计划不对齐`);
        }
      }
    }
  }
  return {
    audioPresent: root.audioPresent,
    displayRotationDegrees: numberIn(root.displayRotationDegrees, -360, 360, "显示旋转"),
    blackBorderRatio: numberIn(root.blackBorderRatio, 0, 1, "黑边比例"),
    openingFreezeSeconds: numberIn(
      root.openingFreezeSeconds, 0, Math.min(options.durationSeconds ?? 5, 5), "首段冻结时长",
    ),
    openingMotionScore: numberIn(root.openingMotionScore, 0, 1, "首秒运动分数"),
    renderedDuplicates,
    audioCuts,
  };
}
