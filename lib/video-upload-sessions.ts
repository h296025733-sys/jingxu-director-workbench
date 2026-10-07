import "server-only";

import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { VIDEO_UPLOAD_SESSION_DIR } from "./paths";

export const VIDEO_UPLOAD_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VideoUploadSessionRow {
  id: string;
  original_name: string;
  total_size: number;
  chunk_size: number;
  chunk_count: number;
  uploaded_by: string;
  purpose: "video" | "voice_reference";
  status: "active" | "assembling" | "completed" | "canceled";
  video_id: string | null;
  created_at: string;
  updated_at: string;
}

const ACTIVE_SESSION_IDLE_MS = 30 * 60 * 1000;
const ASSEMBLING_SESSION_IDLE_MS = 20 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_CLEANUP_MIN_GAP_MS = 60 * 1000;
// Route bundles must see the same locks and abort controllers in this process.
const registryHost = globalThis as typeof globalThis & {
  __videoUploadRegistry?: {
    chunks: Map<string, Map<number, AbortController>>;
    assemblies: Set<string>;
  };
};
const registry = registryHost.__videoUploadRegistry ??= {
  chunks: new Map(), assemblies: new Set(),
};
const activeChunkWrites = registry.chunks;
const activeAssemblies = registry.assemblies;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastCleanupAt = 0;

function assertSessionId(id: string): void {
  if (!VIDEO_UPLOAD_SESSION_ID.test(id)) {
    throw new Error("Invalid video upload session ID");
  }
}

export function videoUploadSessionDirectory(id: string): string {
  assertSessionId(id);
  const root = path.resolve(VIDEO_UPLOAD_SESSION_DIR);
  const candidate = path.resolve(root, id);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid video upload session path");
  }
  return candidate;
}

export function videoUploadChunkPath(
  id: string,
  index: number,
  temporary = false,
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Invalid video upload chunk index");
  }
  return path.join(
    videoUploadSessionDirectory(id),
    `${String(index).padStart(5, "0")}.part${temporary ? ".uploading" : ""}`,
  );
}

export function createVideoUploadSessionDirectory(id: string): string {
  const directory = videoUploadSessionDirectory(id);
  fs.mkdirSync(directory, { recursive: false });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Video upload session directory is unsafe");
  }
  return directory;
}

export function removeVideoUploadSessionDirectory(id: string): boolean {
  const directory = videoUploadSessionDirectory(id);
  if (!fs.existsSync(directory)) return true;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) return false;
      fs.rmSync(path.join(directory, entry.name), { force: true });
    }
    fs.rmdirSync(directory);
    return true;
  } catch (error) {
    console.error("[导演工作台] 清理视频分块临时目录失败：", error);
    return false;
  }
}

function rowIsExpired(
  row: Pick<VideoUploadSessionRow, "status" | "updated_at" | "created_at">,
  now: number,
): boolean {
  const activityAt = Date.parse(row.updated_at || row.created_at);
  if (!Number.isFinite(activityAt)) return true;
  if (row.status === "active") {
    return activityAt < now - ACTIVE_SESSION_IDLE_MS;
  }
  if (row.status === "assembling") {
    return activityAt < now - ASSEMBLING_SESSION_IDLE_MS;
  }
  return false;
}

function runStaleVideoUploadSessionCleanup(now: number): void {
  for (const row of db.prepare("SELECT id FROM video_upload_sessions WHERE status = 'canceled'").all() as unknown as { id: string }[]) {
    finishCanceledVideoUpload(row.id);
  }
  const activeCutoff = new Date(now - ACTIVE_SESSION_IDLE_MS).toISOString();
  const assemblingCutoff = new Date(
    now - ASSEMBLING_SESSION_IDLE_MS,
  ).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM video_upload_sessions
       WHERE (status = 'active' AND updated_at < ?)
          OR (status = 'assembling' AND updated_at < ?)`,
    )
    .all(activeCutoff, assemblingCutoff) as unknown as VideoUploadSessionRow[];
  for (const row of rows) {
    if (!VIDEO_UPLOAD_SESSION_ID.test(row.id)) {
      continue;
    }
    if (
      hasActiveVideoUploadChunkWrites(row.id) ||
      hasActiveVideoUploadAssembly(row.id)
    ) {
      continue;
    }
    const current = db
      .prepare("SELECT * FROM video_upload_sessions WHERE id = ?")
      .get(row.id) as unknown as VideoUploadSessionRow | undefined;
    if (!current || !rowIsExpired(current, now)) continue;
    if (!removeVideoUploadSessionDirectory(row.id)) {
      continue;
    }
    db.prepare(
      `DELETE FROM video_upload_sessions
       WHERE id = ? AND status = ? AND updated_at = ?`,
    ).run(
      current.id,
      current.status,
      current.updated_at || current.created_at,
    );
  }

  try {
    for (const entry of fs.readdirSync(VIDEO_UPLOAD_SESSION_DIR, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !VIDEO_UPLOAD_SESSION_ID.test(entry.name)) continue;
      if (
        hasActiveVideoUploadChunkWrites(entry.name) ||
        hasActiveVideoUploadAssembly(entry.name)
      ) {
        continue;
      }
      const directory = videoUploadSessionDirectory(entry.name);
      const stat = fs.statSync(directory);
      if (stat.mtimeMs >= now - ACTIVE_SESSION_IDLE_MS) continue;
      const exists = db
        .prepare("SELECT 1 FROM video_upload_sessions WHERE id = ?")
        .get(entry.name);
      if (!exists) removeVideoUploadSessionDirectory(entry.name);
    }
  } catch (error) {
    console.error("[导演工作台] 扫描视频分块临时目录失败：", error);
  }
}

function ensureVideoUploadSessionCleanupTimer(): void {
  if (cleanupTimer || process.env.NODE_ENV !== "production") return;
  cleanupTimer = setInterval(() => {
    try {
      const now = Date.now();
      lastCleanupAt = now;
      runStaleVideoUploadSessionCleanup(now);
    } catch (error) {
      console.error("[导演工作台] 周期清理过期视频上传失败：", error);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function cleanupStaleVideoUploadSessions(): void {
  if (process.env.NODE_ENV !== "production") return;
  ensureVideoUploadSessionCleanupTimer();
  const now = Date.now();
  if (now - lastCleanupAt < SESSION_CLEANUP_MIN_GAP_MS) return;
  lastCleanupAt = now;
  try {
    runStaleVideoUploadSessionCleanup(now);
  } catch (error) {
    console.error("[导演工作台] 清理过期视频上传失败：", error);
  }
}

/** Reclaim only idle, empty leftovers. Never touch a receiving/complete chunk. */
export function cleanupAbandonedEmptyVideoUploads(username: string, now = Date.now()): void {
  const rows = db.prepare(
    "SELECT * FROM video_upload_sessions WHERE uploaded_by = ? AND status = 'active' AND updated_at < ?",
  ).all(username, new Date(now - 2 * 60 * 1000).toISOString()) as unknown as VideoUploadSessionRow[];
  for (const row of rows) {
    if (hasActiveVideoUploadChunkWrites(row.id) || hasActiveVideoUploadAssembly(row.id)) continue;
    const directory = videoUploadSessionDirectory(row.id);
    try {
      if (fs.existsSync(directory)) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const hasContent = fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
          if (!entry.isFile() || entry.isSymbolicLink()) return true;
          return fs.lstatSync(path.join(directory, entry.name)).size !== 0;
        });
        if (hasContent) continue;
      }
      cancelVideoUploadSession(row.id);
    } catch {
      // An unreadable or changed directory is not safe to reclaim.
    }
  }
}

export function findVideoUploadSession(
  id: string,
): VideoUploadSessionRow | undefined {
  if (!VIDEO_UPLOAD_SESSION_ID.test(id)) return undefined;
  return db
    .prepare("SELECT * FROM video_upload_sessions WHERE id = ?")
    .get(id) as unknown as VideoUploadSessionRow | undefined;
}

export function beginVideoUploadChunkWrite(
  id: string,
  index: number,
  controller: AbortController,
): (() => void) | null {
  assertSessionId(id);
  let writes = activeChunkWrites.get(id);
  if (writes?.has(index)) return null;
  if (!writes) {
    writes = new Map();
    activeChunkWrites.set(id, writes);
  }
  writes.set(index, controller);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    writes.delete(index);
    if (writes.size === 0) activeChunkWrites.delete(id);
    finishCanceledVideoUpload(id);
  };
}

export function hasActiveVideoUploadChunkWrites(id: string): boolean {
  return (activeChunkWrites.get(id)?.size ?? 0) > 0;
}

export function finishCanceledVideoUpload(id: string): boolean {
  if (!VIDEO_UPLOAD_SESSION_ID.test(id) || hasActiveVideoUploadChunkWrites(id) || hasActiveVideoUploadAssembly(id)) return false;
  const row = findVideoUploadSession(id);
  if (!row || row.status !== "canceled") return false;
  if (!removeVideoUploadSessionDirectory(id)) return false;
  db.prepare("DELETE FROM video_upload_sessions WHERE id = ? AND status = 'canceled'").run(id);
  return true;
}

/** Persist cancellation before aborting streams; their finally blocks finish cleanup. */
export function cancelVideoUploadSession(id: string): boolean {
  const changed = db.prepare(
    "UPDATE video_upload_sessions SET status = 'canceled', updated_at = ? WHERE id = ? AND status IN ('active', 'canceled', 'completed')",
  ).run(new Date().toISOString(), id);
  if (Number(changed.changes) !== 1) return false;
  for (const controller of activeChunkWrites.get(id)?.values() ?? []) controller.abort();
  finishCanceledVideoUpload(id);
  return true;
}

export function beginVideoUploadAssembly(id: string): () => void {
  assertSessionId(id);
  activeAssemblies.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAssemblies.delete(id);
  };
}

export function hasActiveVideoUploadAssembly(id: string): boolean {
  return activeAssemblies.has(id);
}

export function touchVideoUploadSession(
  id: string,
  expectedStatus: VideoUploadSessionRow["status"],
): boolean {
  assertSessionId(id);
  const result = db
    .prepare(
      "UPDATE video_upload_sessions SET updated_at = ? WHERE id = ? AND status = ?",
    )
    .run(new Date().toISOString(), id, expectedStatus);
  return Number(result.changes) === 1;
}
