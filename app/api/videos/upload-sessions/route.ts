import path from "node:path";
import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import {
  currentVideoUploadCapacity,
  GLOBAL_VIDEO_QUOTA_BYTES,
  MAX_ACTIVE_VIDEO_UPLOADS_GLOBAL,
  MAX_ACTIVE_VIDEO_UPLOADS_PER_USER,
  MAX_VIDEO_FILE_BYTES,
  USER_VIDEO_QUOTA_BYTES,
  VIDEO_UPLOAD_CHUNK_BYTES,
  VIDEO_UPLOAD_SAFE_CHUNK_BYTES,
} from "@/lib/video-upload-limits";
import {
  cleanupStaleVideoUploadSessions,
  cleanupAbandonedEmptyVideoUploads,
  createVideoUploadSessionDirectory,
  findVideoUploadSession,
  removeVideoUploadSessionDirectory,
  VIDEO_UPLOAD_SESSION_ID,
} from "@/lib/video-upload-sessions";

function cleanOriginalName(value: string): string {
  return path
    .basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
}

export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  cleanupStaleVideoUploadSessions();
  cleanupAbandonedEmptyVideoUploads(user.username);
  const body = await readJson(req, 16 * 1024);
  const originalName = cleanOriginalName(String(body.name ?? ""));
  const totalSize = Number(body.size);
  const requestedId = String(body.idempotencyKey ?? "").trim();
  const submittedPurpose = body.purpose == null ? "video" : String(body.purpose);
  if (!["video", "voice_reference"].includes(submittedPurpose)) {
    return fail("上传用途无效", 400);
  }
  const purpose = submittedPurpose as "video" | "voice_reference";
  const chunkSize = body.chunkSize === VIDEO_UPLOAD_SAFE_CHUNK_BYTES
    ? VIDEO_UPLOAD_SAFE_CHUNK_BYTES : VIDEO_UPLOAD_CHUNK_BYTES;
  if (!originalName) return fail("视频文件名不能为空", 400);
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    return fail("视频文件大小无效", 400);
  }
  if (totalSize > MAX_VIDEO_FILE_BYTES) {
    return fail("视频超过 1GB 上限", 413);
  }
  if (requestedId && !VIDEO_UPLOAD_SESSION_ID.test(requestedId)) {
    return fail("上传任务标识无效", 400);
  }

  const id = requestedId || crypto.randomUUID();
  const chunkCount = Math.ceil(totalSize / chunkSize);
  let transactionStarted = false;
  let directoryCreated = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const existing = findVideoUploadSession(id);
    if (existing) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      if (
        existing.uploaded_by !== user.username ||
        existing.original_name !== originalName ||
        existing.total_size !== totalSize ||
        existing.chunk_size !== chunkSize ||
        existing.chunk_count !== chunkCount ||
        existing.purpose !== purpose
      ) {
        return fail("上传任务标识已被占用", 409);
      }
      if (existing.status !== "active") {
        return fail("上传任务正在保存或已经完成", 409);
      }
      return ok({
        session: {
          id: existing.id,
          chunkSize: existing.chunk_size,
          chunkCount: existing.chunk_count,
          totalSize: existing.total_size,
        },
      });
    }
    const capacity = currentVideoUploadCapacity(user.username);
    if (capacity.userCount >= MAX_ACTIVE_VIDEO_UPLOADS_PER_USER) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("已有 2 个视频正在上传，请先完成或取消其中一个", 429, "UPLOAD_USER_BUSY");
    }
    if (capacity.globalCount >= MAX_ACTIVE_VIDEO_UPLOADS_GLOBAL) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("当前上传人数较多，请稍后重试", 429, "UPLOAD_SERVER_BUSY");
    }
    if (
      capacity.globalStoredBytes +
        capacity.globalReservedBytes +
        totalSize >
      GLOBAL_VIDEO_QUOTA_BYTES
    ) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("服务器视频容量（含上传中内容）已达 20GB 上限", 413);
    }
    if (
      capacity.userStoredBytes + capacity.userReservedBytes + totalSize >
      USER_VIDEO_QUOTA_BYTES
    ) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("个人视频容量（含上传中内容）已达 5GB 上限", 413);
    }

    createVideoUploadSessionDirectory(id);
    directoryCreated = true;
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_upload_sessions
       (id, original_name, total_size, chunk_size, chunk_count, uploaded_by, purpose, status, video_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(
      id,
      originalName,
      totalSize,
      chunkSize,
      chunkCount,
      user.username,
      purpose,
      createdAt,
      createdAt,
    );
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
    }
    if (directoryCreated) removeVideoUploadSessionDirectory(id);
    throw error;
  }

  return ok({
    session: {
      id,
      chunkSize,
      chunkCount,
      totalSize,
    },
  });
});
