import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "@/lib/db";
import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { toVideoOut } from "@/lib/dto";
import { UPLOAD_DIR } from "@/lib/paths";
import {
  detectVideoExt,
  detectVoiceReferenceExt,
  mimeForExt,
} from "@/lib/storage";
import {
  GLOBAL_VIDEO_QUOTA_BYTES,
  USER_VIDEO_QUOTA_BYTES,
} from "@/lib/video-upload-limits";
import {
  beginVideoUploadAssembly,
  cleanupStaleVideoUploadSessions,
  findVideoUploadSession,
  hasActiveVideoUploadChunkWrites,
  removeVideoUploadSessionDirectory,
  videoUploadChunkPath,
} from "@/lib/video-upload-sessions";
import type { VideoRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };
const COMPLETE_TIMEOUT_MS = 10 * 60 * 1000;

function expectedChunkBytes(
  totalSize: number,
  chunkSize: number,
  index: number,
): number {
  return Math.min(chunkSize, totalSize - index * chunkSize);
}

function verifyChunks(session: NonNullable<ReturnType<typeof findVideoUploadSession>>):
  | { paths: string[] }
  | { error: string } {
  const paths: string[] = [];
  for (let index = 0; index < session.chunk_count; index += 1) {
    const chunkPath = videoUploadChunkPath(session.id, index);
    try {
      const stat = fs.lstatSync(chunkPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !==
          expectedChunkBytes(
            session.total_size,
            session.chunk_size,
            index,
          )
      ) {
        return { error: `第 ${index + 1} 块视频数据不完整` };
      }
    } catch {
      return { error: `第 ${index + 1} 块视频尚未上传完成` };
    }
    paths.push(chunkPath);
  }
  return { paths };
}

function completedVideoResponse(videoId: string | null, username: string) {
  if (!videoId) return null;
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ? AND uploaded_by = ?")
    .get(videoId, username) as unknown as VideoRow | undefined;
  return row ? ok({ video: toVideoOut(row, true) }) : null;
}

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const completeStartedAt = performance.now();
  const { id } = await ctx.params;
  cleanupStaleVideoUploadSessions();
  let session = findVideoUploadSession(id);
  if (!session || session.uploaded_by !== user.username) {
    return fail("上传任务不存在", 404);
  }
  if (session.status === "completed") {
    return (
      completedVideoResponse(session.video_id, user.username) ??
      fail("视频记录不完整，请联系管理员", 500)
    );
  }
  if (session.status !== "active" || hasActiveVideoUploadChunkWrites(id)) {
    return fail("视频分块还在上传，请稍候", 409);
  }
  const verified = verifyChunks(session);
  if ("error" in verified) return fail(verified.error, 409);
  const chunkPaths = verified.paths;
  const verifyFinishedAt = performance.now();

  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const current = findVideoUploadSession(id);
    if (!current || current.uploaded_by !== user.username) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("上传任务不存在", 404);
    }
    if (current.status === "completed") {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return (
        completedVideoResponse(current.video_id, user.username) ??
        fail("视频记录不完整，请联系管理员", 500)
      );
    }
    if (current.status !== "active" || hasActiveVideoUploadChunkWrites(id)) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("视频分块还在上传，请稍候", 409);
    }
    const changed = db
      .prepare(
        "UPDATE video_upload_sessions SET status = 'assembling', updated_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(new Date().toISOString(), id);
    if (Number(changed.changes) !== 1) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("上传任务状态已变化，请稍后重试", 409);
    }
    db.exec("COMMIT");
    transactionStarted = false;
    session = {
      ...current,
      status: "assembling",
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
    }
    throw error;
  }

  const probe = Buffer.alloc(Math.min(512, session.total_size));
  const firstHandle = fs.openSync(chunkPaths[0], "r");
  try {
    fs.readSync(firstHandle, probe, 0, probe.length, 0);
  } finally {
    fs.closeSync(firstHandle);
  }
  const isVoiceReference = session.purpose === "voice_reference";
  const ext = isVoiceReference
    ? detectVoiceReferenceExt(probe, session.original_name)
    : detectVideoExt(probe);
  if (!ext) {
    db.prepare(
      "UPDATE video_upload_sessions SET status = 'active', updated_at = ? WHERE id = ? AND status = 'assembling'",
    ).run(new Date().toISOString(), id);
    return fail(
      isVoiceReference
        ? "文件内容不是有效音源（支持视频及 wav/mp3/m4a/aac/flac/ogg/opus/wma/aiff/caf）"
        : "文件内容不是有效的视频（支持 mp4/mov/webm/mkv/avi/flv/wmv/ts）",
      415,
    );
  }

  const videoId = crypto.randomUUID();
  const storedName = `${videoId}${ext}`;
  const finalPath = path.join(UPLOAD_DIR, storedName);
  const temporaryPath = `${finalPath}.uploading`;
  const releaseAssembly = beginVideoUploadAssembly(id);
  const assemblyStartedAt = performance.now();
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  req.signal.addEventListener("abort", onRequestAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
  timeout.unref();
  let assembledBytes = 0;
  let filePromoted = false;
  let committed = false;
  let assemblyFinishedAt = assemblyStartedAt;
  let databaseStartedAt = assemblyStartedAt;
  let databaseFinishedAt = assemblyStartedAt;
  try {
    async function* chunks() {
      for (const chunkPath of chunkPaths) {
        const source = fs.createReadStream(chunkPath);
        for await (const chunk of source) {
          if (controller.signal.aborted) throw new Error("ASSEMBLY_ABORTED");
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          assembledBytes += buffer.length;
          yield buffer;
        }
      }
    }
    await pipeline(
      Readable.from(chunks()),
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
      { signal: controller.signal },
    );
    if (assembledBytes !== session.total_size) {
      throw new Error("ASSEMBLED_SIZE_MISMATCH");
    }
    fs.renameSync(temporaryPath, finalPath);
    filePromoted = true;
    assemblyFinishedAt = performance.now();

    databaseStartedAt = performance.now();
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const current = findVideoUploadSession(id);
    if (
      !current ||
      current.uploaded_by !== user.username ||
      current.status !== "assembling"
    ) {
      throw new Error("UPLOAD_SESSION_STATE_CHANGED");
    }
    const totalUsed = Number(
      (
        db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM videos").get() as unknown as {
          bytes: number;
        }
      ).bytes,
    );
    const userUsed = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM videos WHERE uploaded_by = ?",
          )
          .get(user.username) as unknown as { bytes: number }
      ).bytes,
    );
    if (totalUsed + session.total_size > GLOBAL_VIDEO_QUOTA_BYTES) {
      throw new Error("GLOBAL_VIDEO_QUOTA");
    }
    if (userUsed + session.total_size > USER_VIDEO_QUOTA_BYTES) {
      throw new Error("USER_VIDEO_QUOTA");
    }
    db.prepare(
      `INSERT INTO videos
       (id, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      videoId,
      session.original_name,
      storedName,
      mimeForExt(ext),
      session.total_size,
      user.username,
      new Date().toISOString(),
    );
    db.prepare(
      "UPDATE video_upload_sessions SET status = 'completed', video_id = ?, updated_at = ? WHERE id = ?",
    ).run(videoId, new Date().toISOString(), id);
    db.exec("COMMIT");
    transactionStarted = false;
    committed = true;
    databaseFinishedAt = performance.now();
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
      transactionStarted = false;
    }
    for (const candidate of [temporaryPath, filePromoted ? finalPath : ""]) {
      if (!candidate) continue;
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Startup reconciliation can remove a prior-process orphan.
      }
    }
    db.prepare(
      "UPDATE video_upload_sessions SET status = 'active', updated_at = ? WHERE id = ? AND status = 'assembling'",
    ).run(new Date().toISOString(), id);
    if (error instanceof Error && error.message === "GLOBAL_VIDEO_QUOTA") {
      return fail("服务器视频总容量已达 20GB 上限", 413);
    }
    if (error instanceof Error && error.message === "USER_VIDEO_QUOTA") {
      return fail("你的个人视频容量已达 5GB 上限", 413);
    }
    if (req.signal.aborted) return fail("视频上传已取消", 499);
    if (controller.signal.aborted) return fail("视频合并超时", 408);
    console.error("[导演工作台] 视频分块合并失败：", error);
    return fail("视频保存失败，请重试", 500);
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", onRequestAbort);
    releaseAssembly();
  }

  if (!committed) return fail("视频保存失败", 500);
  if (!removeVideoUploadSessionDirectory(id)) {
    console.error(`[导演工作台] 视频 ${videoId} 已保存，分块临时目录待清理`);
  }
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(videoId) as unknown as VideoRow;
  logAudit(user.username, "video_upload", `上传视频 ${session.original_name}`);
  const sessionStartedAt = Date.parse(session.created_at);
  console.info(
    `[镜序] 分块${isVoiceReference ? "音源" : "视频"}上传完成 session=${id} sizeMiB=${(
      session.total_size /
      (1024 * 1024)
    ).toFixed(1)} chunks=${session.chunk_count} verifyMs=${Math.round(
      verifyFinishedAt - completeStartedAt,
    )} assembleMs=${Math.round(
      assemblyFinishedAt - assemblyStartedAt,
    )} dbMs=${Math.round(databaseFinishedAt - databaseStartedAt)} completeMs=${Math.round(
      performance.now() - completeStartedAt,
    )} sessionAgeMs=${Number.isFinite(sessionStartedAt) ? Date.now() - sessionStartedAt : -1}`,
  );
  return ok({ video: toVideoOut(row, true) });
});
