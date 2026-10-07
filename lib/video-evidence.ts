import "server-only";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { AISettings } from "./ai";
import { DATA_DIR, PROJECT_ROOT } from "./paths";
import { withLocalMediaSlot, lowerMediaPriority } from "./local-media-capacity";

const OUTPUT_TAIL_LIMIT = 2 * 1024 * 1024;

export function shouldReuseVideoEvidenceForRetry(
  videoId: string | null | undefined,
  paramsJson: string,
): boolean {
  if (!videoId?.trim()) return false;
  try {
    const parsed = JSON.parse(paramsJson) as unknown;
    return !(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).hasReferenceVideo === false
    );
  } catch {
    // Preserve evidence reuse for older video tasks with malformed parameters.
    // The evidence validator still rejects incomplete or unrelated packages.
    return true;
  }
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value) return new Error(value);
  return new Error(fallback);
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > OUTPUT_TAIL_LIMIT
    ? next.slice(next.length - OUTPUT_TAIL_LIMIT)
    : next;
}

function safeEvidenceDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/file:\/\/\/[A-Za-z]:[\\/][^\s"'`<>]*/gi, "[absolute-path-redacted]")
    .replace(/\\\\[^\s"'`<>]+(?:[\\/][^\s"'`<>]*)*/g, "[absolute-path-redacted]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'`<>]*/g, "[absolute-path-redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(-1200);
}

function runEvidenceProcess(options: Parameters<typeof runEvidenceProcessUnsafe>[0]): Promise<void> {
  return withLocalMediaSlot(options.signal, () => runEvidenceProcessUnsafe(options), "识别参考视频");
}

function runEvidenceProcessUnsafe(options: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { executable, args, cwd, timeoutMs, signal } = options;
  signal?.throwIfAborted();

  return new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stopReason: Error | null = null;
    let settled = false;
    let killFallback: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        OMP_NUM_THREADS: "2",
        OPENBLAS_NUM_THREADS: "2",
        MKL_NUM_THREADS: "2",
        VECLIB_MAXIMUM_THREADS: "2",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lowerMediaPriority(child.pid);

    const cleanup = () => {
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const terminateTree = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      const pid = child.pid;
      if (pid && process.platform === "win32") {
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
        try {
          const killed = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 10_000,
          });
          if (killed.status !== 0) child.kill();
        } catch {
          child.kill();
        }
      } else {
        child.kill("SIGTERM");
      }
      killFallback = setTimeout(() => finish(stopReason ?? reason), 12_000);
    };
    const onAbort = () =>
      terminateTree(asError(signal?.reason, "任务已被用户取消"));
    const timeout = setTimeout(
      () => terminateTree(new Error("视频本地取证超时")),
      timeoutMs,
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, childSignal) => {
      if (stopReason) {
        finish(stopReason);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = (stderr || stdout).trim().slice(-2000);
      finish(
        new Error(
          `视频取证进程退出（code=${String(code)}, signal=${String(childSignal)}）${
            detail ? `：${detail}` : ""
          }`,
        ),
      );
    });
  });
}

export interface VideoEvidencePackage {
  directory: string;
  contactSheetPath: string | null;
  reportPath: string;
  metadataPath: string;
}

function readRuntimeDirectory(directory: string): fs.Dirent[] {
  // Keep dynamic evidence/vendor paths out of Turbopack's build-time asset
  // graph. Reflective dispatch still calls Node's native readdirSync at run time.
  const reader = Reflect.get(fs, "readdirSync");
  if (typeof reader !== "function") {
    throw new Error("运行时目录读取不可用");
  }
  return Reflect.apply(reader, fs, [directory, { withFileTypes: true }]) as fs.Dirent[];
}

function parseJsonObject(filePath: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`视频证据包中的 ${label} 不是有效 JSON 对象`);
  }
}

function validateEvidencePackage(evidenceDir: string): VideoEvidencePackage {
  const reportPath = path.join(evidenceDir, "extraction_report.md");
  const metadataPath = path.join(evidenceDir, "metadata.json");
  const shotsPath = path.join(evidenceDir, "shots.json");
  const transcriptPath = path.join(evidenceDir, "transcript.json");
  const audioPath = path.join(evidenceDir, "audio_analysis.json");
  const contactSheetPath = path.join(evidenceDir, "contact_sheet.jpg");
  for (const [label, filePath] of [
    ["extraction_report.md", reportPath],
    ["metadata.json", metadataPath],
    ["shots.json", shotsPath],
    ["transcript.json", transcriptPath],
    ["audio_analysis.json", audioPath],
    ["contact_sheet.jpg", contactSheetPath],
  ] as const) {
    if (
      !fs.existsSync(/* turbopackIgnore: true */ filePath) ||
      !fs.statSync(/* turbopackIgnore: true */ filePath).isFile()
    ) {
      throw new Error(`视频证据包缺少 ${label}`);
    }
    if (fs.statSync(/* turbopackIgnore: true */ filePath).size <= 0) {
      throw new Error(`视频证据包中的 ${label} 为空`);
    }
  }

  const metadata = parseJsonObject(metadataPath, "metadata.json");
  if (
    metadata.source_unchanged !== true ||
    typeof metadata.duration !== "number" ||
    !Number.isFinite(metadata.duration) ||
    metadata.duration <= 0 ||
    !Array.isArray(metadata.video_streams) ||
    metadata.video_streams.length === 0
  ) {
    throw new Error("视频证据包元数据未通过完整性检查");
  }
  const shots = parseJsonObject(shotsPath, "shots.json");
  if (!Array.isArray(shots.shots) || shots.shots.length === 0) {
    throw new Error("视频证据包没有有效分镜记录");
  }
  parseJsonObject(transcriptPath, "transcript.json");
  parseJsonObject(audioPath, "audio_analysis.json");

  const keyframesDir = path.join(evidenceDir, "keyframes");
  const hasKeyframe =
    fs.existsSync(/* turbopackIgnore: true */ keyframesDir) &&
    readRuntimeDirectory(keyframesDir)
      .some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jpg"));
  if (!hasKeyframe) throw new Error("视频证据包没有有效关键帧");

  return {
    directory: evidenceDir,
    contactSheetPath,
    reportPath,
    metadataPath,
  };
}

function assertPhysicalEvidenceTree(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stat = fs.lstatSync(/* turbopackIgnore: true */ current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("video evidence contains an unsupported filesystem entry");
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ current, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) {
        throw new Error("video evidence contains a redirected entry");
      }
      pending.push(path.join(current, entry.name));
    }
  }
}

/**
 * A retry references the exact same immutable stored video, so its already
 * validated evidence can be cloned instead of decoding/transcribing again.
 * The new task still owns an independent copy and validates it on use.
 */
export function reuseVideoEvidenceForRetry(
  sourceTaskId: number,
  targetTaskId: number,
): boolean {
  if (
    !Number.isSafeInteger(sourceTaskId) ||
    sourceTaskId <= 0 ||
    !Number.isSafeInteger(targetTaskId) ||
    targetTaskId <= 0 ||
    sourceTaskId === targetTaskId
  ) {
    return false;
  }
  const source = path.join(DATA_DIR, "task-runs", String(sourceTaskId), "evidence");
  const targetRoot = path.join(DATA_DIR, "task-runs", String(targetTaskId));
  const target = path.join(targetRoot, "evidence");
  if (!fs.existsSync(/* turbopackIgnore: true */ source) || fs.existsSync(target)) {
    return false;
  }

  validateEvidencePackage(source);
  assertPhysicalEvidenceTree(source);
  fs.mkdirSync(/* turbopackIgnore: true */ targetRoot, { recursive: true });
  const temporary = path.join(targetRoot, `.evidence-reuse-${randomUUID()}`);
  try {
    fs.cpSync(/* turbopackIgnore: true */ source, temporary, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    assertPhysicalEvidenceTree(temporary);
    validateEvidencePackage(temporary);
    fs.renameSync(/* turbopackIgnore: true */ temporary, target);
    return true;
  } catch (error) {
    try {
      fs.rmSync(/* turbopackIgnore: true */ temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("[Director Workbench] Failed to clean retry evidence clone:", cleanupError);
    }
    throw error;
  }
}

function findVendorBinary(workbenchRoot: string, name: "ffmpeg" | "ffprobe"): string {
  const vendorRoot = path.join(workbenchRoot, "tools", "vendor");
  if (!fs.existsSync(/* turbopackIgnore: true */ vendorRoot)) {
    throw new Error(`Seedance 工具目录不存在：${vendorRoot}`);
  }
  const candidates = readRuntimeDirectory(vendorRoot)
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg-"))
    .map((entry) => path.join(vendorRoot, entry.name, "bin", `${name}.exe`))
    .filter((candidate) =>
      fs.existsSync(/* turbopackIgnore: true */ candidate),
    )
    .sort()
    .reverse();
  const candidate = candidates[0];
  if (!candidate) throw new Error(`未找到本地 ${name}.exe`);
  return candidate;
}

async function prepareVideoEvidenceUnsafe(options: {
  taskId: number;
  videoPath: string;
  settings: AISettings;
  signal?: AbortSignal;
}): Promise<VideoEvidencePackage> {
  const { taskId, videoPath, settings, signal } = options;
  if (!fs.existsSync(/* turbopackIgnore: true */ videoPath)) {
    throw new Error("参考视频文件不存在");
  }

  const taskRoot = path.join(DATA_DIR, "task-runs", String(taskId));
  const evidenceDir = path.join(taskRoot, "evidence");
  const reportPath = path.join(evidenceDir, "extraction_report.md");
  const metadataPath = path.join(evidenceDir, "metadata.json");

  if (
    fs.existsSync(/* turbopackIgnore: true */ reportPath) &&
    fs.existsSync(/* turbopackIgnore: true */ metadataPath)
  ) {
    return validateEvidencePackage(evidenceDir);
  }

  fs.mkdirSync(/* turbopackIgnore: true */ taskRoot, { recursive: true });
  const workbenchRoot = path.resolve(settings.directorWorkbenchPath);
  const pythonPath = path.join(workbenchRoot, ".venv", "Scripts", "python.exe");
  const scriptPath = path.join(PROJECT_ROOT, "tools", "watch_video.py");
  const whisperModelPath = path.join(workbenchRoot, "models", "faster-whisper-small");
  if (!fs.existsSync(/* turbopackIgnore: true */ pythonPath)) {
    throw new Error(`视频取证 Python 环境不存在：${pythonPath}`);
  }
  if (!fs.existsSync(/* turbopackIgnore: true */ scriptPath)) {
    throw new Error(`视频取证脚本不存在：${scriptPath}`);
  }

  const args = [
    scriptPath,
    "--source",
    videoPath,
    "--task-name",
    `task-${taskId}`,
    "--mode",
    "DIRECTOR",
    "--output-dir",
    evidenceDir,
    "--local-transcription",
    "--whisper-model-dir",
    whisperModelPath,
    "--scene-detector",
    "auto",
    "--ffmpeg",
    findVendorBinary(workbenchRoot, "ffmpeg"),
    "--ffprobe",
    findVendorBinary(workbenchRoot, "ffprobe"),
  ];

  try {
    await runEvidenceProcess({
      executable: pythonPath,
      args,
      cwd: PROJECT_ROOT,
      timeoutMs: Math.max(60, settings.timeoutSeconds) * 1000,
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[导演工作台] 视频本地取证子进程失败：", detail.slice(-2000));
    throw new Error(`视频本地取证失败：${safeEvidenceDiagnostic(error)}`);
  }

  return validateEvidencePackage(evidenceDir);
}

export async function prepareVideoEvidence(options: {
  taskId: number;
  videoPath: string;
  settings: AISettings;
  signal?: AbortSignal;
}): Promise<VideoEvidencePackage> {
  try {
    return await prepareVideoEvidenceUnsafe(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[导演工作台] 视频本地取证失败：", detail.slice(-2000));
    throw new Error(`视频本地取证失败：${safeEvidenceDiagnostic(error)}`);
  }
}
