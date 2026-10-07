import fs from "node:fs";
import { fail, ok, withAuth } from "@/lib/api";
import { receiveVideoUploadChunk } from "@/lib/video-upload-stream";
import {
  beginVideoUploadChunkWrite,
  cleanupStaleVideoUploadSessions,
  findVideoUploadSession,
  touchVideoUploadSession,
  videoUploadChunkPath,
} from "@/lib/video-upload-sessions";

type Ctx = { params: Promise<{ id: string; index: string }> };
const CHUNK_TIMEOUT_MS = 6 * 60 * 1000;
const CHUNK_IDLE_TIMEOUT_MS = 90_000;

function expectedChunkBytes(
  totalSize: number,
  chunkSize: number,
  chunkCount: number,
  index: number,
): number {
  if (index < 0 || index >= chunkCount) return -1;
  return Math.min(chunkSize, totalSize - index * chunkSize);
}

export const PUT = withAuth<Ctx>(async (req, ctx, user) => {
  const { id, index: rawIndex } = await ctx.params;
  cleanupStaleVideoUploadSessions();
  const index = Number(rawIndex);
  const session = findVideoUploadSession(id);
  if (!session || session.uploaded_by !== user.username) {
    return fail("上传任务不存在", 404);
  }
  if (session.status !== "active") {
    return fail("上传任务正在合并或已完成", 409);
  }
  if (!Number.isInteger(index)) return fail("分块编号无效", 400);
  const expected = expectedChunkBytes(
    session.total_size,
    session.chunk_size,
    session.chunk_count,
    index,
  );
  if (expected <= 0) return fail("分块编号无效", 400);
  if (!req.body) return fail("分块内容为空", 400);
  const lengthHeader = req.headers.get("content-length");
  const contentLength = Number(lengthHeader);
  if (lengthHeader !== null && Number.isSafeInteger(contentLength) && contentLength !== expected) {
    return fail("分块大小不正确", 400);
  }
  if (!touchVideoUploadSession(id, "active")) {
    return fail("上传任务状态已变化，请稍后重试", 409);
  }
  const finalPath = videoUploadChunkPath(id, index);
  const temporaryPath = videoUploadChunkPath(id, index, true);
  try {
    const existing = fs.lstatSync(finalPath);
    if (existing.isFile() && !existing.isSymbolicLink() && existing.size === expected) {
      return ok({ received: expected, index });
    }
    return fail("分块状态异常，请取消后重新上传", 409);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const controller = new AbortController();
  const releaseChunkWrite = beginVideoUploadChunkWrite(id, index, controller);
  if (!releaseChunkWrite) return fail("这部分视频仍在接收，正在确认上传结果", 409);

  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    console.error("[导演工作台] 清理失败分块临时文件失败：", error);
    releaseChunkWrite();
    return fail("分块准备失败", 500);
  }

  const onRequestAbort = () => controller.abort();
  req.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (req.signal.aborted) controller.abort();
  const startedAt = performance.now();
  const idleTimeout = setTimeout(() => controller.abort(), CHUNK_IDLE_TIMEOUT_MS);
  idleTimeout.unref();
  const timeout = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  timeout.unref();
  let received = 0;
  try {
    received = await receiveVideoUploadChunk(
      req.body, temporaryPath, expected, controller.signal, bytes => {
        received = bytes;
        idleTimeout.refresh();
      },
    );
    if (received !== expected) {
      fs.rmSync(temporaryPath, { force: true });
      return fail("分块大小不正确", 400);
    }
    if (controller.signal.aborted || findVideoUploadSession(id)?.status !== "active") {
      throw new Error("UPLOAD_CANCELED");
    }
    fs.renameSync(temporaryPath, finalPath);
    touchVideoUploadSession(id, "active");
    return ok({ received, index });
  } catch (error) {
    console.warn(`[镜序] 上传分块中断 session=${id} index=${index} received=${received}/${expected} elapsedMs=${Math.round(performance.now() - startedAt)} requestAborted=${req.signal.aborted} aborted=${controller.signal.aborted}`);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // A later retry or restart cleanup can remove it.
    }
    if (req.signal.aborted) return fail("视频上传已取消", 499);
    if (controller.signal.aborted) return fail("视频传输停止响应，正在重新连接", 408);
    if (error instanceof Error && error.message === "CHUNK_TOO_LARGE") {
      return fail("分块大小不正确", 400);
    }
    console.error("[导演工作台] 视频分块写入失败：", error);
    return fail("视频分块上传失败", 500);
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimeout);
    req.signal.removeEventListener("abort", onRequestAbort);
    releaseChunkWrite();
  }
});
