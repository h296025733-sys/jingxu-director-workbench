import "server-only";

import { db } from "./db";

export const MAX_VIDEO_FILE_BYTES = 1024 * 1024 * 1024;
export const GLOBAL_VIDEO_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
export const USER_VIDEO_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_ACTIVE_VIDEO_UPLOADS_PER_USER = 2;
export const MAX_ACTIVE_VIDEO_UPLOADS_GLOBAL = 8;
// Public uploads always use resumable sessions. Eight MiB keeps request count
// low while staying well below the free proxy's per-request ceiling.
export const VIDEO_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
// Keep legacy sessions compatible; new public clients negotiate small requests
// that can finish before the proxy's body transfer timeout on slower links.
export const VIDEO_UPLOAD_SAFE_CHUNK_BYTES = 1024 * 1024;

interface TransientReservation {
  username: string;
  bytes: number;
}

const transientReservations = new Map<string, TransientReservation>();

export function transientVideoUploadStats(username?: string): {
  count: number;
  bytes: number;
} {
  const reservations = [...transientReservations.values()].filter(
    (reservation) => !username || reservation.username === username,
  );
  return {
    count: reservations.length,
    bytes: reservations.reduce((sum, reservation) => sum + reservation.bytes, 0),
  };
}

function persistedSessionStats(username?: string): {
  count: number;
  bytes: number;
} {
  const where = username ? " AND uploaded_by = ?" : "";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_size), 0) AS bytes
       FROM video_upload_sessions
       WHERE status IN ('active', 'assembling')${where}`,
    )
    .get(...(username ? [username] : [])) as unknown as {
    count: number;
    bytes: number;
  };
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

function storedVideoBytes(username?: string): number {
  const where = username ? " WHERE uploaded_by = ?" : "";
  const row = db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM videos${where}`)
    .get(...(username ? [username] : [])) as unknown as { bytes: number };
  return Number(row.bytes);
}

export function currentVideoUploadCapacity(username: string): {
  globalCount: number;
  userCount: number;
  globalReservedBytes: number;
  userReservedBytes: number;
  globalStoredBytes: number;
  userStoredBytes: number;
} {
  const transientGlobal = transientVideoUploadStats();
  const transientUser = transientVideoUploadStats(username);
  const persistedGlobal = persistedSessionStats();
  const persistedUser = persistedSessionStats(username);
  return {
    globalCount: transientGlobal.count + persistedGlobal.count,
    userCount: transientUser.count + persistedUser.count,
    globalReservedBytes: transientGlobal.bytes + persistedGlobal.bytes,
    userReservedBytes: transientUser.bytes + persistedUser.bytes,
    globalStoredBytes: storedVideoBytes(),
    userStoredBytes: storedVideoBytes(username),
  };
}

export function reserveTransientVideoUpload(
  username: string,
  reservedBytes: number,
): { release: () => void } | { error: string; status: number } {
  const capacity = currentVideoUploadCapacity(username);
  if (capacity.userCount >= MAX_ACTIVE_VIDEO_UPLOADS_PER_USER) {
    return { error: "每位用户最多同时上传 2 个视频", status: 429 };
  }
  if (capacity.globalCount >= MAX_ACTIVE_VIDEO_UPLOADS_GLOBAL) {
    return { error: "服务器同时上传的视频过多，请稍后再试", status: 429 };
  }
  if (
    capacity.globalStoredBytes +
      capacity.globalReservedBytes +
      reservedBytes >
    GLOBAL_VIDEO_QUOTA_BYTES
  ) {
    return { error: "服务器视频容量（含上传中内容）已达 20GB 上限", status: 413 };
  }
  if (
    capacity.userStoredBytes + capacity.userReservedBytes + reservedBytes >
    USER_VIDEO_QUOTA_BYTES
  ) {
    return { error: "个人视频容量（含上传中内容）已达 5GB 上限", status: 413 };
  }

  const token = crypto.randomUUID();
  transientReservations.set(token, { username, bytes: reservedBytes });
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      transientReservations.delete(token);
    },
  };
}
