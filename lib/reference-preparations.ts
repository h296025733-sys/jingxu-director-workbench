import "server-only";

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getSettings } from "./ai";
import { db } from "./db";
import { DATA_DIR } from "./paths";
import { getVideoPath, safeJsonParse } from "./storage";
import { cancelWork, enqueueWork } from "./work-scheduler";
import { withLocalMediaSlot, lowerMediaPriority } from "./local-media-capacity";
import type {
  ReferencePreparationOut,
  ReferencePreparationRow,
  TaskRow,
  VideoRow,
} from "./types";

interface RuntimeState {
  queuedTaskIds: Map<string, number>;
  active: Map<string, { taskId: number; controller: AbortController }>;
}

interface PreparationReport {
  metadata: { frames: number };
  source_detection_frames: number;
  source_detection_count: number;
  masked_frames: number;
  mask_coverage: {
    mean_percent: number;
    p95_percent: number;
    max_percent: number;
  };
  post_mask_detector_count: number;
}

const MAX_VERSIONS_PER_TASK = 5;
const MAX_ACTIVE_GLOBAL = 12;
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL_LIMIT = 512 * 1024;
const SAFE_RELATIVE_VIDEO = /^reference-preparations\/[0-9a-f-]{36}\/reference-face-redacted\.mp4$/i;
const FACE_MODEL_HASHES = {
  blazeFace: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
  yuNet: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
} as const;

const holder = globalThis as typeof globalThis & {
  __directorReferencePreparationRuntime?: RuntimeState;
};
const runtime =
  holder.__directorReferencePreparationRuntime ??
  (holder.__directorReferencePreparationRuntime = {
    queuedTaskIds: new Map<string, number>(),
    active: new Map<string, { taskId: number; controller: AbortController }>(),
  } satisfies RuntimeState);

export class ReferencePreparationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function directorRecord(result: unknown): Record<string, unknown> | null {
  const root = asRecord(result);
  if (!root) return null;
  const extra = asRecord(root.extra);
  return asRecord(extra?.director) ?? asRecord(root.director);
}

function usesReferenceVideo(result: unknown): boolean {
  const root = asRecord(result);
  const extra = asRecord(root?.extra);
  if (extra?.faceReferencePolicy === "faces_allowed") return false;
  const director = directorRecord(result);
  if (!director || !Array.isArray(director.uploadPlan)) return false;
  return director.uploadPlan.some((raw) => {
    const item = asRecord(raw);
    return item?.assetKey === "REFERENCE_VIDEO" && item.type === "video";
  });
}

function artifactUrl(taskId: number, relativePath: string): string {
  const encoded = relativePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/api/tasks/${taskId}/artifacts/${encoded}`;
}

function taskArtifactExists(taskId: number, relativePath: string): boolean {
  const taskRoot = path.resolve(DATA_DIR, "task-runs", String(taskId));
  const candidate = path.resolve(taskRoot, ...relativePath.split("/"));
  if (!candidate.startsWith(`${taskRoot}${path.sep}`)) return false;
  try {
    return fs.statSync(/* turbopackIgnore: true */ candidate).isFile();
  } catch {
    return false;
  }
}

export function toReferencePreparationOut(
  row: ReferencePreparationRow,
): ReferencePreparationOut {
  const videoReady =
    Boolean(row.file_name) &&
    SAFE_RELATIVE_VIDEO.test(row.file_name ?? "") &&
    taskArtifactExists(row.task_id, row.file_name ?? "");
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    status: row.status,
    videoUrl: videoReady ? artifactUrl(row.task_id, row.file_name!) : null,
    canAdopt:
      row.status === "succeeded" &&
      videoReady &&
      row.post_mask_detector_count === 0,
    adopted: row.adopted === 1,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listReferencePreparations(taskId: number): ReferencePreparationOut[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_reference_preparations
       WHERE task_id = ?
         AND (
           adopted = 1
           OR version = (
             SELECT MAX(newest.version)
             FROM task_reference_preparations newest
             WHERE newest.task_id = task_reference_preparations.task_id
           )
         )
       ORDER BY version DESC`,
    )
    .all(taskId) as unknown as ReferencePreparationRow[];
  return rows.map(toReferencePreparationOut);
}

function runtimePath(root: string, ...segments: string[]): string {
  const candidate = path.resolve(root, ...segments);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(prefix)) throw new Error("参考视频处理路径越界");
  return candidate;
}

function requireFile(root: string, ...segments: string[]): string {
  const candidate = runtimePath(root, ...segments);
  if (!fs.existsSync(/* turbopackIgnore: true */ candidate)) {
    throw new Error(`参考视频处理依赖缺失：${segments.at(-1) ?? "file"}`);
  }
  const stat = fs.statSync(/* turbopackIgnore: true */ candidate);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`参考视频处理依赖无效：${segments.at(-1) ?? "file"}`);
  }
  return candidate;
}

function sha256File(filePath: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(/* turbopackIgnore: true */ filePath))
    .digest("hex");
}

/**
 * OpenCV's Windows ONNX loader cannot reliably open a model whose path has
 * non-ASCII characters. Keep a verified, non-secret model cache on the same D
 * volume; task media and all produced artifacts still remain under DATA_DIR.
 */
function stageFaceModel(
  sourcePath: string,
  fileName: string,
  expectedHash: string,
): string {
  if (sha256File(sourcePath) !== expectedHash) {
    throw new Error(`参考视频人脸模型哈希不匹配：${fileName}`);
  }
  const driveRoot = path.parse(path.resolve(DATA_DIR)).root;
  const cacheRoot = path.resolve(
    driveRoot,
    "DirectorWorkbenchRuntime",
    "face-models",
  );
  if (!/^[\x20-\x7e]+$/.test(cacheRoot)) {
    throw new Error("参考视频人脸模型兼容目录必须是 ASCII 路径");
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const destination = runtimePath(cacheRoot, fileName);
  if (
    !fs.existsSync(/* turbopackIgnore: true */ destination) ||
    sha256File(destination) !== expectedHash
  ) {
    const temporary = runtimePath(cacheRoot, `${fileName}.${process.pid}.copying`);
    fs.copyFileSync(
      /* turbopackIgnore: true */ sourcePath,
      /* turbopackIgnore: true */ temporary,
    );
    if (sha256File(temporary) !== expectedHash) {
      fs.rmSync(/* turbopackIgnore: true */ temporary, { force: true });
      throw new Error(`参考视频人脸模型复制校验失败：${fileName}`);
    }
    fs.rmSync(/* turbopackIgnore: true */ destination, { force: true });
    fs.renameSync(
      /* turbopackIgnore: true */ temporary,
      /* turbopackIgnore: true */ destination,
    );
  }
  return destination;
}

function findFfmpeg(workbenchRoot: string): string {
  const vendorRoot = runtimePath(workbenchRoot, "tools", "vendor");
  const entries = fs
    .readdirSync(/* turbopackIgnore: true */ vendorRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg-"))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const candidate = runtimePath(vendorRoot, entry.name, "bin", "ffmpeg.exe");
    if (fs.existsSync(/* turbopackIgnore: true */ candidate)) return candidate;
  }
  throw new Error("参考视频处理所需 FFmpeg 不存在");
}

function safeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const value = raw
    .replace(/file:\/\/\/[A-Za-z]:[\\/][^\s"'`<>]*/gi, "[服务器路径已隐藏]")
    .replace(/\\\\[^\s"'`<>]+(?:[\\/][^\s"'`<>]*)*/g, "[服务器路径已隐藏]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'`<>]*/g, "[服务器路径已隐藏]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(-600);
  return value || "参考视频去身份处理失败，请联系管理员";
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > OUTPUT_TAIL_LIMIT
    ? next.slice(next.length - OUTPUT_TAIL_LIMIT)
    : next;
}

function terminateTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15_000,
  });
}

function runProcess(options: Parameters<typeof runProcessUnsafe>[0]): Promise<number> {
  return withLocalMediaSlot(options.signal, () => runProcessUnsafe(options), "处理参考视频");
}

function runProcessUnsafe(options: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}): Promise<number> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stopReason: Error | null = null;
    let settled = false;
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lowerMediaPriority(child.pid);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, code?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(code ?? 0);
    };
    const stop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      terminateTree(child.pid);
    };
    const onAbort = () =>
      stop(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("参考视频处理已取消"),
      );
    const timeout = setTimeout(
      () => stop(new Error("参考视频去身份处理超过 30 分钟")),
      PROCESS_TIMEOUT_MS,
    );
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (stopReason) return finish(stopReason);
      if (code === 0 || code === 2) return finish(undefined, code);
      const detail = (stderr || stdout).trim().slice(-2000);
      finish(new Error(detail || `参考视频处理进程异常退出（${String(code)}）`));
    });
  });
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`参考视频处理报告字段无效：${label}`);
  }
  return value;
}

function validateReport(filePath: string): PreparationReport {
  const raw = JSON.parse(
    fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"),
  ) as unknown;
  const report = asRecord(raw);
  const metadata = asRecord(report?.metadata);
  const coverage = asRecord(report?.mask_coverage);
  if (!report || !metadata || !coverage) throw new Error("参考视频处理报告无效");
  const sanitized: PreparationReport = {
    metadata: { frames: numberField(metadata.frames, "frames") },
    source_detection_frames: numberField(
      report.source_detection_frames,
      "source_detection_frames",
    ),
    source_detection_count: numberField(
      report.source_detection_count,
      "source_detection_count",
    ),
    masked_frames: numberField(report.masked_frames, "masked_frames"),
    mask_coverage: {
      mean_percent: numberField(coverage.mean_percent, "mean_percent"),
      p95_percent: numberField(coverage.p95_percent, "p95_percent"),
      max_percent: numberField(coverage.max_percent, "max_percent"),
    },
    post_mask_detector_count: numberField(
      report.post_mask_detector_count,
      "post_mask_detector_count",
    ),
  };
  fs.writeFileSync(
    /* turbopackIgnore: true */ filePath,
    `${JSON.stringify(
      {
        ...sanitized,
        note: "本地自动复检不等于平台审核；采用前必须人工检查漏脸、手部和关键动作。",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return sanitized;
}

function verifyMedia(videoPath: string, sheetPath: string): void {
  const video = fs.readFileSync(/* turbopackIgnore: true */ videoPath);
  if (video.length < 16 || video.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error("参考视频处理结果不是有效 MP4");
  }
  const sheet = fs.readFileSync(/* turbopackIgnore: true */ sheetPath);
  if (sheet.length < 4 || sheet[0] !== 0xff || sheet[1] !== 0xd8) {
    throw new Error("参考视频处理接触表不是有效 JPEG");
  }
}

async function executePreparation(id: string): Promise<void> {
  const queuedTaskId = runtime.queuedTaskIds.get(id);
  runtime.queuedTaskIds.delete(id);
  const controller = new AbortController();
  if (queuedTaskId) runtime.active.set(id, { taskId: queuedTaskId, controller });
  const started = db
    .prepare(
      `UPDATE task_reference_preparations SET status='running', started_at=?, error=NULL
       WHERE id=? AND status='pending'`,
    )
    .run(new Date().toISOString(), id);
  if (started.changes !== 1) {
    runtime.active.delete(id);
    return;
  }
  const row = db
    .prepare("SELECT * FROM task_reference_preparations WHERE id=?")
    .get(id) as unknown as ReferencePreparationRow | undefined;
  if (!row) {
    runtime.active.delete(id);
    return;
  }
  runtime.active.set(id, { taskId: row.task_id, controller });
  let preparingDir: string | null = null;
  try {
    const task = db
      .prepare("SELECT * FROM tasks WHERE id=? AND status='succeeded'")
      .get(row.task_id) as unknown as TaskRow | undefined;
    if (!task) throw new Error("所属导演任务不存在或尚未成功完成");
    const video = db
      .prepare("SELECT * FROM videos WHERE id=?")
      .get(task.video_id) as unknown as VideoRow | undefined;
    if (!video) throw new Error("参考视频记录不存在");

    const workbenchRoot = path.resolve(getSettings().directorWorkbenchPath);
    const python = requireFile(workbenchRoot, ".venv-pose", "Scripts", "python.exe");
    const script = requireFile(workbenchRoot, "tools", "anonymize_face_reference.py");
    const blazeFace = stageFaceModel(
      requireFile(
        workbenchRoot,
        "models",
        "mediapipe",
        "blaze_face_short_range.tflite",
      ),
      "blaze_face_short_range.tflite",
      FACE_MODEL_HASHES.blazeFace,
    );
    const yuNet = stageFaceModel(
      requireFile(
        workbenchRoot,
        "models",
        "opencv",
        "face_detection_yunet_2023mar.onnx",
      ),
      "face_detection_yunet_2023mar.onnx",
      FACE_MODEL_HASHES.yuNet,
    );
    const ffmpeg = findFfmpeg(workbenchRoot);
    const inputPath = getVideoPath(video.stored_name);
    if (!fs.existsSync(/* turbopackIgnore: true */ inputPath)) {
      throw new Error("参考视频文件不存在");
    }

    const taskRoot = path.resolve(DATA_DIR, "task-runs", String(row.task_id));
    const root = runtimePath(taskRoot, "reference-preparations");
    fs.mkdirSync(root, { recursive: true });
    preparingDir = runtimePath(root, `${row.id}.preparing`);
    const finalDir = runtimePath(root, row.id);
    if (fs.existsSync(/* turbopackIgnore: true */ finalDir)) {
      throw new Error("参考视频处理版本目录已存在");
    }
    fs.mkdirSync(preparingDir, { recursive: false });
    const outputPath = runtimePath(preparingDir, "reference-face-redacted.mp4");
    const reportPath = runtimePath(preparingDir, "report.json");
    const sheetPath = runtimePath(preparingDir, "contact-sheet.jpg");
    // The verified workbench baseline is 0.50. Lower thresholds created
    // action-blocking false tracks on the real dual-person sample; later
    // versions raise the threshold slightly while the independent output pass
    // still fails closed if any face candidate remains.
    const confidence = Math.min(0.65, 0.5 + (row.version - 1) * 0.05);
    const exitCode = await runProcess({
      executable: python,
      args: [
        script,
        inputPath,
        outputPath,
        "--model",
        blazeFace,
        "--yunet",
        yuNet,
        "--ffmpeg",
        ffmpeg,
        "--report",
        reportPath,
        "--contact-sheet",
        sheetPath,
        "--min-confidence",
        confidence.toFixed(2),
      ],
      cwd: taskRoot,
      signal: controller.signal,
    });
    const report = validateReport(reportPath);
    verifyMedia(outputPath, sheetPath);
    fs.renameSync(
      /* turbopackIgnore: true */ preparingDir,
      /* turbopackIgnore: true */ finalDir,
    );
    preparingDir = null;

    const base = `reference-preparations/${row.id}`;
    const status =
      exitCode === 0 && report.post_mask_detector_count === 0
        ? "succeeded"
        : "needs_review";
    const error =
      status === "needs_review"
        ? `自动复检仍检出 ${report.post_mask_detector_count} 个人脸候选，请勿采用，需重做或人工处理`
        : null;
    db.prepare(
      `UPDATE task_reference_preparations SET
         status=?, file_name=?, report_name=?, contact_sheet_name=?,
         source_detection_frames=?, source_detection_count=?, masked_frames=?, total_frames=?,
         mean_coverage=?, p95_coverage=?, max_coverage=?, post_mask_detector_count=?,
         adopted=0, error=?, finished_at=?
       WHERE id=? AND status='running'`,
    ).run(
      status,
      `${base}/reference-face-redacted.mp4`,
      `${base}/report.json`,
      `${base}/contact-sheet.jpg`,
      report.source_detection_frames,
      report.source_detection_count,
      report.masked_frames,
      report.metadata.frames,
      report.mask_coverage.mean_percent,
      report.mask_coverage.p95_percent,
      report.mask_coverage.max_percent,
      report.post_mask_detector_count,
      error,
      new Date().toISOString(),
      row.id,
    );
  } catch (error) {
    console.error(`[导演工作台] 任务 #${row.task_id} 参考视频处理失败：`, error);
    if (preparingDir) {
      try {
        fs.rmSync(/* turbopackIgnore: true */ preparingDir, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        console.error("[导演工作台] 清理参考视频临时目录失败：", cleanupError);
      }
    }
    db.prepare(
      `UPDATE task_reference_preparations SET status='failed', adopted=0, error=?, finished_at=?
       WHERE id=? AND status='running'`,
    ).run(safeFailure(error), new Date().toISOString(), row.id);
  } finally {
    runtime.active.delete(id);
  }
}

function schedule(id: string, taskId: number, automatic: boolean): void {
  if (runtime.queuedTaskIds.has(id) || runtime.active.has(id)) return;
  const row = db
    .prepare("SELECT created_by, status FROM task_reference_preparations WHERE id=?")
    .get(id) as unknown as
    | { created_by: string; status: string }
    | undefined;
  if (!row || row.status !== "pending") return;
  runtime.queuedTaskIds.set(id, taskId);
  const accepted = enqueueWork({
    id: `reference:${id}`,
    owner: row.created_by,
    kind: "reference_video",
    priority: automatic ? 2 : 1,
    isStillValid: () => {
      const current = db
        .prepare("SELECT status FROM task_reference_preparations WHERE id=?")
        .get(id) as unknown as { status: string } | undefined;
      return current?.status === "pending";
    },
    onRemoved: () => runtime.queuedTaskIds.delete(id),
    run: () => executePreparation(id),
    cancel: () =>
      runtime.active.get(id)?.controller.abort(new Error("参考视频处理已取消")),
  });
  if (!accepted) runtime.queuedTaskIds.delete(id);
}

function insertAttempt(taskId: number, createdBy: string, version: number): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_reference_preparations
       (id,task_id,version,status,created_by,created_at)
     VALUES (?,?,?,'pending',?,?)`,
  ).run(id, taskId, version, createdBy, new Date().toISOString());
  return id;
}

export function scheduleAutomaticReferencePreparation(options: {
  taskId: number;
  createdBy: string;
  result: unknown;
}): number {
  if (!usesReferenceVideo(options.result)) return 0;
  let id = "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT 1 FROM task_reference_preparations WHERE task_id=? LIMIT 1")
      .get(options.taskId);
    if (!existing) {
      id = insertAttempt(options.taskId, options.createdBy, 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (id) schedule(id, options.taskId, true);
  return id ? 1 : 0;
}

export function createReferencePreparationAttempt(options: {
  taskId: number;
  createdBy: string;
}): ReferencePreparationOut {
  let id = "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(options.taskId) as unknown as TaskRow | undefined;
    if (!task) throw new ReferencePreparationRequestError("任务不存在", 404);
    if (task.status !== "succeeded" || !task.result_json) {
      throw new ReferencePreparationRequestError("导演任务成功后才能处理参考视频", 409);
    }
    if (!usesReferenceVideo(safeJsonParse(task.result_json))) {
      throw new ReferencePreparationRequestError(
        "导演上传计划不需要把原视频交给 Seedance",
        409,
      );
    }
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS active,
                COALESCE(MAX(version),0) AS maxVersion
         FROM task_reference_preparations WHERE task_id=?`,
      )
      .get(options.taskId) as unknown as {
      total: number;
      active: number;
      maxVersion: number;
    };
    if (Number(counts.active) > 0) {
      throw new ReferencePreparationRequestError("参考视频已经在排队或处理中", 409);
    }
    if (Number(counts.total) >= MAX_VERSIONS_PER_TASK) {
      throw new ReferencePreparationRequestError("本任务最多处理 5 个参考视频版本", 429);
    }
    const globalActive = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_reference_preparations WHERE status IN ('pending','running')",
          )
          .get() as unknown as { count: number }
      ).count,
    );
    if (globalActive >= MAX_ACTIVE_GLOBAL) {
      throw new ReferencePreparationRequestError("参考视频处理队列繁忙，请稍后重试", 429);
    }
    id = insertAttempt(options.taskId, options.createdBy, Number(counts.maxVersion) + 1);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  schedule(id, options.taskId, false);
  const row = db
    .prepare("SELECT * FROM task_reference_preparations WHERE id=?")
    .get(id) as unknown as ReferencePreparationRow;
  return toReferencePreparationOut(row);
}

export function cancelReferencePreparationAttempt(options: {
  taskId: number;
  preparationId: string;
}): ReferencePreparationOut {
  const row = db
    .prepare("SELECT * FROM task_reference_preparations WHERE id=? AND task_id=?")
    .get(options.preparationId, options.taskId) as unknown as
    | ReferencePreparationRow
    | undefined;
  if (!row) throw new ReferencePreparationRequestError("处理版本不存在", 404);
  if (row.status !== "pending" && row.status !== "running") {
    throw new ReferencePreparationRequestError("这个视频当前不需要取消", 409);
  }
  db.prepare(
    `UPDATE task_reference_preparations
     SET status='failed', adopted=0, error='已取消', finished_at=?
     WHERE id=? AND task_id=? AND status IN ('pending','running')`,
  ).run(new Date().toISOString(), row.id, row.task_id);
  cancelWork(`reference:${row.id}`);
  const updated = db
    .prepare("SELECT * FROM task_reference_preparations WHERE id=?")
    .get(row.id) as unknown as ReferencePreparationRow;
  return toReferencePreparationOut(updated);
}

export function adoptReferencePreparation(options: {
  taskId: number;
  preparationId: string;
}): ReferencePreparationOut {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT * FROM task_reference_preparations WHERE id=? AND task_id=?")
      .get(options.preparationId, options.taskId) as unknown as
      | ReferencePreparationRow
      | undefined;
    if (!row) throw new ReferencePreparationRequestError("处理版本不存在", 404);
    const out = toReferencePreparationOut(row);
    if (row.status !== "succeeded" || !out.videoUrl) {
      throw new ReferencePreparationRequestError(
        "只有复检零残留且文件完整的版本才能采用",
        409,
      );
    }
    db.prepare("UPDATE task_reference_preparations SET adopted=0 WHERE task_id=?").run(
      options.taskId,
    );
    db.prepare("UPDATE task_reference_preparations SET adopted=1 WHERE id=?").run(row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const updated = db
    .prepare("SELECT * FROM task_reference_preparations WHERE id=?")
    .get(options.preparationId) as unknown as ReferencePreparationRow;
  return toReferencePreparationOut(updated);
}

export function isReferencePreparationActiveForTask(taskId: number): boolean {
  for (const queuedTaskId of runtime.queuedTaskIds.values()) {
    if (queuedTaskId === taskId) return true;
  }
  for (const active of runtime.active.values()) {
    if (active.taskId === taskId) return true;
  }
  return false;
}
