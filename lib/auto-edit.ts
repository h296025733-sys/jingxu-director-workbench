import "server-only";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { pipeline } from "node:stream/promises";
import { db } from "./db";
import { DATA_DIR, PROJECT_ROOT } from "./paths";
import {
  auditAutoEditPlanQuality,
  auditAutoEditPostRenderQuality,
  mergeAutoEditQualityResults,
  type AutoEditPostRenderMetrics,
  type AutoEditQualityResult,
  type AutoEditSourceFact,
} from "./auto-edit-quality-gates";
import { parseAutoEditQualityMetrics } from "./auto-edit-quality-metrics";
import {
  assertAutoEditPlanAvoidsInFrameRoll,
  createInFrameRollReport,
} from "./in-frame-roll";
import type { FeatureContext, FeatureResult } from "@/features/base";
import { AUTO_EDIT_DEFAULT_BRIEF } from "./auto-edit-defaults";
import { applyEditTemplate, editTemplateValidationError, getEditTemplate, normalizePreviewVoice, previewVoiceGender, type PreviewVoice } from "./edit-templates";
import { withLocalMediaSlot, withMediaFeedback } from "./local-media-capacity";
import { safeNarrationLines, transcriptSpeechSpans, sourceSpeechProfile, narrationDepth, narrationFlowNeedsGrouping, needsContinuousNarration, assessFullNarrationDelivery, type NarrationDepth, type SpeechSpan } from "./edit-narration";
import { checkpointNarration } from "./narration-checkpoint";
import { withVoiceSlot } from "./voice-capacity";
import { watermarkResultNote, watermarkExecutionNote } from "./edit-watermarks";
import { buildWatermarkOnlyPlan } from "./watermark-only-plan";

const DEFAULT_LAB_ROOT = path.resolve(PROJECT_ROOT, "..", "codex-auto-video-lab");
const JOB_ID_PATTERN = /^mx-edit-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const STALE_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

type EditAspect = "auto" | "vertical" | "horizontal" | "source";
type EditCaptions = "auto" | "off";
type EditAudio = "keep" | "mute";
type EditMode = "smart" | "talking_head" | "digital_presenter" | "product_demo";
type CaptionStyle = "clean" | "punchy";
type SubtitleLanguage = "en" | "es";

interface AutoEditParams {
  watermarkOnly: boolean;
  editColorStyle: string;
  editTemplateId: string;
  editTemplateVersion: number;
  editVoice: "original" | "narration";
  editNarrationDepth: NarrationDepth;
  editNarrationBrief: string;
  editNarrator: "male" | "female";
  editVoiceProfile: PreviewVoice;
  voiceReferenceVideoId: string;
  editEmotion: "neutral" | "excited" | "emphatic";
  brief: string;
  editMode: EditMode;
  editTargetDuration: number;
  editAspect: EditAspect;
  editCaptions: EditCaptions;
  captionStyle: CaptionStyle;
  editAudio: EditAudio;
  transcribe: boolean;
  subtitleLanguage: SubtitleLanguage;
}

interface LabLayout {
  root: string;
  jobsRoot: string;
  studioScript: string;
  python: string;
  ffmpeg: string;
  ffprobe: string;
  timestampFont: string;
  powershell: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface SourceBlackSegment {
  start: number;
  end: number;
  duration: number;
}

export interface SourceBlackReport {
  schema_version: 1;
  job_id: string;
  sources: Array<{
    source: string;
    segments: SourceBlackSegment[];
  }>;
}

interface EditingPlanRunner {
  runEditingPlan?: (options: {
    taskId: number;
    labRoot: string;
    jobRoot: string;
    brief: string;
    analysisPath: string;
    draftPlanPath: string;
    params: {
      watermarkOnly?: boolean;
      editTemplateId?: string;
      editTemplateVersion?: number;
      editColorStyle?: string;
      editVoice?: "original" | "narration";
      editNarrationDepth?: NarrationDepth;
      editNarrationBrief?: string;
      editMode: EditMode;
      editTargetDuration: number;
      editAspect: EditAspect;
      editCaptions: EditCaptions;
      captionStyle: CaptionStyle;
      editAudio: EditAudio;
      transcribe: boolean;
      subtitleLanguage: SubtitleLanguage;
    };
    visualEvidencePaths?: string[];
    signal?: AbortSignal;
  }) => Promise<{ plan: unknown; threadId: string | null; qualityNote?: string }>;
  runEditingReview?: (options: {
    taskId: number;
    labRoot: string;
    jobRoot: string;
    brief: string;
    analysisPath: string;
    planPath: string;
    qaPath: string;
    reviewVisualEvidencePaths: string[];
    qualityIssues?: Array<{
      code: string;
      severity: "warning" | "error";
      message: string;
      atSeconds: number | null;
    }>;
    params: {
      editTemplateId?: string;
      editTemplateVersion?: number;
      editColorStyle?: string;
      editVoice?: "original" | "narration";
      editNarrationDepth?: NarrationDepth;
      editNarrationBrief?: string;
      editMode: EditMode;
      editTargetDuration: number;
      editAspect: EditAspect;
      editCaptions: EditCaptions;
      captionStyle: CaptionStyle;
      editAudio: EditAudio;
      transcribe: boolean;
      subtitleLanguage: SubtitleLanguage;
    };
    signal?: AbortSignal;
  }) => Promise<{
    review: {
      decision: "pass" | "repair" | "needs_attention";
      summary: string;
      issues: unknown[];
      revisedPlan: unknown | null;
    };
    threadId: string | null;
  }>;
}

type AutoEditReviewStatus =
  | "passed"
  | "repaired"
  | "needs_attention"
  | "unavailable"
  | "not_run";

interface AutoEditReviewDiagnosticIssue {
  code: string;
  severity: "warning" | "error";
  start: number | null;
  end: number | null;
  evidence: string;
  repair: string;
}

interface AutoEditReviewDiagnostics {
  schemaVersion: 1;
  status: AutoEditReviewStatus;
  summary: string;
  actionableHint: string | null;
  repairAttempted: boolean;
  quality: {
    passed: boolean;
    errorCount: number;
    warningCount: number;
    issues: ReturnType<typeof compactQualityIssues>;
  };
  review: {
    issues: AutoEditReviewDiagnosticIssue[];
  };
}

export interface AutoEditQaSummary {
  status: "passed";
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  audioPresent: boolean;
  fullDecode: boolean;
  blackFrameSpanCount: number;
  sampledFrameCount: number;
  note: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`剪辑技术检查缺少 ${field}`);
  }
  return parsed;
}

function isSamePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedCandidate = path.normalize(candidate);
  const left = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const right = process.platform === "win32"
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  return right.startsWith(`${left}${path.sep}`);
}

function assertPhysicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}不是可用的本地目录`);
  }
  const canonical = fs.realpathSync.native(/* turbopackIgnore: true */ resolved);
  if (!isSamePath(resolved, canonical)) {
    throw new Error(`${label}不能使用重定向目录`);
  }
  return canonical;
}

function assertPhysicalFile(filePath: string, root: string, label: string): string {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}不存在`);
  const canonical = fs.realpathSync.native(/* turbopackIgnore: true */ resolved);
  if (!isWithin(root, canonical)) throw new Error(`${label}路径无效`);
  return canonical;
}

function resolveLabLayout(): LabLayout {
  const configured = process.env.DW_AUTO_EDIT_LAB_ROOT?.trim() || DEFAULT_LAB_ROOT;
  if (!path.isAbsolute(configured)) throw new Error("自动剪辑工作区配置无效");
  const root = assertPhysicalDirectory(configured, "自动剪辑工作区");
  const jobsRoot = assertPhysicalDirectory(path.join(root, "jobs"), "自动剪辑任务目录");
  const studioScript = assertPhysicalFile(
    path.join(root, "studio.ps1"),
    root,
    "自动剪辑入口",
  );
  const python = assertPhysicalFile(
    path.join(root, ".venv", "Scripts", "python.exe"),
    root,
    "自动剪辑运行环境",
  );
  const ffmpeg = assertPhysicalFile(
    path.join(root, "tools", "ffmpeg", "bin", "ffmpeg.exe"),
    root,
    "自动剪辑视频工具",
  );
  const ffprobe = assertPhysicalFile(
    path.join(root, "tools", "ffmpeg", "bin", "ffprobe.exe"),
    root,
    "自动剪辑视频探测工具",
  );
  const timestampFont = assertPhysicalFile(
    path.join(
      root,
      ".codex",
      "skills",
      "tiktok-fine-cut-director",
      "assets",
      "fonts",
      "montserrat",
      "Montserrat-SemiBold.ttf",
    ),
    root,
    "剪辑时间戳字体",
  );
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!fs.existsSync(powershell) || !fs.statSync(powershell).isFile()) {
    throw new Error("服务器缺少 PowerShell，暂时不能剪辑视频");
  }
  return {
    root,
    jobsRoot,
    studioScript,
    python,
    ffmpeg,
    ffprobe,
    timestampFont,
    powershell,
  };
}

function validateSourceFile(filePath: string, label: string): string {
  const dataRoot = assertPhysicalDirectory(DATA_DIR, "素材目录");
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}已不存在`);
  const canonical = fs.realpathSync.native(/* turbopackIgnore: true */ resolved);
  if (!isWithin(dataRoot, canonical)) throw new Error(`${label}不在当前素材库中`);
  return canonical;
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It already exited.
    }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  const killed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The helper already exited.
      }
      finish(false);
    }, 15_000);
    timer.unref();
  });
  if (!killed) {
    try {
      process.kill(pid);
    } catch {
      // It already exited.
    }
  }
}

export function runBoundedProcess(options: Parameters<typeof runBoundedProcessUnsafe>[0]): Promise<ProcessResult> {
  return withLocalMediaSlot(options.signal, () => runBoundedProcessUnsafe(options), options.stage);
}

function runBoundedProcessUnsafe(options: {
  executable: string;
  args: string[];
  cwd: string;
  stage: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONUNBUFFERED: "1",
          OMP_NUM_THREADS: "2",
          OPENBLAS_NUM_THREADS: "2",
          MKL_NUM_THREADS: "2",
        },
      });
    if (child.pid) {
      try {
        // Windows descendants normally inherit the below-normal priority,
        // keeping FFmpeg/Whisper responsive without starving the web server.
        setPriority(child.pid, 10);
      } catch {
        // Priority lowering is best effort; concurrency remains hard-limited.
      }
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopReason: Error | null = null;
    let killFallback: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      options.signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    };
    const stop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      void terminateProcessTree(child.pid);
      killFallback = setTimeout(() => finish(reason), 20_000);
    };
    const onAbort = () => {
      const reason = options.signal.reason;
      stop(reason instanceof Error ? reason : new Error("任务已被用户取消"));
    };
    const timeout = setTimeout(
      () => stop(new Error(`${options.stage}等待时间过长，已经安全停止`)),
      options.timeoutMs,
    );

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stop(new Error(`${options.stage}返回内容异常，已经安全停止`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stop(new Error(`${options.stage}返回内容异常，已经安全停止`));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, childSignal) => {
      if (stopReason) return finish(stopReason);
      if (code === 0) return finish();
      const diagnostic = Buffer.concat(stderr.length ? stderr : stdout)
        .toString("utf8")
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(-1200);
      console.error(
        `[镜序] 自动剪辑${options.stage}失败 code=${String(code)} signal=${String(childSignal)} ${diagnostic}`,
      );
      if (options.stage === "克隆音源提取") {
        const known = diagnostic.match(/VOICE_REFERENCE_ERROR:([^\r\n]+)/u)?.[1]?.trim();
        if (known) return finish(new Error(known.slice(0, 180)));
      }
      const stageError = new Error(`${options.stage}没有完成，请稍后重试`) as Error & {
        stage?: string;
        exitCode?: number | null;
        diagnostic?: string;
      };
      stageError.stage = options.stage;
      stageError.exitCode = code;
      stageError.diagnostic = diagnostic;
      finish(stageError);
    });
  });
}

function runLabStage(options: {
  layout: LabLayout;
  args: string[];
  stage: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ProcessResult> {
  return runBoundedProcess({
    executable: options.layout.powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      options.layout.studioScript,
      ...options.args,
    ],
    cwd: options.layout.root,
    stage: options.stage,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function normalizeParams(value: Record<string, unknown>): AutoEditParams {
  const templateError = editTemplateValidationError(value);
  if (templateError) throw new Error(templateError);
  const brief = String(value.brief ?? "").trim() || AUTO_EDIT_DEFAULT_BRIEF;
  const duration = Number(value.editTargetDuration ?? 0);
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > 600 ||
    (duration > 0 && duration < 4)
  ) {
    throw new Error("目标时长请填 0（自动），或填写 4 到 600 秒");
  }
  const enumValue = <T extends string>(
    candidate: unknown,
    allowed: readonly T[],
    fallback: T,
    label: string,
  ): T => {
    if (candidate === undefined || candidate === null || candidate === "") return fallback;
    if (typeof candidate !== "string" || !allowed.includes(candidate as T)) {
      throw new Error(`${label}选项无效，请重新选择`);
    }
    return candidate as T;
  };
  const editMode = enumValue(
    value.editMode,
    ["smart", "talking_head", "digital_presenter", "product_demo"],
    "smart",
    "剪辑类型",
  );
  const transcribe = value.transcribe !== false;
  if ((editMode === "talking_head" || editMode === "digital_presenter") && !transcribe) {
    throw new Error("真人口播和克隆口播精剪需要识别人声，请开启后重试");
  }
  return {
    watermarkOnly: value.watermarkOnly === true,
    brief,
    editTemplateId: String(value.editTemplateId ?? ""),
    editColorStyle: String(value.editColorStyle ?? "original"),
    editTemplateVersion: Number(value.editTemplateVersion ?? 1),
    editVoice: value.editVoice === "narration" ? "narration" : "original",
    editNarrationDepth: narrationDepth(value.editNarrationDepth),
    editNarrationBrief: String(value.editNarrationBrief ?? "").trim(),
    editNarrator: previewVoiceGender(normalizePreviewVoice(value.editVoiceProfile, value.editNarrator)),
    editVoiceProfile: normalizePreviewVoice(value.editVoiceProfile, value.editNarrator),
    voiceReferenceVideoId: String(value.voiceReferenceVideoId ?? "").trim(),
    editEmotion: enumValue(value.editEmotion, ["neutral", "excited", "emphatic"], "neutral", "解说情绪"),
    editMode,
    editTargetDuration: duration,
    editAspect: enumValue(value.editAspect, ["auto", "vertical", "horizontal", "source"], "auto", "画面方向"),
    editCaptions: enumValue(value.editCaptions, ["auto", "off"], "auto", "字幕"),
    captionStyle: getEditTemplate(value.editTemplateId, value.editTemplateVersion ?? 1)?.captionStyle ?? enumValue(value.captionStyle, ["clean", "punchy"], "punchy", "字幕样式"),
    editAudio: enumValue(value.editAudio, ["keep", "mute"], "keep", "声音"),
    transcribe,
    subtitleLanguage: enumValue(
      value.subtitleLanguage,
      ["en", "es"],
      "en",
      "字幕语言",
    ),
  };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    JSON.parse(fs.readFileSync(temp, "utf8"));
    fs.renameSync(temp, filePath);
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The successful rename already moved it.
    }
  }
}

function clipDuration(clip: Record<string, unknown>): number {
  if (clip.kind === "image") return Number(clip.duration ?? 0);
  const speed = Math.max(0.25, Number(clip.speed ?? 1));
  return Math.max(0, Number(clip.end ?? 0) - Number(clip.start ?? 0)) / speed;
}

/** Apply only deterministic controls when the semantic Codex planner is absent. */
export function applyConservativeEditControls(
  rawPlan: unknown,
  params: AutoEditParams,
  sourceSize?: { width: number; height: number } | null,
): Record<string, unknown> {
  const plan = structuredClone(asRecord(rawPlan) ?? {});
  const output = asRecord(plan.output);
  const clips = Array.isArray(plan.clips)
    ? plan.clips.map((clip) => structuredClone(asRecord(clip) ?? {}))
    : [];
  if (!output || clips.length === 0) throw new Error("基础剪辑方案不完整");

  if (params.editAspect === "vertical") {
    output.width = 1080;
    output.height = 1920;
  } else if (params.editAspect === "horizontal") {
    output.width = 1920;
    output.height = 1080;
  } else if (params.editAspect === "source" && sourceSize) {
    const scale = Math.min(1, 1920 / Math.max(sourceSize.width, sourceSize.height));
    output.width = Math.max(240, Math.floor((sourceSize.width * scale) / 2) * 2);
    output.height = Math.max(240, Math.floor((sourceSize.height * scale) / 2) * 2);
  }

  if (params.editAudio === "mute") {
    for (const clip of clips) {
      if (clip.kind === "video") clip.mute = true;
    }
    plan.music = null;
    plan.voiceover = null;
    plan.sfx = [];
  }

  // The first uploaded video is always the editorial spine. A conservative
  // fallback is not allowed to turn an optional second video (or stills) into
  // an automatic montage merely because those files were supplied.
  const primaryVideoSource = clips.find((clip) => clip.kind === "video")?.source;
  let finalClips = primaryVideoSource
    ? clips.filter((clip) => clip.kind === "video" && clip.source === primaryVideoSource)
    : clips;
  const target = params.editTargetDuration;
  if (target > 0) {
    let remaining = target;
    const selectedClips = finalClips;
    finalClips = [];
    for (const clip of selectedClips) {
      if (remaining <= 0.001) break;
      const duration = clipDuration(clip);
      if (!(duration > 0)) continue;
      if (duration <= remaining + 0.001) {
        finalClips.push(clip);
        remaining -= duration;
        continue;
      }
      if (clip.kind === "image") {
        clip.duration = remaining;
      } else {
        const speed = Math.max(0.25, Number(clip.speed ?? 1));
        clip.end = Number(clip.start ?? 0) + remaining * speed;
      }
      finalClips.push(clip);
      remaining = 0;
    }
    const actualDuration = finalClips.reduce((sum, clip) => sum + clipDuration(clip), 0);
    if (actualDuration <= 0) throw new Error("目标时长没有可用画面");
    if (Array.isArray(plan.overlays)) {
      plan.overlays = plan.overlays.flatMap((item) => {
        const overlay = asRecord(item);
        if (!overlay || Number(overlay.start) >= actualDuration) return [];
        const end = Math.min(Number(overlay.end), actualDuration);
        return end > Number(overlay.start) ? [{ ...overlay, end }] : [];
      });
    }
  }
  plan.output = output;
  plan.clips = finalClips;
  // The conservative baseline does not make semantic transition decisions.
  // Clearing old transition indexes also prevents target-duration trimming
  // from leaving a boundary that now points past the retained clips.
  plan.transitions = [];
  plan.intent_summary = `${String(plan.intent_summary ?? "")} Conservative baseline only; preserves source order and applies requested mechanical output controls.`.trim();
  return plan;
}

function sourceSizeFromAnalysis(value: unknown): { width: number; height: number } | null {
  const analysis = asRecord(value);
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  for (const item of assets) {
    const asset = asRecord(item);
    if (asset?.kind !== "video") continue;
    const probe = asRecord(asset.probe);
    const video = asRecord(probe?.video);
    const width = Number(video?.width ?? probe?.width);
    const height = Number(video?.height ?? probe?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  }
  return null;
}

const SOURCE_BLACK_PADDING_SECONDS = 0.08;

function normalizedJobSource(value: string): string {
  return value.split("\\").join("/");
}

function checkedSourceBlackReports(
  report: SourceBlackReport,
): Map<string, SourceBlackSegment[]> {
  if (
    report.schema_version !== 1 ||
    typeof report.job_id !== "string" ||
    !report.job_id.trim() ||
    !Array.isArray(report.sources)
  ) {
    throw new Error("素材黑场检测报告无效");
  }
  const bySource = new Map<string, SourceBlackSegment[]>();
  for (const item of report.sources) {
    const record = asRecord(item);
    if (typeof record?.source !== "string" || !Array.isArray(record.segments)) {
      throw new Error("素材黑场检测报告缺少素材区间");
    }
    const source = normalizedJobSource(record.source);
    if (!source || bySource.has(source)) {
      throw new Error("素材黑场检测报告包含空素材或重复素材");
    }
    const segments = record.segments.map((entry) => {
      const segment = asRecord(entry);
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      const duration = Number(segment?.duration);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        !Number.isFinite(duration) ||
        start < 0 ||
        end <= start ||
        duration <= 0 ||
        Math.abs(end - start - duration) > 0.2
      ) {
        throw new Error("素材黑场检测报告区间无效");
      }
      return { start, end, duration };
    });
    bySource.set(source, segments);
  }
  return bySource;
}

/** Reject source-time ranges that would render a real blank interval. */
export function assertAutoEditPlanAvoidsSourceBlack(
  value: unknown,
  report: SourceBlackReport,
): void {
  const plan = asRecord(value);
  if (!Array.isArray(plan?.clips)) throw new Error("剪辑计划缺少可检查的片段");
  const bySource = checkedSourceBlackReports(report);
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = asRecord(plan.clips[index]);
    if (clip?.kind !== "video") continue;
    if (typeof clip.source !== "string" || !clip.source) {
      throw new Error(`剪辑计划第 ${index + 1} 个视频片段缺少素材路径`);
    }
    const source = normalizedJobSource(clip.source);
    const segments = bySource.get(source);
    if (!segments) throw new Error(`素材黑场检测报告未覆盖视频素材：${source}`);
    const start = Number(clip.start);
    const end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`剪辑计划第 ${index + 1} 个视频片段时间无效`);
    }
    const unsafe = segments.find((segment) => (
      start < segment.end + SOURCE_BLACK_PADDING_SECONDS &&
      end > Math.max(0, segment.start - SOURCE_BLACK_PADDING_SECONDS)
    ));
    if (unsafe) {
      throw new Error(
        `剪辑计划第 ${index + 1} 个视频片段与素材黑场禁用区间 ` +
        `${Math.max(0, unsafe.start - SOURCE_BLACK_PADDING_SECONDS).toFixed(2)}–` +
        `${(unsafe.end + SOURCE_BLACK_PADDING_SECONDS).toFixed(2)}s 重叠；请改用黑场前后的真实画面`,
      );
    }
  }
}

function parseFfmpegBlackSegments(stderr: string): SourceBlackSegment[] {
  const segments: SourceBlackSegment[] = [];
  const pattern = /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/gu;
  for (const match of stderr.matchAll(pattern)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const duration = Number(match[3]);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Number.isFinite(duration) &&
      start >= 0 &&
      end > start &&
      duration >= 0.35
    ) {
      segments.push({ start, end, duration });
    }
  }
  return segments;
}

/** Measure near-total black source intervals before the model chooses clips. */
async function createSourceBlackReport(options: {
  layout: LabLayout;
  jobRoot: string;
  analysis: unknown;
  signal: AbortSignal;
}): Promise<SourceBlackReport> {
  const canonicalJobRoot = assertPhysicalDirectory(options.jobRoot, "剪辑任务目录");
  const analysis = asRecord(options.analysis);
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const videos = assets.flatMap((item) => {
    const asset = asRecord(item);
    if (asset?.kind !== "video" || typeof asset.job_path !== "string") return [];
    const probe = asRecord(asset.probe);
    const durationSeconds = Number(probe?.duration_seconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`素材黑场检测缺少有效视频时长：${asset.job_path}`);
    }
    const source = normalizedJobSource(asset.job_path);
    const input = assertPhysicalFile(
      path.resolve(canonicalJobRoot, ...source.split("/")),
      canonicalJobRoot,
      "素材黑场检测视频",
    );
    return [{ source, input, durationSeconds }];
  });
  if (videos.length === 0) throw new Error("素材黑场检测没有找到视频");
  if (new Set(videos.map((video) => video.source)).size !== videos.length) {
    throw new Error("素材黑场检测发现重复视频");
  }
  const sources = await Promise.all(videos.map(async (video) => {
    const result = await runBoundedProcess({
      executable: options.layout.ffmpeg,
      args: [
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        video.input,
        "-vf",
        "fps=4,scale=160:-2,blackdetect=d=0.35:pix_th=0.10:pic_th=0.98",
        "-an",
        "-f",
        "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ],
      cwd: canonicalJobRoot,
      stage: "素材黑场检测",
      timeoutMs: Math.max(120_000, Math.min(15 * 60_000, 30_000 + video.durationSeconds * 500)),
      signal: options.signal,
    });
    return { source: video.source, segments: parseFfmpegBlackSegments(result.stderr) };
  }));
  const report: SourceBlackReport = {
    schema_version: 1,
    job_id: path.basename(canonicalJobRoot),
    sources,
  };
  const reportPath = path.join(canonicalJobRoot, "reports", "source-black.json");
  if (fs.existsSync(reportPath)) throw new Error("素材黑场检测报告已经存在");
  atomicWriteJson(reportPath, report);
  return report;
}

function selectEvenly(values: number[], count: number): number[] {
  if (count <= 0 || values.length === 0) return [];
  if (values.length <= count) return values;
  if (count === 1) return [values[Math.floor(values.length / 2)]];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (count - 1))],
  );
}

/** Build an evidence-efficient mix of hook, transition and whole-video frames. */
export function buildPlanningSampleTimes(
  durationSeconds: number,
  sceneCandidates: readonly number[],
  maximumFrames = 48,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const duration = durationSeconds;
  const frameLimit = Math.max(
    1,
    Math.min(maximumFrames, Math.max(12, Math.ceil(duration * 2))),
  );
  // Container duration can extend one frame beyond the last decodable video
  // timestamp. Seeking into that gap makes FFmpeg exit 0 without an image.
  const lastSafeTime = Math.max(0, duration - 0.35);
  const selected = new Map<string, number>();
  const add = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const value = Math.max(0, Math.min(lastSafeTime, raw));
    selected.set(value.toFixed(2), Number(value.toFixed(3)));
  };

  const denseHook = [0, 0.15, 0.35, 0.6, 0.9, 1.25, 1.65, 2.1, 2.55, 2.95]
    .filter((value) => value <= lastSafeTime);
  const hookBudget = Math.min(denseHook.length, Math.max(4, Math.round(frameLimit * 0.22)));
  for (const value of selectEvenly(denseHook, hookBudget)) add(value);

  const validScenes = [...sceneCandidates]
    .filter((value) => Number.isFinite(value) && value > 0.1 && value < lastSafeTime)
    .sort((left, right) => left - right);
  const sceneFrameBudget = Math.min(
    Math.max(0, frameLimit - selected.size - 2),
    Math.round(frameLimit * 0.5),
  );
  const boundaryCount = Math.min(validScenes.length, Math.floor(sceneFrameBudget / 2));
  for (const boundary of selectEvenly(validScenes, boundaryCount)) {
    add(boundary - 0.1);
    add(boundary + 0.1);
  }

  const initialUniformCount = Math.max(2, frameLimit - selected.size);
  for (let index = 0; index < initialUniformCount; index += 1) {
    add(((index + 0.5) * duration) / initialUniformCount);
  }
  // Deduplication around short videos may leave space; refill uniformly.
  for (let index = 0; selected.size < frameLimit && index < frameLimit * 4; index += 1) {
    add(((index + 0.5) * duration) / (frameLimit * 4));
  }
  const times = [...selected.values()]
    .sort((left, right) => left - right)
    .slice(0, frameLimit);
  // The watermark gate requires an observed frame near the proposed interval
  // end. A uniform midpoint grid can otherwise stop >0.75s before the end.
  if (times.length > 1 && times[times.length - 1] < lastSafeTime - 0.25) {
    times[times.length - 1] = Number(lastSafeTime.toFixed(3));
  }
  return times;
}

function timestampLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}m${remainder.toFixed(2).padStart(5, "0")}s`;
}

function ffmpegFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function renderContactSheetPage(options: {
  layout: LabLayout;
  jobRoot: string;
  inputVideo: string;
  times: number[];
  outputPath: string;
  page: number;
  signal: AbortSignal;
  retryOnEmpty?: boolean;
}): Promise<void> {
  const padded = [...options.times];
  while (padded.length < 12) padded.push(padded[padded.length - 1] ?? 0);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const time of padded.slice(0, 12)) {
    args.push("-ss", time.toFixed(3), "-i", options.inputVideo);
  }
  const font = ffmpegFilterPath(options.layout.timestampFont);
  const cells = padded.slice(0, 12).map((time, index) =>
    `[${index}:v]scale=320:320:force_original_aspect_ratio=decrease,` +
    "pad=320:320:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1," +
    `drawtext=fontfile='${font}':text='${timestampLabel(time)}':` +
    "x=10:y=h-th-10:fontsize=24:fontcolor=white:" +
    `box=1:boxcolor=black@0.68:boxborderw=6[v${index}]`,
  );
  const streams = padded.slice(0, 12).map((_, index) => `[v${index}]`).join("");
  const layout = Array.from({ length: 12 }, (_, index) =>
    `${(index % 4) * 320}_${Math.floor(index / 4) * 320}`,
  ).join("|");
  const filter = [
    ...cells,
    `${streams}xstack=inputs=12:layout=${layout}:fill=0x111111[stacked]`,
    // Current FFmpeg's MJPEG encoder rejects limited-range YUV on some
    // post-render pages. Make the JPEG range explicit so semantic review does
    // not disappear after a technically successful render.
    "[stacked]format=yuvj420p[sheet]",
  ].join(";");
  args.push(
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filter,
    "-map",
    "[sheet]",
    "-frames:v",
    "1",
    "-threads",
    "2",
    "-q:v",
    "3",
    options.outputPath,
  );
  await runBoundedProcess({
    executable: options.layout.ffmpeg,
    args,
    cwd: options.jobRoot,
    stage: `画面取样第 ${options.page} 页`,
    timeoutMs: 5 * 60_000,
    signal: options.signal,
  });
  // FFmpeg's image muxer may return 0 when one seek is past the final frame,
  // leaving no output at all. Retry once with earlier, still representative
  // timestamps instead of turning a valid upload into a failed task.
  if (!fs.existsSync(options.outputPath)) {
    if (options.retryOnEmpty === false) {
      throw new Error(`画面取样第 ${options.page} 页未生成，请检查视频尾帧`);
    }
    await renderContactSheetPage({
      ...options,
      times: options.times.map((time) => Math.max(0, time - 0.75)),
      retryOnEmpty: false,
    });
  }
}

async function createPlanningVisualEvidence(options: {
  layout: LabLayout;
  jobRoot: string;
  analysis: unknown;
  signal: AbortSignal;
}): Promise<string[]> {
  const analysis = asRecord(options.analysis);
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const videos = assets
    .map(asRecord)
    .filter(
      (asset): asset is Record<string, unknown> =>
        asset?.kind === "video" && typeof asset.job_path === "string",
    )
    .slice(0, 2);
  if (videos.length === 0) {
    throw new Error("视频分析没有找到主视频");
  }
  const canonicalJobRoot = assertPhysicalDirectory(options.jobRoot, "剪辑任务目录");
  const reportsRoot = assertPhysicalDirectory(
    path.join(canonicalJobRoot, "reports"),
    "剪辑分析目录",
  );
  const imagePaths = assets.flatMap((item, index) => {
    const asset = asRecord(item);
    if (asset?.kind !== "image" || typeof asset.job_path !== "string") return [];
    return [
      assertPhysicalFile(
        path.resolve(canonicalJobRoot, asset.job_path),
        canonicalJobRoot,
        `剪辑参考图片${index + 1}`,
      ),
    ];
  });
  const maximumPages = Math.max(videos.length, Math.min(4, 17 - imagePaths.length));
  const pageAllocations = videos.map((_, index) => {
    const base = Math.floor(maximumPages / videos.length);
    return base + (index < maximumPages % videos.length ? 1 : 0);
  });
  const sheets: string[] = [];
  for (const [videoIndex, video] of videos.entries()) {
    const probe = asRecord(video.probe);
    const duration = Number(probe?.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`视频${videoIndex + 1}分析没有有效时长`);
    }
    const inputVideo = assertPhysicalFile(
      path.resolve(canonicalJobRoot, String(video.job_path)),
      canonicalJobRoot,
      videoIndex === 0 ? "剪辑主视频" : "剪辑辅助视频",
    );
    const sceneCandidates = Array.isArray(video.scene_candidates_seconds)
      ? video.scene_candidates_seconds.map(Number).filter(Number.isFinite)
      : [];
    const sampleTimes = buildPlanningSampleTimes(
      duration,
      sceneCandidates,
      pageAllocations[videoIndex] * 12,
    );
    const pageCount = Math.max(1, Math.ceil(sampleTimes.length / 12));
    for (let page = 0; page < pageCount; page += 1) {
      const output = path.join(
        reportsRoot,
        `planning-video-${String(videoIndex + 1).padStart(2, "0")}-contact-sheet-${String(page + 1).padStart(2, "0")}.jpg`,
      );
      if (fs.existsSync(output)) throw new Error("剪辑画面接触表已经存在");
      await renderContactSheetPage({
        layout: options.layout,
        jobRoot: canonicalJobRoot,
        inputVideo,
        times: sampleTimes.slice(page * 12, (page + 1) * 12),
        outputPath: output,
        page: page + 1,
        signal: options.signal,
      });
      const sheet = assertPhysicalFile(output, reportsRoot, "剪辑画面接触表");
      const sheetSize = fs.statSync(sheet).size;
      if (sheetSize <= 0 || sheetSize > 25 * 1024 * 1024) {
        throw new Error("剪辑画面接触表大小异常");
      }
      sheets.push(sheet);
    }
    // Contact-sheet thumbnails are only 320px: tiny account names and late
    // platform stamps need full-frame detail. Reuse the same planning call.
    const detailBudget = Math.min(6, Math.floor((17 - maximumPages - imagePaths.length) / videos.length));
    // Retain first/middle/late/tail when budget is small; use spare slots for
    // quarter/three-quarter views, so intermediate changes are not tiny-only.
    const detailTimes = [0, duration * .5, Math.max(0, duration - 2), Math.max(0, duration - .35), duration * .25, duration * .75].slice(0, detailBudget);
    for (const time of [...new Set(detailTimes.map(t => Number(t.toFixed(3))))]) {
      const output = path.join(reportsRoot, `watermark-detail-video-${videoIndex + 1}-ms-${Math.round(time * 1000)}.jpg`);
      await runBoundedProcess({
        executable: options.layout.ffmpeg,
        args: ["-hide_banner", "-loglevel", "error", "-ss", time.toFixed(3), "-i", inputVideo,
          "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease,format=yuvj420p", "-frames:v", "1", "-threads", "2", "-q:v", "2", output],
        cwd: canonicalJobRoot, stage: "水印细节取样", timeoutMs: 60_000, signal: options.signal,
      });
      // A container can extend beyond its last video frame. Missing optional
      // tail detail must not discard the already verified contact sheets.
      if (fs.existsSync(output) && fs.statSync(output).size > 0) sheets.push(assertPhysicalFile(output, reportsRoot, "水印细节图"));
    }
  }
  const evidence = [...sheets, ...imagePaths];
  if (evidence.length > 17) throw new Error("剪辑视觉证据数量超过安全上限");
  return evidence;
}

function planClips(value: unknown): Record<string, unknown>[] {
  const plan = asRecord(value);
  return Array.isArray(plan?.clips)
    ? plan.clips.flatMap((clip) => {
        const record = asRecord(clip);
        return record ? [record] : [];
      })
    : [];
}

function transitionDurationsByBoundary(value: unknown): Map<number, number> {
  const plan = asRecord(value);
  const transitions = Array.isArray(plan?.transitions) ? plan.transitions : [];
  const result = new Map<number, number>();
  for (const entry of transitions) {
    const transition = asRecord(entry);
    const boundary = Number(transition?.after_clip);
    const duration = Number(transition?.duration);
    if (!Number.isInteger(boundary) || boundary < 0 || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }
    result.set(boundary, duration);
  }
  return result;
}

/** Final-timeline hard-cut points, excluding rendered overlap transitions. */
export function buildAutoEditCutTimes(value: unknown): number[] {
  const clips = planClips(value);
  const transitionDurations = transitionDurationsByBoundary(value);
  const cuts: number[] = [];
  let cursor = 0;
  for (let index = 0; index < clips.length - 1; index += 1) {
    cursor += clipDuration(clips[index]);
    const transitionDuration = transitionDurations.get(index) ?? 0;
    if (transitionDuration > 0) {
      cursor = Math.max(0, cursor - transitionDuration);
      continue;
    }
    if (Number.isFinite(cursor) && cursor > 0) cuts.push(Number(cursor.toFixed(3)));
  }
  return cuts.slice(0, 128);
}

export function shouldAttemptAudioEdgeRepair(
  quality: AutoEditQualityResult,
  plan: unknown,
  editAudio: EditAudio,
): boolean {
  if (editAudio !== "keep" || buildAutoEditCutTimes(plan).length === 0) return false;
  const errors = quality.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0 || errors.some((issue) => issue.code !== "AUDIO_CUT_DISCONTINUITY")) {
    return false;
  }
  const currentFade = Number(asRecord(asRecord(plan)?.finishing)?.audio_edge_fade_ms ?? 0);
  return Number.isFinite(currentFade) && currentFade < 80;
}

/** Midpoints of real rendered overlap transitions for visual review only. */
export function buildAutoEditTransitionTimes(value: unknown): number[] {
  const clips = planClips(value);
  const transitionDurations = transitionDurationsByBoundary(value);
  const times: number[] = [];
  let cursor = 0;
  for (let index = 0; index < clips.length - 1; index += 1) {
    cursor += clipDuration(clips[index]);
    const transitionDuration = transitionDurations.get(index) ?? 0;
    if (transitionDuration <= 0) continue;
    times.push(Number(Math.max(0, cursor - transitionDuration / 2).toFixed(3)));
    cursor = Math.max(0, cursor - transitionDuration);
  }
  return times.slice(0, 128);
}

/**
 * Build a compact post-render review set: dense hook samples, both sides of
 * real cuts, overlay midpoints and uniform coverage. The reviewer sees the
 * rendered result, not the planning contact sheet.
 */
export function buildPostRenderReviewTimes(
  value: unknown,
  durationSeconds: number,
  maximumFrames = 24,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const limit = Math.max(1, Math.min(24, maximumFrames));
  const planOutput = asRecord(asRecord(value)?.output);
  const rawFps = Number(planOutput?.fps);
  const fps = Number.isFinite(rawFps) && rawFps >= 12 ? rawFps : 24;
  // Container duration can include AAC padding. Even a nominal 40ms inset
  // can seek past the last real video frame and make xstack emit no JPEG.
  const lastSafeTime = Math.max(0,
    durationSeconds - Math.min(Math.max(0.12, 2 / fps), durationSeconds * 0.5));
  const selected = new Map<string, number>();
  const add = (raw: number) => {
    if (!Number.isFinite(raw) || selected.size >= limit) return;
    const value = Math.max(0, Math.min(lastSafeTime, raw));
    selected.set(value.toFixed(3), Number(value.toFixed(3)));
  };

  // Reserve whole-film coverage before hook/cut detail can consume the frame
  // budget. Keeping the last decodable instant also guarantees a sample at or
  // beyond 90% for ordinary video durations.
  if (limit === 1) return [Number(lastSafeTime.toFixed(3))];
  add(0);
  add(lastSafeTime);
  add(Math.min(lastSafeTime, durationSeconds * 0.9));
  const uniformAnchors = Math.min(
    Math.max(0, limit - selected.size),
    Math.max(4, Math.floor(limit / 4)),
  );
  for (let index = 1; index <= uniformAnchors; index += 1) {
    add((index * lastSafeTime) / (uniformAnchors + 1));
  }

  for (const time of [0, 0.12, 0.3, 0.55, 0.85, 1.2, 1.65, 2.15, 2.7, 2.95]) {
    if (time <= lastSafeTime) add(time);
  }

  const cutTimes = buildAutoEditCutTimes(value).filter(
    (time) => time > 0.08 && time < lastSafeTime - 0.08,
  );
  const cutBudget = Math.max(0, Math.min(cutTimes.length, Math.floor((limit - selected.size) / 2)));
  for (const cut of selectEvenly(cutTimes, cutBudget)) {
    add(cut - 0.08);
    add(cut + 0.08);
  }
  for (const transition of selectEvenly(
    buildAutoEditTransitionTimes(value),
    Math.max(0, Math.min(3, limit - selected.size)),
  )) {
    add(transition);
  }

  const plan = asRecord(value);
  const overlays = Array.isArray(plan?.overlays) ? plan.overlays : [];
  const overlayTimes = overlays.flatMap((entry) => {
    const overlay = asRecord(entry);
    const start = Number(overlay?.start);
    const end = Number(overlay?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [(start + end) / 2]
      : [];
  });
  for (const time of selectEvenly(overlayTimes, Math.max(0, Math.min(4, limit - selected.size)))) {
    add(time);
  }

  const pictureInPicture = Array.isArray(plan?.picture_in_picture)
    ? plan.picture_in_picture
    : [];
  const insetTimes = pictureInPicture.flatMap((entry) => {
    const inset = asRecord(entry);
    const start = Number(inset?.start);
    const end = Number(inset?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [start + 0.04, (start + end) / 2, end - 0.04]
      : [];
  });
  for (const time of selectEvenly(insetTimes, Math.max(0, Math.min(6, limit - selected.size)))) {
    add(time);
  }

  for (let index = 0; selected.size < limit && index < limit * 6; index += 1) {
    add((index * lastSafeTime) / Math.max(1, limit * 6 - 1));
  }
  return [...selected.values()].sort((left, right) => left - right).slice(0, limit);
}

function sourceFactsFromAnalysis(value: unknown): AutoEditSourceFact[] {
  const analysis = asRecord(value);
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  return assets.flatMap((item) => {
    const asset = asRecord(item);
    if (asset?.kind !== "video" || typeof asset.job_path !== "string") return [];
    const probe = asRecord(asset.probe);
    const video = asRecord(probe?.video);
    const width = Number(video?.width ?? probe?.width);
    const height = Number(video?.height ?? probe?.height);
    const rotation = Number(
      video?.rotation_degrees ?? video?.rotation ?? probe?.rotation_degrees ?? probe?.rotation,
    );
    return [{
      source: asset.job_path,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      ...(Number.isFinite(rotation) ? { rotationDegrees: rotation } : {}),
    }];
  });
}

/** Apply renderer-supported safety defaults without changing editorial choices. */
export function applySafeAutoEditFinishingDefaults(
  value: unknown,
  editAudio: EditAudio,
  editMode: EditMode = "smart",
  captionStyle: CaptionStyle = "clean",
): Record<string, unknown> {
  const plan = structuredClone(asRecord(value) ?? {});
  const clips = planClips(plan);
  const audibleCuts = clips.slice(1).filter((clip, index) => {
    const previous = clips[index];
    return previous.kind === "video" && clip.kind === "video" &&
      previous.mute !== true && clip.mute !== true;
  }).length;
  const finishing = asRecord(plan.finishing) ?? {};
  const currentFade = Number(finishing.audio_edge_fade_ms);
  if (
    editAudio === "keep" &&
    audibleCuts > 0 &&
    (!Number.isFinite(currentFade) || currentFade < 8)
  ) {
    finishing.audio_edge_fade_ms = 18;
  }
  finishing.loudness_target_lufs = editAudio === "mute"
    ? null
    : editMode === "product_demo"
      ? captionStyle === "punchy" ? -12.5 : -13
      : -14;
  finishing.true_peak_limit_db = editMode === "product_demo" ? -1 : -1.5;
  plan.finishing = finishing;
  const output = asRecord(plan.output);
  const outputWidth = Number(output?.width);
  const outputHeight = Number(output?.height);
  if (Array.isArray(plan.overlays)) {
    plan.overlays = plan.overlays.map((value) => {
      const overlay = asRecord(value);
      if (!overlay) return value;
      const adjusted = { ...overlay };
      const x = Number(adjusted.x);
      const y = Number(adjusted.y);
      if (overlay.kind === "caption") {
        if (Number.isFinite(x)) {
          adjusted.x = x >= 0 && x <= 1
            ? Math.max(0.08, Math.min(0.92, x))
            : Number.isFinite(outputWidth) && outputWidth > 0
              ? Math.round(
                  Math.max(outputWidth * 0.08, Math.min(outputWidth * 0.92, x)) * 1_000,
                ) / 1_000
              : x;
        }
        if (Number.isFinite(y)) {
          adjusted.y = y >= 0 && y <= 1
            ? Math.max(0.12, Math.min(0.78, y))
            : Number.isFinite(outputHeight) && outputHeight > 0
              ? Math.round(
                  Math.max(outputHeight * 0.12, Math.min(outputHeight * 0.78, y)) * 1_000,
                ) / 1_000
              : y;
        }
      } else if (
        (overlay.kind === "title" || overlay.kind === "label") &&
        Number.isFinite(x)
      ) {
        const preset = String(overlay.preset ?? "");
        const textLength = Array.from(String(overlay.text ?? "").trim()).length;
        const isWideDisplay = [
          "feature",
          "badge",
          "cta",
          "fine_cta",
          "fine_step_action",
        ].includes(preset);
        const isLargeDisplay = ["hook", "fine_hook"].includes(preset);
        const horizontalMargin = isWideDisplay
          ? textLength >= 20 ? 0.38 : textLength >= 12 ? 0.28 : 0.18
          : isLargeDisplay
            ? textLength >= 16 ? 0.32 : textLength >= 10 ? 0.24 : 0.14
            : preset === "fine_accent"
              ? textLength >= 12 ? 0.26 : 0.18
              : 0.12;
        adjusted.x = x >= 0 && x <= 1
          ? Math.max(horizontalMargin, Math.min(1 - horizontalMargin, x))
          : Number.isFinite(outputWidth) && outputWidth > 0
            ? Math.round(
                Math.max(
                  outputWidth * horizontalMargin,
                  Math.min(outputWidth * (1 - horizontalMargin), x),
                ) * 1_000,
              ) / 1_000
            : x;
      }
      return adjusted;
    });
  }
  return plan;
}

export function resolveAutoEditReviewDecision(
  decision: "pass" | "repair" | "needs_attention",
  deterministicQuality: AutoEditQualityResult,
): "pass" | "repair" | "needs_attention" {
  // A probabilistic visual review may overlook a machine-measured fault. It
  // may request a repair, but it can never waive a deterministic hard error.
  if (decision === "pass" && deterministicQuality.errorCount > 0) {
    return "needs_attention";
  }
  return decision;
}

/** Preserve technical output invariants and give the repaired render a new file. */
export function prepareAutoEditRepairPlan(
  initialValue: unknown,
  revisedValue: unknown,
  repairedFilename = "review-repaired.mp4",
  preserveWatermarks = true,
): Record<string, unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.mp4$/u.test(repairedFilename)) {
    throw new Error("自动修片输出文件名无效");
  }
  const initial = asRecord(initialValue);
  const revised = structuredClone(asRecord(revisedValue) ?? {});
  const initialOutput = asRecord(initial?.output);
  const revisedOutput = asRecord(revised.output);
  if (!initial || !initialOutput || !revisedOutput || planClips(revised).length === 0) {
    throw new Error("自动修片方案不完整");
  }
  for (const key of [
    "width",
    "height",
    "fps",
    "video_codec",
    "crf",
    "preset",
    "audio_bitrate",
  ]) {
    revisedOutput[key] = initialOutput[key];
  }
  revisedOutput.filename = repairedFilename;
  revised.output = revisedOutput;
  revised.schema_version = initial.schema_version;
  revised.job_id = initial.job_id;
  // Reviewing a cleaned frame must not infer that the original is clean.
  // An unrelated subtitle/cut repair keeps the already executed source cleanup.
  if (preserveWatermarks && asRecord(initial.watermark_cleanup)) {
    const cleanup = structuredClone(asRecord(initial.watermark_cleanup)!);
    const used = new Set([...planClips(revised), ...(Array.isArray(revised.picture_in_picture) ? revised.picture_in_picture : [])].map(c => asRecord(c)?.source));
    if (Array.isArray(cleanup.regions)) cleanup.regions = cleanup.regions.filter(r => used.has(asRecord(r)?.source));
    revised.watermark_cleanup = cleanup;
  }
  return revised;
}

export function compactQualityIssues(result: AutoEditQualityResult): Array<{
  code: string;
  severity: "warning" | "error";
  message: string;
  atSeconds: number | null;
}> {
  const ordered = [...result.issues]
    .sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1));
  const selected: typeof ordered = [];
  const perCode = new Map<string, number>();
  for (const maximumPerCode of [1, 2]) {
    for (const issue of ordered) {
      if (selected.length >= 16) break;
      const count = perCode.get(issue.code) ?? 0;
      if (count >= maximumPerCode || selected.includes(issue)) continue;
      selected.push(issue);
      perCode.set(issue.code, count + 1);
    }
  }
  return selected.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      atSeconds: issue.atSeconds ?? null,
    }));
}

function compactReviewIssues(value: unknown[]): AutoEditReviewDiagnosticIssue[] {
  return value.slice(0, 12).flatMap((item) => {
    const issue = asRecord(item);
    const severity = issue?.severity;
    const code = typeof issue?.code === "string" ? issue.code.slice(0, 64) : "";
    const evidence = typeof issue?.evidence === "string" ? issue.evidence.trim().slice(0, 500) : "";
    const repair = typeof issue?.repair === "string" ? issue.repair.trim().slice(0, 500) : "";
    if (!code || (severity !== "warning" && severity !== "error") || !evidence || !repair) {
      return [];
    }
    const start = issue?.start === null ? null : Number(issue?.start);
    const end = issue?.end === null ? null : Number(issue?.end);
    return [{
      code,
      severity,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      evidence,
      repair,
    }];
  });
}

function conciseAttentionHint(
  reviewIssues: AutoEditReviewDiagnosticIssue[],
  quality: AutoEditQualityResult,
): string {
  const reviewHintByCode: Record<string, string> = {
    BRIEF_MISMATCH: "确认成片内容是否符合你填写的要求",
    WEAK_HOOK: "重点看开头 3 秒是否足够抓人",
    DISCONTINUITY: "重点看镜头衔接和人物动作是否连续",
    BAD_CROP: "重点看主体、产品和字幕有没有被裁掉",
    BLACK_BORDER: "重点看画面四周是否出现黑边",
    ROTATION: "重点看成片方向是否正确",
    CAPTION_UNREADABLE: "重点看字幕大小、位置和停留时间",
    CAPTION_DUPLICATE: "重点看画面文字是否重复出现",
    MECHANICAL_PACING: "重点看剪辑节奏是否过于均匀",
    INCOMPLETE_ACTION: "重点看关键动作是否完整",
    REPEATED_SHOT: "重点看是否重复使用了相同画面",
    WEAK_ENDING: "重点看结尾是否完整、有明确收束",
    AUDIO_DISCONTINUITY: "重点听切点是否有爆音或音量突变",
  };
  const prioritizedReviewIssue = reviewIssues.find((issue) => issue.severity === "error")
    ?? reviewIssues[0];
  const reviewHint = prioritizedReviewIssue
    ? reviewHintByCode[prioritizedReviewIssue.code]
    : undefined;
  const qualityHint = compactQualityIssues(quality).find((issue) => issue.severity === "error")?.message;
  const hint = (qualityHint ?? reviewHint ?? "重点播放检查开头、字幕、切点和收尾").trim();
  return hint.length > 90 ? `${hint.slice(0, 89)}…` : hint;
}

/** Prefer the real video stream over longer container/audio padding. */
export function resolveReviewVideoDuration(value: unknown, containerDuration: number): number {
  const probe = asRecord(value);
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const stream = asRecord(streams[0]);
  const streamDuration = Number(stream?.duration);
  const frames = Number(stream?.nb_frames);
  const rate = String(stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : NaN;
  const candidates = [containerDuration, streamDuration,
    Number.isFinite(frames) && frames > 0 && fps > 0 ? frames / fps : NaN,
  ].filter((duration) => Number.isFinite(duration) && duration > 0);
  if (candidates.length === 0) throw new Error("成片没有有效画面时长");
  return Math.min(...candidates);
}

async function createPostRenderReviewEvidence(options: {
  layout: LabLayout;
  jobRoot: string;
  outputFile: string;
  plan: unknown;
  durationSeconds: number;
  signal: AbortSignal;
}): Promise<string[]> {
  const canonicalJobRoot = assertPhysicalDirectory(options.jobRoot, "剪辑任务目录");
  const outputRoot = assertPhysicalDirectory(path.join(canonicalJobRoot, "output"), "剪辑输出目录");
  const outputFile = assertPhysicalFile(options.outputFile, outputRoot, "剪辑成片");
  const reportsRoot = assertPhysicalDirectory(
    path.join(canonicalJobRoot, "reports"),
    "剪辑分析目录",
  );
  const probe = await runBoundedProcess({
    executable: options.layout.ffprobe,
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=duration,nb_frames,avg_frame_rate", "-of", "json", outputFile],
    cwd: canonicalJobRoot, stage: "成片画面时长检查", timeoutMs: 30_000, signal: options.signal,
  });
  const videoDuration = resolveReviewVideoDuration(JSON.parse(probe.stdout), options.durationSeconds);
  const times = buildPostRenderReviewTimes(options.plan, videoDuration, 24);
  if (times.length === 0) throw new Error("成片复检没有有效时间点");
  const sheets: string[] = [];
  const pageCount = Math.min(2, Math.max(1, Math.ceil(times.length / 12)));
  for (let page = 0; page < pageCount; page += 1) {
    const outputPath = path.join(
      reportsRoot,
      `review-contact-sheet-${String(page + 1).padStart(2, "0")}.jpg`,
    );
    await fs.promises.rm(outputPath, { force: true });
    await renderContactSheetPage({
      layout: options.layout,
      jobRoot: canonicalJobRoot,
      inputVideo: outputFile,
      times: times.slice(page * 12, (page + 1) * 12),
      outputPath,
      page: page + 1,
      signal: options.signal,
    });
    sheets.push(assertPhysicalFile(outputPath, reportsRoot, "成片复检接触表"));
  }
  const qaFramesRoot = path.join(reportsRoot, "qa-frames");
  const qaFrames = fs.existsSync(qaFramesRoot)
    ? ["start.jpg", "middle.jpg", "end.jpg"].flatMap((name) => {
        const candidate = path.join(qaFramesRoot, name);
        return fs.existsSync(candidate)
          ? [assertPhysicalFile(candidate, assertPhysicalDirectory(qaFramesRoot, "成片检查画面目录"), "成片检查画面")]
          : [];
      })
    : [];
  return [...sheets, ...qaFrames].slice(0, 10);
}

async function measurePostRenderQuality(options: {
  layout: LabLayout;
  jobRoot: string;
  outputFile: string;
  plan: unknown;
  durationSeconds: number;
  signal: AbortSignal;
}): Promise<AutoEditPostRenderMetrics> {
  const projectRoot = assertPhysicalDirectory(PROJECT_ROOT, "镜序项目目录");
  const script = assertPhysicalFile(
    path.join(projectRoot, "tools", "measure_auto_edit_quality.py"),
    projectRoot,
    "成片质量检查工具",
  );
  const canonicalJobRoot = assertPhysicalDirectory(options.jobRoot, "剪辑任务目录");
  const outputRoot = assertPhysicalDirectory(path.join(canonicalJobRoot, "output"), "剪辑输出目录");
  const outputFile = assertPhysicalFile(options.outputFile, outputRoot, "剪辑成片");
  const reportsRoot = assertPhysicalDirectory(path.join(canonicalJobRoot, "reports"), "剪辑分析目录");
  const resultPath = path.join(reportsRoot, "quality-measurements.json");
  const cutTimes = buildAutoEditCutTimes(options.plan);
  await fs.promises.rm(resultPath, { force: true });
  await runBoundedProcess({
    executable: options.layout.python,
    args: [
      script,
      "--input",
      outputFile,
      "--ffmpeg",
      options.layout.ffmpeg,
      "--ffprobe",
      options.layout.ffprobe,
      "--cut-times-json",
      JSON.stringify(cutTimes),
      "--output",
      resultPath,
    ],
    cwd: projectRoot,
    stage: "成片画面与声音检查",
    timeoutMs: 15 * 60_000,
    signal: options.signal,
  });
  const measured = JSON.parse(fs.readFileSync(resultPath, "utf8")) as unknown;
  return parseAutoEditQualityMetrics(measured, {
    durationSeconds: options.durationSeconds,
    expectedAudioCutTimes: cutTimes,
  });
}

export function summarizeAutoEditQa(value: unknown): AutoEditQaSummary {
  const report = asRecord(value);
  const observed = asRecord(report?.observed);
  const video = asRecord(observed?.video);
  const audio = asRecord(observed?.audio);
  const checks = asRecord(report?.checks);
  if (
    report?.status !== "LOCAL_TECHNICAL_QA_PASS" ||
    checks?.full_decode !== true ||
    checks?.video_stream_present !== true
  ) {
    throw new Error("成片没有通过完整解码检查");
  }
  const blackSpans = Array.isArray(report.black_spans_over_0_5_seconds)
    ? report.black_spans_over_0_5_seconds
    : [];
  const durationSeconds = numberValue(observed?.duration_seconds, "视频时长");
  const validBlackSpans = blackSpans.flatMap((entry) => {
    const span = asRecord(entry);
    if (!span) throw new Error("成片黑屏检查结果格式异常");
    const start = numberValue(span.start, "黑屏开始时间");
    const end = numberValue(span.end, "黑屏结束时间");
    const duration = numberValue(span.duration, "黑屏时长");
    if (end < start || Math.abs(end - start - duration) > 0.35) {
      throw new Error("成片黑屏检查结果格式异常");
    }
    return [{ start, end, duration }];
  });
  const longestBlackSeconds = validBlackSpans.reduce(
    (maximum, span) => Math.max(maximum, span.duration),
    0,
  );
  const totalBlackSeconds = validBlackSpans.reduce(
    (total, span) => total + span.duration,
    0,
  );
  // A short fade is normal. One obvious long blackout, or repeated black gaps
  // occupying a meaningful share of the result, is not a deliverable video.
  if (
    longestBlackSeconds >= 1.5 ||
    (totalBlackSeconds >= 1 && totalBlackSeconds / Math.max(durationSeconds, 0.001) >= 0.12)
  ) {
    throw new Error(
      `成片检测到明显黑屏（最长 ${longestBlackSeconds.toFixed(1)} 秒），请点击重试`,
    );
  }
  const sampleFrames = Array.isArray(report.sample_frames) ? report.sample_frames : [];
  return {
    status: "passed",
    durationSeconds,
    width: numberValue(video?.width, "画面宽度"),
    height: numberValue(video?.height, "画面高度"),
    fps: numberValue(video?.fps, "帧率"),
    audioPresent: Boolean(audio) && checks?.audio_stream_present === true,
    fullDecode: true,
    blackFrameSpanCount: validBlackSpans.length,
    sampledFrameCount: sampleFrames.length,
    note: "已完成本地完整解码与技术检查；画面审美和发布平台兼容性仍需人工观看确认。",
  };
}

function assertJobDirectory(layout: LabLayout, jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("剪辑任务编号无效");
  const candidate = path.resolve(layout.jobsRoot, jobId);
  if (!isSamePath(path.dirname(candidate), layout.jobsRoot)) {
    throw new Error("剪辑任务目录无效");
  }
  return candidate;
}

function assertPhysicalTree(root: string): void {
  const canonicalRoot = fs.realpathSync.native(/* turbopackIgnore: true */ root);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stat = fs.lstatSync(/* turbopackIgnore: true */ current);
    if (stat.isSymbolicLink()) throw new Error("剪辑临时目录含重定向路径");
    const canonical = fs.realpathSync.native(/* turbopackIgnore: true */ current);
    if (!isSamePath(canonical, canonicalRoot) && !isWithin(canonicalRoot, canonical)) {
      throw new Error("剪辑临时目录越界");
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ current, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) throw new Error("剪辑临时目录含重定向路径");
      pending.push(path.join(current, entry.name));
    }
  }
}

async function assertPhysicalTreeAsync(root: string): Promise<void> {
  const canonicalRoot = await fs.promises.realpath(root);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("剪辑临时目录含重定向路径");
    const canonical = await fs.promises.realpath(current);
    if (!isSamePath(canonical, canonicalRoot) && !isWithin(canonicalRoot, canonical)) {
      throw new Error("剪辑临时目录越界");
    }
    if (!stat.isDirectory()) continue;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("剪辑临时目录含重定向路径");
      pending.push(path.join(current, entry.name));
    }
  }
}

function removeExactJob(layout: LabLayout, jobId: string): boolean {
  const candidate = assertJobDirectory(layout, jobId);
  if (!fs.existsSync(candidate)) return false;
  const stat = fs.lstatSync(/* turbopackIgnore: true */ candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("拒绝清理异常剪辑任务目录");
  }
  const canonical = fs.realpathSync.native(/* turbopackIgnore: true */ candidate);
  if (!isWithin(layout.jobsRoot, canonical) || !isSamePath(path.dirname(canonical), layout.jobsRoot)) {
    throw new Error("拒绝清理越界剪辑任务目录");
  }
  assertPhysicalTree(candidate);
  fs.rmSync(/* turbopackIgnore: true */ candidate, { recursive: true, force: true });
  return true;
}

async function removeExactJobAsync(layout: LabLayout, jobId: string): Promise<boolean> {
  const candidate = assertJobDirectory(layout, jobId);
  try {
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("拒绝清理异常剪辑任务目录");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const canonical = await fs.promises.realpath(candidate);
  if (!isWithin(layout.jobsRoot, canonical) || !isSamePath(path.dirname(canonical), layout.jobsRoot)) {
    throw new Error("拒绝清理越界剪辑任务目录");
  }
  await assertPhysicalTreeAsync(candidate);
  await fs.promises.rm(candidate, { recursive: true, force: true });
  return true;
}

export function cleanupStaleAutoEditJobs(now = Date.now()): number {
  const layout = resolveLabLayout();
  let removed = 0;
  for (const entry of fs.readdirSync(/* turbopackIgnore: true */ layout.jobsRoot, {
    withFileTypes: true,
  })) {
    const match = JOB_ID_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const taskId = Number(match[1]);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) continue;
    const candidate = assertJobDirectory(layout, entry.name);
    const stat = fs.lstatSync(/* turbopackIgnore: true */ candidate);
    if (now - stat.mtimeMs < STALE_JOB_AGE_MS) continue;
    const task = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as unknown as
      | { status: string }
      | undefined;
    if (task?.status === "pending" || task?.status === "running") continue;
    try {
      if (removeExactJob(layout, entry.name)) removed += 1;
    } catch (error) {
      console.error(`[镜序] 清理遗留剪辑任务 ${entry.name} 失败：`, error);
    }
  }
  return removed;
}

async function cleanupStaleAutoEditJobsAsync(now = Date.now()): Promise<number> {
  const layout = resolveLabLayout();
  let removed = 0;
  const entries = await fs.promises.readdir(layout.jobsRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = JOB_ID_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const taskId = Number(match[1]);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) continue;
    const candidate = assertJobDirectory(layout, entry.name);
    const stat = await fs.promises.lstat(candidate);
    if (now - stat.mtimeMs < STALE_JOB_AGE_MS) continue;
    const task = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as unknown as
      | { status: string }
      | undefined;
    if (task?.status === "pending" || task?.status === "running") continue;
    try {
      if (await removeExactJobAsync(layout, entry.name)) removed += 1;
    } catch (error) {
      console.error(`[镜序] 清理遗留剪辑任务 ${entry.name} 失败：`, error);
    }
  }
  return removed;
}

function artifactUrl(taskId: number, relativePath: string): string {
  const encoded = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/tasks/${taskId}/artifacts/${encoded}`;
}

export async function copyFileCancellable(
  source: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const readStream = fs.createReadStream(source);
  const writeStream = fs.createWriteStream(destination, { flags: "wx" });
  try {
    await pipeline(readStream, writeStream, { signal });
    signal.throwIfAborted();
  } catch (error) {
    readStream.destroy();
    writeStream.destroy();
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
}

async function copyJobOutput(options: {
  context: FeatureContext;
  jobRoot: string;
  qaReport: Record<string, unknown>;
  qaSummary: AutoEditQaSummary;
  diagnostics: AutoEditReviewDiagnostics;
  signal: AbortSignal;
}): Promise<void> {
  options.signal.throwIfAborted();
  const rawOutput = options.qaReport.output;
  if (typeof rawOutput !== "string" || !path.isAbsolute(rawOutput)) {
    throw new Error("剪辑成片路径无效");
  }
  const outputRoot = assertPhysicalDirectory(path.join(options.jobRoot, "output"), "剪辑输出目录");
  const outputFile = assertPhysicalFile(rawOutput, outputRoot, "剪辑成片");
  if (path.extname(outputFile).toLowerCase() !== ".mp4") {
    throw new Error("剪辑成片格式无效");
  }

  const preparing = path.resolve(
    options.context.outputDir,
    `editing.preparing-${randomUUID()}`,
  );
  const finalDir = path.resolve(options.context.outputDir, "editing");
  if (
    !isSamePath(path.dirname(preparing), options.context.outputDir) ||
    !isSamePath(path.dirname(finalDir), options.context.outputDir)
  ) {
    throw new Error("剪辑产物目录无效");
  }
  if (fs.existsSync(finalDir)) throw new Error("剪辑产物已经存在，请新建任务重试");
  await fs.promises.mkdir(preparing, { recursive: false });
  let committed = false;
  try {
    options.signal.throwIfAborted();
    await copyFileCancellable(
      outputFile,
      path.join(preparing, "final.mp4"),
      options.signal,
    );
    await copyFileCancellable(
      path.join(options.jobRoot, "edit-plan.json"),
      path.join(preparing, "edit-plan.json"),
      options.signal,
    );
    const maskReports = path.join(options.jobRoot, "reports", "watermark-masks");
    if (fs.existsSync(maskReports)) {
      const entries = fs.readdirSync(maskReports).filter(name => /^(?:glyph-[a-f0-9]{20}\.(?:json|png)|telea-[a-f0-9]{16}(?:-audit)?\.png|[a-f0-9]{20}-sample-\d+\.jpg|execution\.json|fidelity\.json)$/.test(name));
      await fs.promises.mkdir(path.join(preparing, "watermark-masks"));
      for (const name of entries) {
        await copyFileCancellable(assertPhysicalFile(path.join(maskReports, name), options.jobRoot, "水印修补证据"), path.join(preparing, "watermark-masks", name), options.signal);
      }
    }
    options.signal.throwIfAborted();
    await fs.promises.writeFile(
      path.join(preparing, "qa-summary.json"),
      `${JSON.stringify(options.qaSummary, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await fs.promises.writeFile(
      path.join(preparing, "review-summary.json"),
      `${JSON.stringify(options.diagnostics, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    options.signal.throwIfAborted();
    await fs.promises.rename(preparing, finalDir);
    committed = true;
    options.signal.throwIfAborted();
  } catch (error) {
    await fs.promises.rm(preparing, { recursive: true, force: true });
    if (committed) await fs.promises.rm(finalDir, { recursive: true, force: true });
    throw error;
  }
}

export async function runAutoEditFeature(
  context: FeatureContext,
): Promise<FeatureResult> {
  let percent = 0;
  return withMediaFeedback((message) => context.updateProgress(percent, message), () => runAutoEditFeatureUnsafe({
    ...context,
    updateProgress(value, message) { percent = value; context.updateProgress(value, message); },
  }));
}

async function runAutoEditFeatureUnsafe(
  context: FeatureContext,
): Promise<FeatureResult> {
  const params = normalizeParams(context.params);
  const layout = resolveLabLayout();
  try {
    await cleanupStaleAutoEditJobsAsync();
  } catch (error) {
    console.error("[镜序] 自动剪辑遗留任务清理跳过：", error);
  }

  const jobId = `mx-edit-${context.taskId}-${randomUUID()}`;
  const jobRoot = assertJobDirectory(layout, jobId);
  const videoPath = validateSourceFile(context.videoPath, "原视频");
  const secondaryVideoPath = context.secondaryVideoPath
    ? validateSourceFile(context.secondaryVideoPath, "第二段视频")
    : "";
  const voiceReferenceVideoPath = context.voiceReferenceVideoPath
    ? validateSourceFile(context.voiceReferenceVideoPath, "克隆音源文件")
    : "";
  if (params.voiceReferenceVideoId && !voiceReferenceVideoPath) throw new Error("克隆音源文件已不可用，请重新选择");
  const videoPaths = secondaryVideoPath
    ? [videoPath, secondaryVideoPath]
    : [videoPath];
  const imagePaths = context.assets.map((asset, index) =>
    validateSourceFile(asset.path, `参考图片${index + 1}`),
  );
  const taskRoot = assertPhysicalDirectory(context.outputDir, "当前任务目录");
  const briefFile = path.join(taskRoot, `.auto-edit-brief-${randomUUID()}.txt`);
  fs.writeFileSync(briefFile, `${params.brief}\n`, { encoding: "utf8", flag: "wx" });
  let planningMode: "intelligent" | "baseline" = "baseline";
  let plannerThreadId: string | null = null;
  let reviewThreadId: string | null = null;
  let reviewStatus: AutoEditReviewStatus = "not_run";
  let reviewSummary = "";
  let reviewIssues: AutoEditReviewDiagnosticIssue[] = [];
  let reviewQuality: AutoEditQualityResult | null = null;
  let repairAttempted = false;
  let narrationNote = "";
  let narrationStatus: "delivered" | "partial" | "incomplete" = "incomplete";
  let planningNote = "";
  let audioRepairNote = "";
  let cloneReferencePath = "";
  let cloneReferenceIssue = "";

  try {
    context.signal.throwIfAborted();
    context.updateProgress(8, "正在准备剪辑素材");
    const createArgs = ["create", "--job", jobId];
    for (const assetPath of [...videoPaths, ...imagePaths]) {
      createArgs.push("--asset", assetPath);
    }
    createArgs.push("--brief-file", briefFile);
    await runLabStage({
      layout,
      args: createArgs,
      stage: "素材准备",
      timeoutMs: 20 * 60_000,
      signal: context.signal,
    });
    if (!fs.existsSync(jobRoot)) throw new Error("素材准备没有生成剪辑任务");
    if ((voiceReferenceVideoPath || context.preparedVoiceReferenceDir) && params.editVoice === "narration") {
      context.updateProgress(12, "正在检查上传音源的人声");
      const referenceDir = path.join(jobRoot, "work", "voice-reference");
      try {
        if (context.preparedVoiceReferenceDir) {
          fs.mkdirSync(referenceDir, { recursive: true });
          for (const name of ["reference.wav", "reference-report.json"]) fs.copyFileSync(path.join(context.preparedVoiceReferenceDir, name), path.join(referenceDir, name));
        } else {
          await runBoundedProcess({executable:layout.python,args:[path.join(PROJECT_ROOT,"scripts","prepare-edit-voice-reference.py"),"--source",voiceReferenceVideoPath,"--output-dir",referenceDir],cwd:layout.root,stage:"克隆音源提取",timeoutMs:7*60_000,signal:context.signal});
        }
        cloneReferencePath = assertPhysicalFile(path.join(referenceDir,"reference.wav"),jobRoot,"克隆音源片段");
        const referenceReport = JSON.parse(fs.readFileSync(path.join(referenceDir,"reference-report.json"),"utf8"));
        atomicWriteJson(path.join(taskRoot,"voice-reference-audit.json"),referenceReport);
      } catch (error) {
        context.signal.throwIfAborted();
        cloneReferenceIssue = error instanceof Error ? error.message.slice(0,180) : "请换一条单人清晰说话的视频";
        context.updateProgress(12, `上传音源不可用：${cloneReferenceIssue}；继续精剪原片`);
      }
    }

    context.updateProgress(22, params.watermarkOnly
      ? "正在扫描视频水印"
      : params.transcribe ? "正在识别画面和语音" : "正在识别画面");
    await runLabStage({
      layout,
      args: [
        "analyze",
        "--job",
        jobId,
        ...(params.transcribe
          ? ["--transcribe", ...(params.editTemplateVersion >= 2 ? [] : ["--language", params.subtitleLanguage])]
          : []),
      ],
      stage: "视频分析",
      timeoutMs: 45 * 60_000,
      signal: context.signal,
    });

    const analysisPath = path.join(jobRoot, "reports", "analysis.json");
    const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8")) as unknown;
    context.updateProgress(29, params.watermarkOnly ? "正在核对水印出现位置" : "正在排除横倒和侧翻画面");
    const inFrameRoll = params.watermarkOnly ? null : await createInFrameRollReport({
      jobRoot,
      analysis,
      python: layout.python,
      ffmpeg: layout.ffmpeg,
      ffprobe: layout.ffprobe,
      signal: context.signal,
    });
    const sourceBlack = params.watermarkOnly ? null : await createSourceBlackReport({
      layout,
      jobRoot,
      analysis,
      signal: context.signal,
    });
    context.updateProgress(34, params.watermarkOnly ? "正在提取水印核对画面" : "正在提取关键画面");
    const visualEvidencePaths = await createPlanningVisualEvidence({
      layout,
      jobRoot,
      analysis,
      signal: context.signal,
    });

    context.updateProgress(42, "正在整理剪辑时间线");
    await runLabStage({
      layout,
      args: [
        "draft-plan",
        "--job",
        jobId,
        ...(params.editCaptions === "auto" && params.transcribe
          ? ["--burn-captions"]
          : []),
      ],
      stage: "基础时间线整理",
      timeoutMs: 5 * 60_000,
      signal: context.signal,
    });

    const planPath = path.join(jobRoot, "edit-plan.json");
    const draftPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as unknown;
    const draftBackupPath = path.join(jobRoot, "draft-plan.json");
    const preserveDraftPlan = () => {
      if (!fs.existsSync(draftBackupPath)) {
        fs.copyFileSync(planPath, draftBackupPath, fs.constants.COPYFILE_EXCL);
      }
    };
    const buildBaselinePlan = () => applyConservativeEditControls(
      draftPlan,
      params,
      sourceSizeFromAnalysis(analysis),
    );
    const editingPlanner = context.ai as typeof context.ai & EditingPlanRunner;
    if (typeof editingPlanner.runEditingPlan === "function") {
      context.updateProgress(52, params.watermarkOnly ? "正在判断可安全处理的区域" : "正在按你的要求设计剪辑");
      try {
        const planned = await editingPlanner.runEditingPlan({
          taskId: context.taskId,
          labRoot: layout.root,
          jobRoot,
          brief: params.brief,
          analysisPath,
          draftPlanPath: planPath,
          params: {
            watermarkOnly: params.watermarkOnly,
            editTemplateId: params.editTemplateId,
            editTemplateVersion: params.editTemplateVersion,
            editColorStyle: params.editColorStyle,
            editVoice: params.editVoice,
            editNarrationDepth: params.editNarrationDepth,
            editNarrationBrief: params.editNarrationBrief,
            editMode: params.editMode,
            editTargetDuration: params.editTargetDuration,
            editAspect: params.editAspect,
            editCaptions: params.editCaptions,
            captionStyle: params.captionStyle,
            editAudio: params.editAudio,
            transcribe: params.transcribe,
            subtitleLanguage: params.subtitleLanguage,
          },
          visualEvidencePaths,
          signal: context.signal,
        });
        if (!asRecord(planned.plan)) throw new Error("智能剪辑方案格式不完整");
        preserveDraftPlan();
        atomicWriteJson(planPath, params.watermarkOnly
          ? buildWatermarkOnlyPlan({
              draftPlan,
              plannedPlan: planned.plan,
              analysis,
              outputFilename: "watermark-clean.mp4",
            })
          : planned.plan);
        planningMode = "intelligent";
        plannerThreadId = planned.threadId;
        planningNote = planned.qualityNote ?? "";
      } catch (error) {
        context.signal.throwIfAborted();
        if (params.watermarkOnly) throw error;
        // The draft timeline was produced from the actual media and remains a
        // valid, conservative deliverable. A busy model or a presentation-rule
        // disagreement must not discard that usable edit.
        console.error(
          `[镜序] 任务 #${context.taskId} 智能规划未完成，自动使用安全基础时间线：`,
          error,
        );
        preserveDraftPlan();
        atomicWriteJson(planPath, buildBaselinePlan());
        planningMode = "baseline";
        planningNote = "智能包装已自动降级，保留完整基础剪辑、原声与可用字幕";
        context.updateProgress(58, "智能包装正在自动降级，继续生成可用成片");
      }
    } else if (params.watermarkOnly) {
      throw new Error("智能水印识别暂不可用，未对原视频进行猜测性处理；请稍后重试");
    } else if (params.editMode === "smart") {
      preserveDraftPlan();
      atomicWriteJson(planPath, buildBaselinePlan());
    } else {
      throw new Error("当前专业剪辑规划器暂不可用，未生成泛化成片；请稍后点击重试");
    }

    let safeInitialPlan = params.watermarkOnly
      ? JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>
      : applyEditTemplate(applySafeAutoEditFinishingDefaults(
          JSON.parse(fs.readFileSync(planPath, "utf8")) as unknown,
          params.editAudio,
          params.editMode,
          params.captionStyle,
        ), params.editTemplateId, params.editTemplateVersion, params.editColorStyle);
    if (!params.watermarkOnly && inFrameRoll && sourceBlack) {
      assertAutoEditPlanAvoidsInFrameRoll(safeInitialPlan, inFrameRoll.report);
      assertAutoEditPlanAvoidsSourceBlack(safeInitialPlan, sourceBlack);
    }
    atomicWriteJson(planPath, safeInitialPlan);
    // Only new website renders opt into contour repair. Historical plans keep
    // their original renderer unless explicitly rerun through this workflow.
    const sharedWatermarks = asRecord(safeInitialPlan.watermark_cleanup);
    if (sharedWatermarks) {
      sharedWatermarks.version = 3;
      atomicWriteJson(planPath, safeInitialPlan);
    }
    if (params.watermarkOnly) {
      // Keep the already completed inspection even if native rendering fails;
      // support can resume this plan without paying for another vision call.
      atomicWriteJson(path.join(context.outputDir, "watermark-recovery-plan.json"), safeInitialPlan);
    }
    let initialPlanQuality: AutoEditQualityResult = params.watermarkOnly
      ? { passed: true, issues: [], errorCount: 0, warningCount: 0 }
      : auditAutoEditPlanQuality(safeInitialPlan, sourceFactsFromAnalysis(analysis));

    // Task #550 reached an expensive completed render before a hard caption
    // clock error was noticed. Reject that plan before rendering. The native
    // draft is a traceable source-order fallback; do not publish a known-bad
    // caption simply because its MP4 happens to decode successfully.
    if (!params.watermarkOnly && !initialPlanQuality.passed) {
      console.error(`[镜序] 任务 #${context.taskId} 智能方案确定性预检未通过，改用基础时间线：`,
        compactQualityIssues(initialPlanQuality).filter(issue => issue.severity === "error"));
      const baseline = applyEditTemplate(applySafeAutoEditFinishingDefaults(
        buildBaselinePlan(), params.editAudio, params.editMode, params.captionStyle,
      ), params.editTemplateId, params.editTemplateVersion, params.editColorStyle);
      const approvedWatermarks = asRecord(safeInitialPlan.watermark_cleanup);
      if (approvedWatermarks) baseline.watermark_cleanup = structuredClone(approvedWatermarks);
      if (inFrameRoll && sourceBlack) {
        assertAutoEditPlanAvoidsInFrameRoll(baseline, inFrameRoll.report);
        assertAutoEditPlanAvoidsSourceBlack(baseline, sourceBlack);
      }
      const baselineQuality = auditAutoEditPlanQuality(baseline, sourceFactsFromAnalysis(analysis));
      if (!baselineQuality.passed) {
        const blockers = compactQualityIssues(baselineQuality)
          .filter(issue => issue.severity === "error")
          .map(issue => issue.message).slice(0, 3).join("；");
        throw new Error(`基础剪辑方案也未通过确定性预检：${blockers}`);
      }
      safeInitialPlan = baseline;
      initialPlanQuality = baselineQuality;
      atomicWriteJson(planPath, safeInitialPlan);
      planningMode = "baseline";
      planningNote = "智能方案的字幕或时间边界未通过预检，已在渲染前改用保留声音设置的基础时间线";
      context.updateProgress(58, "智能方案时间检查未通过，正在生成安全基础剪辑");
    }

    context.updateProgress(62, params.watermarkOnly ? "正在检查处理范围" : "正在检查剪辑方案");
    const renderInitial = async () => {
      await runLabStage({
      layout,
      args: ["validate", "--job", jobId],
      stage: "剪辑方案检查",
      timeoutMs: 5 * 60_000,
      signal: context.signal,
    });

      context.updateProgress(69, params.watermarkOnly ? "正在处理并保留完整原片" : "正在生成成片（含水印处理）");
      await runLabStage({
      layout,
      args: ["render", "--job", jobId],
      stage: "视频生成",
      timeoutMs: 90 * 60_000,
      signal: context.signal,
    });
    };
    try {
      await renderInitial();
    } catch (error) {
      context.signal.throwIfAborted();
      if (!params.watermarkOnly && planningMode === "intelligent") {
        console.error(
          `[镜序] 任务 #${context.taskId} 智能时间线未能原生渲染，自动改用安全基础时间线：`,
          error,
        );
        const baseline = applyEditTemplate(applySafeAutoEditFinishingDefaults(
          buildBaselinePlan(),
          params.editAudio,
          params.editMode,
          params.captionStyle,
        ), params.editTemplateId, params.editTemplateVersion, params.editColorStyle);
        if (inFrameRoll && sourceBlack) {
          assertAutoEditPlanAvoidsInFrameRoll(baseline, inFrameRoll.report);
          assertAutoEditPlanAvoidsSourceBlack(baseline, sourceBlack);
        }
        atomicWriteJson(planPath, baseline);
        planningMode = "baseline";
        planningNote = "智能时间线渲染异常，已自动改用安全基础剪辑并继续完成成片";
        context.updateProgress(66, "正在自动改用安全时间线继续生成");
        await renderInitial();
      } else {
        const fallback = asRecord(JSON.parse(fs.readFileSync(planPath,"utf8")))!;
        const cleanup = asRecord(fallback.watermark_cleanup);
        const regions = Array.isArray(cleanup?.regions) ? cleanup.regions.map(asRecord).filter((r): r is Record<string,unknown> => !!r) : [];
        // Retry only a native cleanup-filter failure, never hide encoder, storage,
        // permission, cancellation or unrelated media errors behind this fallback.
        if (!/(?:delogo|watermark (?:cleanup|rectangle|clock|source)|fillborders)/iu.test(String(error)) || !regions.some(r => r.safe_to_remove === true)) throw error;
        fallback.watermark_cleanup = {...cleanup, regions:regions.map(r=>({...r,safe_to_remove:false})),deferred:Math.max(Number(cleanup?.deferred || 0),regions.length)};
        atomicWriteJson(planPath,fallback);
        context.updateProgress(69,"水印局部处理未完成，正在保留完整剪辑");
        await renderInitial();
      }
    }

    context.updateProgress(82, params.watermarkOnly ? "正在检查整条处理结果" : "正在检查整条视频");
    await runLabStage({
      layout,
      args: ["qa", "--job", jobId],
      stage: "成片技术检查",
      timeoutMs: 30 * 60_000,
      signal: context.signal,
    });
    const qaPath = path.join(jobRoot, "reports", "qa.json");
    let qaReport = JSON.parse(fs.readFileSync(qaPath, "utf8")) as unknown;
    let qaSummary = summarizeAutoEditQa(qaReport);
    const initialPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as unknown;
    const initialQaReport = structuredClone(qaReport);
    const reportsRoot = assertPhysicalDirectory(path.join(jobRoot, "reports"), "剪辑分析目录");
    const initialPlanPath = path.join(jobRoot, "edit-plan.initial.json");
    const initialQaPath = path.join(reportsRoot, "qa.initial.json");
    fs.copyFileSync(planPath, initialPlanPath, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(qaPath, initialQaPath, fs.constants.COPYFILE_EXCL);

    const qaRecord = asRecord(qaReport);
    const initialOutput = typeof qaRecord?.output === "string" ? qaRecord.output : "";
    let initialQuality = initialPlanQuality;
    reviewQuality = initialQuality;

    if (
      planningMode === "intelligent" &&
      !params.watermarkOnly &&
      initialOutput &&
      typeof editingPlanner.runEditingReview === "function"
    ) {
      try {
        context.updateProgress(88, "正在复看成片");
        const [reviewVisualEvidencePaths, measuredMetrics] = await Promise.all([
          createPostRenderReviewEvidence({
            layout,
            jobRoot,
            outputFile: initialOutput,
            plan: initialPlan,
            durationSeconds: qaSummary.durationSeconds,
            signal: context.signal,
          }),
          measurePostRenderQuality({
            layout,
            jobRoot,
            outputFile: initialOutput,
            plan: initialPlan,
            durationSeconds: qaSummary.durationSeconds,
            signal: context.signal,
          }).catch((error) => {
            context.signal.throwIfAborted();
            console.error("[镜序] 成片确定性质量测量未完成，继续使用技术 QA：", error);
            return null;
          }),
        ]);
        if (measuredMetrics) {
          initialQuality = mergeAutoEditQualityResults(
            initialPlanQuality,
            auditAutoEditPostRenderQuality(measuredMetrics),
          );
          reviewQuality = initialQuality;
        }
        const reviewed = await editingPlanner.runEditingReview({
          taskId: context.taskId,
          labRoot: layout.root,
          jobRoot,
          brief: params.brief,
          analysisPath,
          planPath,
          qaPath,
          reviewVisualEvidencePaths,
          qualityIssues: compactQualityIssues(initialQuality),
          params: {
            editTemplateId: params.editTemplateId,
            editTemplateVersion: params.editTemplateVersion,
            editColorStyle: params.editColorStyle,
            editVoice: params.editVoice,
            editNarrationDepth: params.editNarrationDepth,
            editNarrationBrief: params.editNarrationBrief,
            editMode: params.editMode,
            editTargetDuration: params.editTargetDuration,
            editAspect: params.editAspect,
            editCaptions: params.editCaptions,
            captionStyle: params.captionStyle,
            editAudio: params.editAudio,
            transcribe: params.transcribe,
            subtitleLanguage: params.subtitleLanguage,
          },
          signal: context.signal,
        });
        reviewThreadId = reviewed.threadId;
        reviewSummary = reviewed.review.summary.trim().slice(0, 1_000);
        reviewIssues = compactReviewIssues(reviewed.review.issues);
        const reviewDecision = resolveAutoEditReviewDecision(
          reviewed.review.decision,
          initialQuality,
        );
        const effectiveReviewDecision = reviewDecision === "pass" && !measuredMetrics
          ? "needs_attention"
          : reviewDecision;
        if (effectiveReviewDecision === "pass") {
          reviewStatus = "passed";
        } else if (effectiveReviewDecision === "needs_attention") {
          reviewStatus = "needs_attention";
        } else {
          repairAttempted = true;
          context.updateProgress(92, "正在自动修正成片");
          const repairedPlan = applyEditTemplate(applySafeAutoEditFinishingDefaults(
            prepareAutoEditRepairPlan(
              initialPlan,
              reviewed.review.revisedPlan,
              `review-repaired-${randomUUID()}.mp4`,
              !/(?:水印|误擦|修补|watermark|delogo|inpaint|smear)/iu.test(JSON.stringify(reviewed.review.issues)),
            ),
            params.editAudio,
            params.editMode,
            params.captionStyle,
          ), params.editTemplateId, params.editTemplateVersion, params.editColorStyle);
          if (inFrameRoll && sourceBlack) {
            assertAutoEditPlanAvoidsInFrameRoll(repairedPlan, inFrameRoll.report);
            assertAutoEditPlanAvoidsSourceBlack(repairedPlan, sourceBlack);
          }
          atomicWriteJson(planPath, repairedPlan);
          try {
            await runLabStage({
              layout,
              args: ["validate", "--job", jobId],
              stage: "修片方案检查",
              timeoutMs: 5 * 60_000,
              signal: context.signal,
            });
            await runLabStage({
              layout,
              args: ["render", "--job", jobId],
              stage: "自动修片",
              timeoutMs: 90 * 60_000,
              signal: context.signal,
            });
            context.updateProgress(96, "正在检查修片结果");
            await runLabStage({
              layout,
              args: ["qa", "--job", jobId],
              stage: "修片技术检查",
              timeoutMs: 30 * 60_000,
              signal: context.signal,
            });
            qaReport = JSON.parse(fs.readFileSync(qaPath, "utf8")) as unknown;
            qaSummary = summarizeAutoEditQa(qaReport);
            const repairedQa = asRecord(qaReport);
            const repairedOutput = typeof repairedQa?.output === "string" ? repairedQa.output : "";
            if (!repairedOutput || isSamePath(repairedOutput, initialOutput)) {
              throw new Error("自动修片没有生成独立成片");
            }
            const repairedMetrics = await measurePostRenderQuality({
              layout,
              jobRoot,
              outputFile: repairedOutput,
              plan: repairedPlan,
              durationSeconds: qaSummary.durationSeconds,
              signal: context.signal,
            });
            const repairedQuality = mergeAutoEditQualityResults(
              auditAutoEditPlanQuality(repairedPlan, sourceFactsFromAnalysis(analysis)),
              auditAutoEditPostRenderQuality(repairedMetrics),
            );
            reviewQuality = repairedQuality;
            if (!repairedQuality.passed) {
              const blockingIssues = compactQualityIssues(repairedQuality)
                .filter((issue) => issue.severity === "error")
                .map((issue) => issue.message)
                .slice(0, 3)
                .join("；");
              throw new Error(
                blockingIssues
                  ? `自动修片仍有确定性质量问题：${blockingIssues}`
                  : "自动修片仍有确定性质量问题",
              );
            }
            reviewStatus = "repaired";
          } catch (error) {
            context.signal.throwIfAborted();
            console.error("[镜序] 自动修片没有通过，回退到第一版技术合格成片：", error);
            atomicWriteJson(planPath, initialPlan);
            atomicWriteJson(qaPath, initialQaReport);
            qaReport = initialQaReport;
            qaSummary = summarizeAutoEditQa(qaReport);
            reviewQuality = initialQuality;
            reviewStatus = "needs_attention";
          }
        }
      } catch (error) {
        context.signal.throwIfAborted();
        console.error("[镜序] 成片语义复检暂不可用，保留第一版并执行确定性门禁：", error);
        atomicWriteJson(planPath, initialPlan);
        atomicWriteJson(qaPath, initialQaReport);
        qaReport = initialQaReport;
        qaSummary = summarizeAutoEditQa(qaReport);
        reviewQuality = initialQuality;
        reviewSummary = "自动复检暂未完成，已保留第一版技术检查合格的成片。";
        reviewIssues = [];
        reviewStatus = "unavailable";
      }
    }

    if (shouldAttemptAudioEdgeRepair(reviewQuality ?? initialPlanQuality,
      JSON.parse(fs.readFileSync(planPath, "utf8")), params.editAudio)) {
      const beforeAudioRepairPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
      const beforeAudioRepairQa = structuredClone(qaReport);
      const beforeAudioRepairQuality = reviewQuality;
      try {
        const repairedPlan = structuredClone(beforeAudioRepairPlan);
        repairedPlan.finishing = {
          ...asRecord(repairedPlan.finishing),
          audio_edge_fade_ms: 80,
        };
        repairedPlan.output = {
          ...asRecord(repairedPlan.output),
          filename: `audio-edge-repaired-${randomUUID()}.mp4`,
        };
        atomicWriteJson(planPath, repairedPlan);
        context.updateProgress(92, "正在平滑音频切点并重新检查");
        await runLabStage({ layout, args: ["validate", "--job", jobId], stage: "音频切点方案检查", timeoutMs: 5 * 60_000, signal: context.signal });
        await runLabStage({ layout, args: ["render", "--job", jobId], stage: "音频切点修复", timeoutMs: 90 * 60_000, signal: context.signal });
        await runLabStage({ layout, args: ["qa", "--job", jobId], stage: "音频切点技术检查", timeoutMs: 30 * 60_000, signal: context.signal });
        const repairedQa = JSON.parse(fs.readFileSync(qaPath, "utf8")) as unknown;
        const repairedSummary = summarizeAutoEditQa(repairedQa);
        const repairedOutput = asRecord(repairedQa)?.output;
        if (typeof repairedOutput !== "string") throw new Error("音频切点修复没有生成独立成片");
        const repairedMetrics = await measurePostRenderQuality({
          layout, jobRoot, outputFile: repairedOutput, plan: repairedPlan,
          durationSeconds: repairedSummary.durationSeconds, signal: context.signal,
        });
        const repairedQuality = mergeAutoEditQualityResults(
          auditAutoEditPlanQuality(repairedPlan, sourceFactsFromAnalysis(analysis)),
          auditAutoEditPostRenderQuality(repairedMetrics),
        );
        if (!repairedQuality.passed) throw new Error("音频切点复检仍有硬错误");
        qaReport = repairedQa;
        qaSummary = repairedSummary;
        reviewQuality = repairedQuality;
        audioRepairNote = "已自动平滑音频切点并复检";
      } catch (error) {
        context.signal.throwIfAborted();
        console.error("[镜序] 音频切点安全修复未通过，保留原检查结果：", error);
        atomicWriteJson(planPath, beforeAudioRepairPlan);
        atomicWriteJson(qaPath, beforeAudioRepairQa);
        qaReport = beforeAudioRepairQa;
        qaSummary = summarizeAutoEditQa(beforeAudioRepairQa);
        reviewQuality = beforeAudioRepairQuality;
      }
    }

    if (!(reviewQuality ?? initialPlanQuality).passed) {
      const blockingIssues = compactQualityIssues(reviewQuality ?? initialPlanQuality)
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .slice(0, 3)
        .join("；");
      throw new Error(
        blockingIssues
          ? `成片确定性质量检查未通过：${blockingIssues}`
          : "成片确定性质量检查未通过，未把有硬错误的版本冒充为成品",
      );
    }

    // Optional narration is added only after the original edit/review is stable.
    // If an optional line cannot be delivered, keep the working original edit.
    if (!params.watermarkOnly && params.editVoice === "narration") {
      const beforeNarration = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
      const previousQa = structuredClone(qaReport);
      try {
        const spans: SpeechSpan[] = [];
        const inspectedSources: string[] = [];
        const fullySilentSources = new Set<string>();
        for (const raw of (asRecord(analysis)?.assets as unknown[] ?? [])) {
          const asset = asRecord(raw);
          if (typeof asset?.job_path === "string" && asRecord(asset?.probe)?.audio === null) {
            inspectedSources.push(asset.job_path);
            fullySilentSources.add(asset.job_path);
          }
          const duration = Number(asRecord(asset?.probe)?.duration_seconds);
          const silence = Array.isArray(asset?.silence_spans) ? asset.silence_spans : [];
          if (typeof asset?.job_path === "string" && Number.isFinite(duration) && duration > 0 &&
            silence.some(rawSpan => {
              const segment = asRecord(rawSpan);
              return Number(segment?.start) <= 0.1 && Number(segment?.end) >= duration - 0.1;
            })) {
            fullySilentSources.add(asset.job_path);
            inspectedSources.push(asset.job_path);
          }
          if (typeof asset?.transcript_path !== "string" || typeof asset.job_path !== "string") continue;
          const transcriptPath = assertPhysicalFile(path.join(jobRoot, asset.transcript_path), jobRoot, "原声转录");
          const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
          spans.push(...transcriptSpeechSpans(asset.job_path, transcript));
          inspectedSources.push(asset.job_path);
        }
        const profile = sourceSpeechProfile(analysis, spans);
        const selected = safeNarrationLines(beforeNarration, spans, true, {depth:params.editNarrationDepth, allowAcrossCuts:true, inspectedSources});
        let narrationLines = selected.lines;
        const clipsForFlow = Array.isArray(beforeNarration.clips) ? beforeNarration.clips.map(asRecord) : [];
        const silentOneSubject = clipsForFlow.length > 0 && clipsForFlow.every(clip =>
          clip?.kind === "video" && fullySilentSources.has(String(clip?.source)));
        const estimatedLongGaps = narrationLines.slice(1).filter((line,index) => {
          const previous = narrationLines[index];
          const estimatedSeconds = previous.text.split(/\s+/u).filter(Boolean).length / 2.7;
          return line.start - previous.start - estimatedSeconds > 1.2;
        }).length;
        const flowSpan = narrationLines.length ? narrationLines.at(-1)!.end - narrationLines[0].start : 0;
        let groupedNarration = false;
        const singleContinuousNeedsFit=silentOneSubject&&params.editNarrationDepth!=="brief"&&narrationLines.length===1&&
          narrationLines[0].text.split(/\s+/u).filter(Boolean).length>Math.floor((flowSpan-.6)*2.3);
        if (narrationFlowNeedsGrouping(narrationLines, params.editNarrationDepth, silentOneSubject)||singleContinuousNeedsFit) {
          // Budget for measured cloned speech, not optimistic reading speed.
          // A shorter continuous performance is more natural and much less
          // likely to be discarded after synthesis than two overfilled slots.
          const maxWords = Math.min(68, Math.floor((flowSpan - .6) * 2.3));
          let continuousText = narrationLines.map(line => line.text).join(" ");
          let rewritten = false;
          try {
            continuousText = await context.ai.composeEditingNarrationFlow({
              lines: narrationLines.map(({start,end,text,evidence}) => ({start,end,text,evidence})),
              brief: params.editNarrationBrief ?? "", language: params.subtitleLanguage,
              maxWords, requireBriefCoverage:Boolean(params.editNarrationBrief?.trim()), signal: context.signal,
            });
            rewritten = true;
          } catch (error) {
            context.signal.throwIfAborted();
            console.error("[镜序] 连续口播文案整理未完成，尝试保留原文合成一段：", error);
          }
          const first = narrationLines[0];
          const combined = {
            ...first, end: narrationLines.at(-1)!.end, text: continuousText,
            evidence: narrationLines.map(line => line.evidence).join(" ").slice(0, 500),
          };
          const checked = safeNarrationLines({...beforeNarration,narration:[combined]}, spans, true,
            {depth:params.editNarrationDepth,allowAcrossCuts:true,inspectedSources});
          if (checked.lines.length === 1) {
            narrationLines = checked.lines;
            groupedNarration = true;
          }
          atomicWriteJson(path.join(taskRoot,"narration-flow.json"), {
            detectedLongGaps: estimatedLongGaps, rewritten, grouped: checked.lines.length === 1,
            originalGroups: selected.lines.length, finalGroups: narrationLines.length,
            rejected: checked.rejected,
          });
        }
        atomicWriteJson(path.join(taskRoot,"narration-selection.json"), {profile,depth:params.editNarrationDepth,selected:narrationLines.length,rejected:selected.rejected});
        if (narrationLines.length) {
          context.updateProgress(97, "正在制作画外解说，保留原片声音");
          const requestPath = path.join(jobRoot, "work", "narration-request.json");
          const continuousDelivery = needsContinuousNarration(narrationLines, groupedNarration);
          atomicWriteJson(requestPath, {
            voice: params.editNarrator, voiceProfile: params.editVoiceProfile, emotion: params.editEmotion,
            ...(context.preparedVoiceReferenceDir ? { voiceReferenceKind: "personal" } : {}),
            language: params.subtitleLanguage, duration: qaSummary.durationSeconds,
            ...(continuousDelivery ? { delivery: "continuous", pace: 1 } : {}),
            lines: narrationLines,
          });
          atomicWriteJson(path.join(taskRoot, "narration-request.json"), JSON.parse(fs.readFileSync(requestPath, "utf8")));
          if (cloneReferenceIssue) throw new Error(cloneReferenceIssue);
          const cloneReference = cloneReferencePath;
          const cloneArgs = cloneReference ? ["--reference",cloneReference] : [];
          await withVoiceSlot(context.signal, async () => {
            await runBoundedProcess({ executable: path.join(layout.root,"venvs","cosyvoice3-py310","python.exe"), args: [path.join(PROJECT_ROOT,"scripts","synthesize-edit-narration.py"),"--request",requestPath,"--voices",path.join(DATA_DIR,"voice-templates","v1"),...cloneArgs], cwd:layout.root, stage:"克隆解说合成", timeoutMs:10*60_000, signal:context.signal });
            await runBoundedProcess({ executable:layout.python, args:[path.join(PROJECT_ROOT,"scripts","verify-edit-narration.py"),"--request",requestPath], cwd:layout.root, stage:"解说逐句核对", timeoutMs:5*60_000, signal:context.signal });
          });
          let ready = JSON.parse(fs.readFileSync(path.join(jobRoot,"work","narration-ready.json"),"utf8"));
          const failures = (ready.diagnostics?.lines as Record<string,unknown>[] ?? []).flatMap((line,index)=>line.skipped ? [{index,start:Number(line.start),end:Number(line.end),text:String(line.text),evidence:String(line.evidence),diagnostic:String(line.skipped)+(line.recognized?`；识别为：${line.recognized}`:"")}] : []);
          if(failures.length){
            // Voice/local-media permits are released while waiting for text AI.
            // Successful WAVs and the approved picture edit remain untouched.
            let approvedBeforeRepair = ready;
            try{
              approvedBeforeRepair = checkpointNarration(ready, path.join(jobRoot,"work"));
              context.updateProgress(97,"正在调整未说清或太长的解说，保留已完成部分");
              const repaired=await context.ai.repairEditingNarration({lines:failures,language:params.subtitleLanguage,referenceBrief:params.editNarrationBrief,
                requireBriefCoverage:params.editNarrationDepth!=="brief"&&Boolean(params.editNarrationBrief?.trim())&&silentOneSubject&&failures.length===1,signal:context.signal});
              atomicWriteJson(path.join(taskRoot,"narration-text-repair.json"),{failures,repaired});
              if(repaired.length){
                const request=JSON.parse(fs.readFileSync(requestPath,"utf8"));
                for(const line of repaired)request.lines[line.index].text=line.text;
                atomicWriteJson(requestPath,request);
                await withVoiceSlot(context.signal,async()=>{
                  await runBoundedProcess({executable:path.join(layout.root,"venvs","cosyvoice3-py310","python.exe"),args:[path.join(PROJECT_ROOT,"scripts","synthesize-edit-narration.py"),"--request",requestPath,"--voices",path.join(DATA_DIR,"voice-templates","v1"),...cloneArgs,"--retry-indices",repaired.map(l=>l.index).join(",")],cwd:layout.root,stage:"解说局部重做",timeoutMs:5*60_000,signal:context.signal});
                  await runBoundedProcess({executable:layout.python,args:[path.join(PROJECT_ROOT,"scripts","verify-edit-narration.py"),"--request",requestPath],cwd:layout.root,stage:"修订解说核对",timeoutMs:5*60_000,signal:context.signal});
                });
                ready=JSON.parse(fs.readFileSync(path.join(jobRoot,"work","narration-ready.json"),"utf8"));
              }
            }catch(error){
              context.signal.throwIfAborted();
              ready = approvedBeforeRepair;
              atomicWriteJson(path.join(jobRoot,"work","narration-ready.json"),ready);
              console.error("[镜序] 解说局部修订未完成，保留已核对部分：",error);
            }
          }
          atomicWriteJson(path.join(taskRoot,"narration-audit.json"), ready);
          let deliveryReasons: string[] = [];
          if (params.editNarrationDepth !== "brief" && params.editNarrationBrief.trim() && silentOneSubject) {
            const delivery = assessFullNarrationDelivery(ready.lines ?? [], qaSummary.durationSeconds, params.editNarrationBrief);
            atomicWriteJson(path.join(taskRoot,"narration-delivery-check.json"), delivery);
            deliveryReasons = delivery.reasons;
          }
          if (ready.lines?.length) {
            const voicePath=assertPhysicalFile(ready.source,jobRoot,"解说音轨");
            const voiced = applyEditTemplate({ ...beforeNarration, narration:JSON.parse(fs.readFileSync(requestPath,"utf8")).lines, output:{...asRecord(beforeNarration.output),filename:"final-narrated.mp4"}, voiceover:{ source:path.relative(jobRoot,voicePath).replaceAll("\\","/"),start:0,volume_db:-2 }, overlays:[...(beforeNarration.overlays as unknown[] ?? []),...(params.editCaptions === "off" ? [] : ready.captions)] },params.editTemplateId,params.editTemplateVersion,params.editColorStyle);
            atomicWriteJson(planPath,voiced);
            await runLabStage({layout,args:["validate","--job",jobId],stage:"解说混音检查",timeoutMs:5*60_000,signal:context.signal});
            await runLabStage({layout,args:["render","--job",jobId],stage:"解说与画面合成",timeoutMs:90*60_000,signal:context.signal});
            await runLabStage({layout,args:["qa","--job",jobId],stage:"解说成片检查",timeoutMs:30*60_000,signal:context.signal});
            qaReport=JSON.parse(fs.readFileSync(qaPath,"utf8"));qaSummary=summarizeAutoEditQa(qaReport);
            const narratedOutput = asRecord(qaReport)?.output;
            if (typeof narratedOutput !== "string") throw new Error("配音成片路径缺失");
            await runBoundedProcess({ executable:layout.python,args:[path.join(PROJECT_ROOT,"scripts","check-final-edit-narration.py"),"--request",requestPath,"--video",narratedOutput,"--allow-partial"],cwd:layout.root,stage:"最终成片口播回读",timeoutMs:5*60_000,signal:context.signal });
            const finalNarrationCheck = JSON.parse(fs.readFileSync(path.join(jobRoot,"work","final-narration-check.json"),"utf8"));
            if (finalNarrationCheck.passed !== true) throw new Error("最终成片口播未通过核对");
            atomicWriteJson(path.join(taskRoot,"final-narration-check.json"), finalNarrationCheck);
            narrationStatus = finalNarrationCheck.delivery?.complete === true && !deliveryReasons.length ? "delivered" : "partial";
            narrationNote=narrationStatus === "partial"
              ? `已保留核对通过的口播与精剪，配音尚未完整：${deliveryReasons.join("；") || "部分句子暂未说清，未混入成片"}。`
              : params.editNarrationDepth === "full" && params.editNarrationBrief.trim() && silentOneSubject
              ? `已补充覆盖视频主体的${cloneReference ? "参考上传音色的" : ""}连续画外解说，原声保留。`
              : `已补充 ${ready.lines.length} 句${cloneReference ? "参考上传音色的" : ""}画外解说，原声保留。`;
          } else if (params.editNarrationBrief.trim() && silentOneSubject) {
            throw new Error("REQUIRED_NARRATION_MISSING: 用户已填写口播，静音主体视频却没有任何一句通过时长和发音核对");
          } else narrationNote="解说未通过发音或时长核对，已保留精剪原声版。";
        } else narrationNote=profile.kind === "speech_led"
          ? "原口播已较完整，没有可安全补充的解说空间；保留原口播和精剪。"
          : profile.kind === "unknown" ? "原声音频情况尚未确认，本次未覆盖未知人声；已保留精剪。"
          : "本次未形成可安全配入的解说，已保留精剪；不是把无口播误判为已有口播。";
        if (cloneReferenceIssue && !selected.lines.length) narrationNote=`上传音源不可用：${cloneReferenceIssue}；${narrationNote}`;
      } catch (error) {
        context.signal.throwIfAborted();
        narrationStatus = "incomplete";
        const requiredNarrationMissing = error instanceof Error && error.message.startsWith("REQUIRED_NARRATION_MISSING:");
        console.error("[镜序] 可选解说未完成，保留原声精剪版：", error);
        const failure = error as Error & { stage?: string; exitCode?: number | null; diagnostic?: string };
        // Preserve the actual request and measured speech before the temporary
        // render job is cleaned, so a repair can resume without another edit.
        for (const name of ["narration-request.json", "narration-synthesis.json", "narration-ready.json", "final-narration-check.json"]) {
          const artifact = path.join(jobRoot,"work",name);
          if (fs.existsSync(artifact)) fs.copyFileSync(artifact,path.join(taskRoot,name));
        }
        atomicWriteJson(path.join(taskRoot, "narration-failure.json"), {
          stage: failure.stage ?? "画外解说",
          exitCode: failure.exitCode ?? null,
          diagnostic: failure.diagnostic ?? failure.message,
          recordedAt: new Date().toISOString(),
          selectedLines: fs.existsSync(path.join(taskRoot, "narration-selection.json"))
            ? JSON.parse(fs.readFileSync(path.join(taskRoot, "narration-selection.json"), "utf8")).selected
            : null,
        });
        atomicWriteJson(planPath,beforeNarration);atomicWriteJson(qaPath,previousQa);
        qaReport=previousQa;qaSummary=summarizeAutoEditQa(qaReport);
        const reason = requiredNarrationMissing ? "要求的口播尚未完整交付"
          : failure.diagnostic?.includes("GPU currently busy")
          ? "配音设备当前繁忙"
          : failure.stage === "解说逐句核对" || failure.stage === "修订解说核对"
            ? "配音发音核对未完成"
            : failure.stage === "克隆解说合成" || failure.stage === "解说局部重做"
              ? "配音合成未完成"
              : failure.stage === "解说与画面合成" || failure.stage === "解说成片检查"
                ? "配音混入成片时未完成"
                : "画外解说未完成";
        narrationNote = `${reason}；目前只能使用原声精剪版，不含你填写的画外解说。`;
      }
    }

    context.updateProgress(98, params.watermarkOnly ? "正在整理去水印视频" : "正在整理成片");
    const effectiveQuality = reviewQuality ?? initialPlanQuality;
    const actionableHint = reviewStatus === "needs_attention"
      ? conciseAttentionHint(reviewIssues, effectiveQuality)
      : reviewStatus === "unavailable"
        ? "请播放检查开头、字幕、切点和收尾"
        : null;
    const diagnostics: AutoEditReviewDiagnostics = {
      schemaVersion: 1,
      status: reviewStatus,
      summary: (reviewSummary || (
        reviewStatus === "not_run"
          ? "本次未运行智能成片复检。"
          : "成片复检已完成。"
      )).slice(0, 1_000),
      actionableHint,
      repairAttempted,
      quality: {
        passed: effectiveQuality.passed,
        errorCount: effectiveQuality.errorCount,
        warningCount: effectiveQuality.warningCount,
        issues: compactQualityIssues(effectiveQuality),
      },
      review: { issues: reviewIssues },
    };
    await copyJobOutput({
      context,
      jobRoot,
      qaReport: asRecord(qaReport) ?? {},
      qaSummary,
      diagnostics,
      signal: context.signal,
    });
    const videoUrl = artifactUrl(context.taskId, "editing/final.mp4");
    const qaUrl = artifactUrl(context.taskId, "editing/qa-summary.json");
    const planUrl = artifactUrl(context.taskId, "editing/edit-plan.json");
    const watermarkExecutionPath = path.join(jobRoot, "reports", "watermark-masks", "execution.json");
    const watermarkExecution = fs.existsSync(watermarkExecutionPath)
      ? JSON.parse(fs.readFileSync(watermarkExecutionPath, "utf8")) : null;
    const watermarkNote = watermarkExecution
      ? watermarkExecutionNote(watermarkExecution)
      : watermarkResultNote(JSON.parse(fs.readFileSync(planPath, "utf8")));
    const finalCaptionPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const captionNote = !params.watermarkOnly && params.editCaptions !== "off" && !(Array.isArray(finalCaptionPlan.overlays) && finalCaptionPlan.overlays.some((o: Record<string,unknown>)=>o.kind==="caption"))
      ? "本片未生成独立口播字幕，已保留精剪和原声；没有用猜测的文字或时间补字幕" : "";
    const watermarkOnlyMessage = params.watermarkOnly
      ? watermarkNote || "没有发现可安全自动处理的平台水印，已完整保留原视频。"
      : "";
    return {
      message: params.watermarkOnly ? watermarkOnlyMessage : [narrationNote || (
        reviewStatus === "needs_attention"
          ? `视频已生成，请重点检查：${actionableHint}`
          : reviewStatus === "unavailable"
            ? "视频已生成，请播放检查开头、字幕、切点和收尾"
          : planningMode === "intelligent"
            ? "视频已经剪好"
          : "基础剪辑已经完成"), planningNote, audioRepairNote, watermarkNote, captionNote].filter(Boolean).map(s=>s.replace(/[。\s]+$/u,"")).join("。"),
      report: params.watermarkOnly
        ? "已按首中尾等抽样画面检查水印，仅对有跨时段证据的安全区域处理；视频内容、顺序和播放速度保持不变。未识别到或未能安全处理的水印请以下载成片为准。"
        :
        planningMode === "intelligent"
          ? reviewStatus === "repaired"
            ? "已按要求完成剪辑、成片复看和一次自动修正。"
            : reviewStatus === "passed"
              ? "已按要求完成剪辑，并复看了成片的结构、连续性和字幕。"
              : reviewStatus === "needs_attention"
                ? `已保留技术检查合格的成片，请重点确认：${actionableHint}`
                : "已完成剪辑与本地技术检查，请播放检查开头、字幕、切点和收尾。"
          : "当前使用保守基础剪辑：保留素材顺序并应用时长、画幅、字幕和声音设置。",
      media: [{ type: "video", url: videoUrl, title: params.watermarkOnly ? "去水印视频" : "剪辑成片" }],
      placeholder: false,
      extra: {
        editing: {
          mode: planningMode,
          ...(params.watermarkOnly ? { watermarkOnly: true } : {}),
          videoUrl,
          qaUrl,
          planUrl,
          qa: qaSummary,
          reviewStatus,
          ...(narrationNote ? { narrationNote } : {}),
          ...(params.editVoice === "narration" ? { narrationStatus } : {}),
          ...(watermarkNote ? { watermarkNote } : {}),
          ...(watermarkExecution ? { watermarkStatus: watermarkExecution.deferred > 0 || !watermarkExecution.inspected ? "partial" : watermarkExecution.processed > 0 ? "processed" : "not_detected" } : {}),
          ...(actionableHint ? { attentionNote: actionableHint } : watermarkExecution?.deferred > 0 || watermarkExecution?.inspected === false ? { attentionNote: "去水印仍有未处理区域，视频已保留；请核对处理说明。" } : {}),
          ...(plannerThreadId ? { plannerThreadId } : {}),
          ...(reviewThreadId ? { reviewThreadId } : {}),
        },
      },
    };
  } finally {
    try {
      fs.rmSync(briefFile, { force: true });
    } catch {
      // Best effort; this file contains no credentials and remains task-scoped.
    }
    try {
      await removeExactJobAsync(layout, jobId);
    } catch (error) {
      console.error(`[镜序] 清理本次剪辑临时任务 ${jobId} 失败：`, error);
    }
  }
}
