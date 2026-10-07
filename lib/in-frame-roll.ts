import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";
import { withLocalMediaSlot, lowerMediaPriority } from "./local-media-capacity";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MIN_PROCESS_TIMEOUT_MS = 2 * 60_000;
const MAX_PROCESS_TIMEOUT_MS = 45 * 60_000;
const MAX_PARALLEL_DETECTORS = 2;
const ROLL_SEGMENT_PADDING_SECONDS = 0.2;

export interface InFrameRollSegment {
  start: number;
  end: number;
  maxAbsDegrees: number;
  confidence: number;
}

export interface InFrameRollSourceReport {
  source: string;
  sampleCount: number;
  segments: InFrameRollSegment[];
}

export interface InFrameRollReport {
  schema_version: 1;
  job_id: string;
  sources: InFrameRollSourceReport[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function assertPhysicalFile(filePath: string, root: string, label: string): string {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}不存在`);
  const canonical = fs.realpathSync.native(resolved);
  if (!isSamePath(resolved, canonical) || !isWithin(root, canonical)) {
    throw new Error(`${label}路径无效`);
  }
  return canonical;
}

function safeJobSource(jobRoot: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("片内方向检测引用了不安全的素材路径");
  }
  return assertPhysicalFile(
    path.resolve(jobRoot, ...relativePath.split(/[\\/]/u)),
    jobRoot,
    "片内方向检测素材",
  );
}

function detectorEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
    MKL_NUM_THREADS: "2",
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "Path", "PATH"]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}

async function terminateProcess(pid: number | undefined): Promise<void> {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already ended.
    }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  if (!fs.existsSync(taskkill)) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(resolve, 5_000);
    timer.unref();
    killer.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseDetectorPayload(value: unknown): {
  sampleCount: number;
  segments: InFrameRollSegment[];
} {
  const record = asRecord(value);
  const sampleCount = Number(record?.sampleCount);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    throw new Error("片内方向检测缺少有效采样数");
  }
  if (!Array.isArray(record?.segments)) {
    throw new Error("片内方向检测缺少区间结果");
  }
  const segments = record.segments.map((item) => {
    const segment = asRecord(item);
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const maxAbsDegrees = Number(segment?.maxAbsDegrees);
    const confidence = Number(segment?.confidence);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(maxAbsDegrees) ||
      !Number.isFinite(confidence) ||
      start < 0 ||
      end <= start ||
      maxAbsDegrees < 0 ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new Error("片内方向检测返回了无效区间");
    }
    return { start, end, maxAbsDegrees, confidence };
  });
  return { sampleCount, segments };
}

export function computeInFrameRollDetectorTimeoutMs(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("片内方向检测缺少有效视频时长");
  }
  return Math.max(
    MIN_PROCESS_TIMEOUT_MS,
    Math.min(MAX_PROCESS_TIMEOUT_MS, 30_000 + durationSeconds * 500),
  );
}

function normalizeSource(value: string): string {
  return value.split("\\").join("/");
}

function checkedReportSources(report: InFrameRollReport): Map<string, InFrameRollSourceReport> {
  if (
    report.schema_version !== 1 ||
    typeof report.job_id !== "string" ||
    report.job_id.trim().length === 0 ||
    !Array.isArray(report.sources)
  ) {
    throw new Error("片内方向检测报告无效");
  }
  const bySource = new Map<string, InFrameRollSourceReport>();
  for (const item of report.sources) {
    const record = asRecord(item);
    if (typeof record?.source !== "string") {
      throw new Error("片内方向检测报告缺少素材路径");
    }
    const source = normalizeSource(record.source);
    if (!source || bySource.has(source)) {
      throw new Error("片内方向检测报告包含空素材或重复素材");
    }
    const parsed = parseDetectorPayload(record);
    bySource.set(source, { source, ...parsed });
  }
  return bySource;
}

/**
 * Deterministic last-line guard for every plan, including non-Codex baseline plans.
 * Native AutoLab validation still validates the rest of the plan contract.
 */
export function assertAutoEditPlanAvoidsInFrameRoll(
  value: unknown,
  report: InFrameRollReport,
): void {
  const plan = asRecord(value);
  if (!Array.isArray(plan?.clips)) {
    throw new Error("剪辑计划缺少可检查的片段");
  }
  const bySource = checkedReportSources(report);
  const videoSources = new Set<string>();
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = asRecord(plan.clips[index]);
    if (clip?.kind !== "video") continue;
    if (typeof clip.source !== "string" || clip.source.length === 0) {
      throw new Error(`剪辑计划第 ${index + 1} 个视频片段缺少素材路径`);
    }
    const source = normalizeSource(clip.source);
    videoSources.add(source);
    const sourceReport = bySource.get(source);
    if (!sourceReport) {
      throw new Error(`片内方向检测报告未覆盖视频素材：${source}`);
    }
    const start = Number(clip.start);
    const end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`剪辑计划第 ${index + 1} 个视频片段时间无效`);
    }
    const unsafe = sourceReport.segments.find((segment) => (
      start < segment.end + ROLL_SEGMENT_PADDING_SECONDS &&
      end > Math.max(0, segment.start - ROLL_SEGMENT_PADDING_SECONDS)
    ));
    if (unsafe) {
      const paddedStart = Math.max(0, unsafe.start - ROLL_SEGMENT_PADDING_SECONDS);
      const paddedEnd = unsafe.end + ROLL_SEGMENT_PADDING_SECONDS;
      throw new Error(
        `剪辑计划第 ${index + 1} 个视频片段与片内横倒禁用区间 ${paddedStart.toFixed(2)}–${paddedEnd.toFixed(2)}s 重叠；请换素材或改用安全剪点`,
      );
    }
  }
  for (const source of videoSources) {
    if (!bySource.has(source)) {
      throw new Error(`片内方向检测报告未覆盖视频素材：${source}`);
    }
  }
}

function runDetector(options: Parameters<typeof runDetectorUnsafe>[0]): Promise<{ sampleCount: number; segments: InFrameRollSegment[] }> {
  return withLocalMediaSlot(options.signal, () => runDetectorUnsafe(options), "检查画面方向");
}

async function runDetectorUnsafe(options: {
  python: string;
  detector: string;
  ffmpeg: string;
  ffprobe: string;
  input: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ sampleCount: number; segments: InFrameRollSegment[] }> {
  if (options.signal?.aborted) throw new Error("片内方向检测已取消");
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.python,
      [
        options.detector,
        "--input",
        options.input,
        "--ffmpeg",
        options.ffmpeg,
        "--ffprobe",
        options.ffprobe,
      ],
      {
        cwd: options.cwd,
        env: detectorEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    lowerMediaPriority(child.pid);
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let stopping = false;
    let stopError: Error | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error, value?: { sampleCount: number; segments: InFrameRollSegment[] }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("片内方向检测没有返回结果"));
    };
    const failAndStop = (message: string) => {
      if (settled || stopping) return;
      stopping = true;
      stopError = new Error(message);
      void terminateProcess(child.pid).finally(() => finish(new Error(message)));
    };
    const onAbort = () => failAndStop("片内方向检测已取消");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => failAndStop("片内方向检测超时"), options.timeoutMs);
    timer.unref();
    if (options.signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        failAndStop("片内方向检测输出过大");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        failAndStop("片内方向检测输出过大");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => finish(new Error("片内方向检测无法启动")));
    child.once("close", (code, processSignal) => {
      if (settled) return;
      if (stopping && stopError) {
        finish(stopError);
        return;
      }
      if (code !== 0 || processSignal) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`片内方向检测失败${detail ? `：${detail.slice(0, 300)}` : ""}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        finish(new Error("片内方向检测返回内容无法解析"));
        return;
      }
      try {
        finish(undefined, parseDetectorPayload(parsed));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("片内方向检测结果无效"));
      }
    });
  });
}

/**
 * Measure every real video in one AutoLab job before semantic planning.
 * The fixed report is later consumed by the planner prompt and hard validator.
 */
export async function createInFrameRollReport(options: {
  jobRoot: string;
  analysis: unknown;
  python: string;
  ffmpeg: string;
  ffprobe: string;
  signal?: AbortSignal;
}): Promise<{ path: string; report: InFrameRollReport }> {
  const jobRoot = fs.realpathSync.native(path.resolve(options.jobRoot));
  const jobStat = fs.lstatSync(jobRoot);
  if (!jobStat.isDirectory() || jobStat.isSymbolicLink()) {
    throw new Error("片内方向检测任务目录无效");
  }
  const labRoot = path.dirname(path.dirname(jobRoot));
  const python = assertPhysicalFile(options.python, labRoot, "片内方向检测运行环境");
  const ffmpeg = assertPhysicalFile(options.ffmpeg, labRoot, "片内方向检测视频工具");
  const ffprobe = assertPhysicalFile(options.ffprobe, labRoot, "片内方向检测探测工具");
  const detector = assertPhysicalFile(
    path.join(PROJECT_ROOT, "tools", "measure_in_frame_roll.py"),
    PROJECT_ROOT,
    "片内方向检测器",
  );
  const analysis = asRecord(options.analysis);
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const videos = assets.flatMap((item) => {
    const asset = asRecord(item);
    if (asset?.kind !== "video" || typeof asset.job_path !== "string") return [];
    const probe = asRecord(asset.probe);
    const durationSeconds = Number(probe?.duration_seconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`片内方向检测缺少有效视频时长：${asset.job_path}`);
    }
    return [{
      source: normalizeSource(asset.job_path),
      input: safeJobSource(jobRoot, asset.job_path),
      timeoutMs: computeInFrameRollDetectorTimeoutMs(durationSeconds),
    }];
  });
  if (videos.length === 0) throw new Error("片内方向检测没有找到视频素材");
  if (new Set(videos.map((video) => video.source)).size !== videos.length) {
    throw new Error("片内方向检测发现重复视频素材");
  }

  const sources = new Array<InFrameRollSourceReport>(videos.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= videos.length) return;
      const video = videos[index];
      const result = await runDetector({
        python,
        detector,
        ffmpeg,
        ffprobe,
        input: video.input,
        cwd: jobRoot,
        timeoutMs: video.timeoutMs,
        signal: options.signal,
      });
      sources[index] = { source: video.source, ...result };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_DETECTORS, videos.length) }, () => worker()),
  );
  options.signal?.throwIfAborted();

  const report: InFrameRollReport = {
    schema_version: 1,
    job_id: path.basename(jobRoot),
    sources,
  };
  const reportsRoot = path.join(jobRoot, "reports");
  const reportsStat = fs.lstatSync(reportsRoot);
  if (!reportsStat.isDirectory() || reportsStat.isSymbolicLink()) {
    throw new Error("片内方向检测报告目录无效");
  }
  const reportPath = path.join(reportsRoot, "in-frame-roll.json");
  if (fs.existsSync(reportPath)) throw new Error("片内方向检测报告已经存在");
  const temporary = `${reportPath}.tmp-${process.pid}`;
  try {
    options.signal?.throwIfAborted();
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    options.signal?.throwIfAborted();
    fs.renameSync(temporary, reportPath);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Keep the original failure; startup cleanup handles an inaccessible stale temp file.
    }
    throw error;
  }
  return { path: reportPath, report };
}
