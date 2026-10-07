import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import Busboy from "busboy";
import { db } from "@/lib/db";
import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import {
  detectVideoExt,
  detectVoiceReferenceExt,
  mimeForExt,
} from "@/lib/storage";
import { toVideoOut } from "@/lib/dto";
import { canManageVideo } from "@/lib/permissions";
import { UPLOAD_DIR } from "@/lib/paths";
import {
  GLOBAL_VIDEO_QUOTA_BYTES,
  MAX_VIDEO_FILE_BYTES,
  reserveTransientVideoUpload,
  USER_VIDEO_QUOTA_BYTES,
} from "@/lib/video-upload-limits";
import { cleanupStaleVideoUploadSessions } from "@/lib/video-upload-sessions";
import type { VideoRow } from "@/lib/types";

const PROBE_BYTES = 512;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const VIDEO_UPLOAD_PROCESS_EPOCH = Date.now();
let staleUploadCleanupComplete = false;
const MANAGED_VIDEO_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm|avi|flv|wmv|ts|wav|mp3|m4a|aac|flac|ogg|opus|wma|aiff|caf)$/i;

function cleanupStaleUploadPartials(): void {
  if (staleUploadCleanupComplete || process.env.NODE_ENV !== "production") return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(/* turbopackIgnore: true */ UPLOAD_DIR, {
      withFileTypes: true,
    });
  } catch (error) {
    console.error("[导演工作台] 扫描视频上传临时文件失败：", error);
    return;
  }
  let cleanupSucceeded = true;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isPartial = entry.name.endsWith(".uploading");
    const finalName = isPartial
      ? entry.name.slice(0, -".uploading".length)
      : entry.name;
    if (!MANAGED_VIDEO_NAME.test(finalName)) continue;
    const candidate = path.join(UPLOAD_DIR, entry.name);
    try {
      const stat = fs.statSync(/* turbopackIgnore: true */ candidate);
      if (stat.mtimeMs >= VIDEO_UPLOAD_PROCESS_EPOCH) continue;
      if (
        !isPartial &&
        db
          .prepare("SELECT 1 FROM videos WHERE stored_name = ?")
          .get(entry.name)
      ) {
        continue;
      }
      fs.rmSync(/* turbopackIgnore: true */ candidate, { force: true });
    } catch (error) {
      cleanupSucceeded = false;
      console.error("[导演工作台] 清理上次进程遗留的视频上传临时文件失败：", error);
    }
  }
  staleUploadCleanupComplete = cleanupSucceeded;
}

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  const rows = (user.isAdmin
    ? db
        .prepare(
          `SELECT v.*, (SELECT COUNT(*) FROM tasks t
            WHERE t.video_id = v.id OR t.secondary_video_id = v.id OR (CASE WHEN json_valid(t.params_json) THEN json_extract(t.params_json, '$.voiceReferenceVideoId') END) = v.id) AS task_count
           FROM videos v ORDER BY v.created_at DESC`,
        )
        .all()
    : db
        .prepare(
          `SELECT v.*, (SELECT COUNT(*) FROM tasks t
            WHERE t.video_id = v.id OR t.secondary_video_id = v.id OR (CASE WHEN json_valid(t.params_json) THEN json_extract(t.params_json, '$.voiceReferenceVideoId') END) = v.id) AS task_count
           FROM videos v WHERE v.uploaded_by = ? ORDER BY v.created_at DESC`,
        )
        .all(user.username)) as unknown as VideoRow[];
  const videos = rows.filter((row) => !row.mime_type.startsWith("audio/"));
  const includeVoiceReferences =
    new URL(req.url).searchParams.get("includeVoiceReferences") === "1";
  return ok({
    videos: videos.map((row) =>
      toVideoOut(row, canManageVideo(user, row.uploaded_by)),
    ),
    ...(includeVoiceReferences
      ? {
          voiceReferences: rows
            .filter((row) => row.mime_type.startsWith("audio/"))
            .map((row) =>
              toVideoOut(row, canManageVideo(user, row.uploaded_by)),
            ),
        }
      : {}),
  });
});

interface UploadResult {
  ok: boolean;
  error?: string;
  storedName?: string;
  originalName?: string;
  size?: number;
  mimeType?: string;
}

/**
 * 流式上传：请求体边到边写盘，不把整个文件读进内存；
 * 前 512 字节做魔数校验，写完后按最终大小做全局/个人配额检查。
 */
export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  const purpose = new URL(req.url).searchParams.get("purpose") === "voice_reference"
    ? "voice_reference"
    : "video";
  const isVoiceReference = purpose === "voice_reference";
  const mediaLabel = isVoiceReference ? "音源" : "视频";
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return fail(`请使用 multipart/form-data 上传${mediaLabel}`);
  }
  if (!req.body) return fail("上传请求没有内容", 400);
  const requestLength = Number(req.headers.get("content-length"));
  if (
    Number.isSafeInteger(requestLength) &&
    requestLength > MAX_VIDEO_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    return fail("视频上传请求超过 1GB 上限", 413);
  }
  cleanupStaleUploadPartials();
  cleanupStaleVideoUploadSessions();

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: Object.fromEntries(req.headers.entries()),
      defParamCharset: "utf8",
      limits: {
        files: 1,
        fileSize: MAX_VIDEO_FILE_BYTES,
        fields: 0,
        fieldSize: 0,
        parts: 2,
      },
    });
  } catch {
    return fail("multipart/form-data 请求格式无效", 400);
  }

  const reservedBytes =
    Number.isSafeInteger(requestLength) && requestLength > 0
      ? Math.min(MAX_VIDEO_FILE_BYTES, requestLength)
      : MAX_VIDEO_FILE_BYTES;
  const reservation = reserveTransientVideoUpload(
    user.username,
    reservedBytes,
  );
  if ("error" in reservation) return fail(reservation.error, reservation.status);

  try {
    const result = await new Promise<UploadResult>((resolve) => {
    let receivedFile = false;
    let probe: Buffer[] = [];
    let probeBytes = 0;
    let ext = "";
    let storedName = "";
    let partialPath = "";
    let originalName = isVoiceReference ? "未命名音源.wav" : "未命名视频.mp4";
    let writeStream: fs.WriteStream | null = null;
    let currentFileStream: Readable | null = null;
    let source: Readable | null = null;
    let writeDone: Promise<void> | null = null;
    let size = 0;
    let settled = false;
    let resultResolved = false;
    let onRequestAbort: (() => void) | null = null;
    let uploadTimer: ReturnType<typeof setTimeout> | null = null;
    let requestBytes = 0;

    const bodyLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        requestBytes += chunk.length;
        if (
          requestBytes >
          MAX_VIDEO_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
        ) {
          callback(new Error("VIDEO_REQUEST_TOO_LARGE"));
          return;
        }
        callback(null, chunk);
      },
    });

    const cleanupPartialFile = () => {
      for (const candidate of [
        partialPath,
        storedName ? path.join(UPLOAD_DIR, storedName) : "",
      ]) {
        if (!candidate) continue;
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // A closing Windows file handle can delay deletion; close retries it.
        }
      }
    };

    const failUpload = (error: string) => {
      if (settled) return;
      settled = true;
      const streams = [
        writeStream,
        currentFileStream,
        busboy,
        bodyLimiter,
        source,
      ].filter((stream) => stream !== null);
      const uniqueStreams = [...new Set(streams)];
      const closeWaiters = uniqueStreams.map(
        (stream) =>
          new Promise<void>((done) => {
            if (stream.closed) done();
            else stream.once("close", done);
          }),
      );
      source?.unpipe(bodyLimiter);
      bodyLimiter.unpipe(busboy);
      for (const stream of uniqueStreams) {
        if (!stream.destroyed) stream.destroy();
      }
      void Promise.race([
        Promise.allSettled(closeWaiters),
        new Promise((done) => setTimeout(done, 1000)),
      ]).then(() => {
        cleanupPartialFile();
        if (resultResolved) return;
        resultResolved = true;
        if (uploadTimer) {
          clearTimeout(uploadTimer);
          uploadTimer = null;
        }
        if (onRequestAbort) {
          req.signal.removeEventListener("abort", onRequestAbort);
        }
        resolve({ ok: false, error });
      });
    };

    uploadTimer = setTimeout(
      () => failUpload(`${mediaLabel}上传超时，请重新上传`),
      UPLOAD_TIMEOUT_MS,
    );
    uploadTimer.unref();

    const startWrite = (buffer: Buffer) => {
      storedName = `${crypto.randomUUID()}${ext}`;
      partialPath = path.join(UPLOAD_DIR, `${storedName}.uploading`);
      writeStream = fs.createWriteStream(partialPath, { flags: "wx" });
      const activeWriteStream = writeStream;
      writeDone = new Promise<void>((res) => {
        let writeFinished = false;
        activeWriteStream.once("finish", () => {
          writeFinished = true;
        });
        activeWriteStream.once("close", () => {
          if (!writeFinished && !settled) {
            failUpload(`${mediaLabel}写入提前结束`);
          }
          res();
        });
        activeWriteStream.once("error", (error) => {
          console.error(`[导演工作台] ${mediaLabel}写入失败：`, error);
          failUpload(`${mediaLabel}写入失败`);
        });
      });
      size = buffer.length;
      activeWriteStream.write(buffer);
    };

    busboy.on("file", (_field, stream, info) => {
      currentFileStream = stream;
      if (receivedFile) {
        failUpload("一次只能上传一个文件");
        return;
      }
      receivedFile = true;
      originalName = info.filename || originalName;
      let fileEnded = false;

      stream.on("limit", () => failUpload("文件超过 1GB 上限"));
      stream.on("error", (error) => {
        console.error(`[导演工作台] ${mediaLabel}请求流失败：`, error);
        failUpload(`${mediaLabel}上传流意外中断`);
      });

      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (!ext) {
          probeBytes += chunk.length;
          probe.push(chunk);
          if (probeBytes >= PROBE_BYTES) {
            const detected = isVoiceReference
              ? detectVoiceReferenceExt(Buffer.concat(probe), originalName)
              : detectVideoExt(Buffer.concat(probe));
            if (!detected) {
              stream.destroy();
              failUpload(
                isVoiceReference
                  ? "文件内容不是有效音源（支持视频及 wav/mp3/m4a/aac/flac/ogg/opus/wma/aiff/caf）"
                  : "文件内容不是有效的视频（支持 mp4/mov/webm/mkv/avi/flv/wmv/ts）",
              );
              return;
            }
            ext = detected;
            startWrite(Buffer.concat(probe));
            probe = [];
          }
          return;
        }
        size += chunk.length;
        if (size > MAX_VIDEO_FILE_BYTES) {
          stream.destroy();
          failUpload("文件超过 1GB 上限");
          return;
        }
        if (writeStream && !writeStream.write(chunk)) {
          stream.pause();
          writeStream.once("drain", () => {
            if (!settled && !stream.destroyed) stream.resume();
          });
        }
      });

      stream.on("end", () => {
        fileEnded = true;
        writeStream?.end();
      });
      stream.on("close", () => {
        if (!fileEnded && !settled) failUpload(`${mediaLabel}上传提前结束`);
      });
    });

    busboy.on("field", () => failUpload("视频上传不允许额外字段"));
    busboy.on("fieldsLimit", () => failUpload("视频上传不允许额外字段"));
    busboy.on("partsLimit", () => failUpload("一次只能上传一个文件"));
    busboy.on("error", (error) => {
      console.error(`[导演工作台] multipart ${mediaLabel}解析失败：`, error);
      failUpload(`multipart/form-data ${mediaLabel}请求无效`);
    });
    busboy.on("filesLimit", () => failUpload("一次只能上传一个文件"));

    bodyLimiter.on("error", (error) => {
      if (error.message === "VIDEO_REQUEST_TOO_LARGE") {
        failUpload("视频上传请求超过 1GB 上限");
        return;
      }
      console.error(`[导演工作台] ${mediaLabel}请求限流失败：`, error);
      failUpload(`${mediaLabel}上传流意外中断`);
    });

    busboy.on("finish", async () => {
      if (settled) return;
      if (!receivedFile) {
        failUpload("未收到文件");
        return;
      }
      if (!ext) {
        const detected = isVoiceReference
          ? detectVoiceReferenceExt(Buffer.concat(probe), originalName)
          : detectVideoExt(Buffer.concat(probe));
        if (!detected) {
          failUpload(
            isVoiceReference
              ? "文件内容不是有效音源（支持视频及 wav/mp3/m4a/aac/flac/ogg/opus/wma/aiff/caf）"
              : "文件内容不是有效的视频（支持 mp4/mov/webm/mkv/avi/flv/wmv/ts）",
          );
          return;
        }
        ext = detected;
        startWrite(Buffer.concat(probe));
        writeStream?.end();
      }
      try {
        await writeDone;
      } catch (err) {
        failUpload(err instanceof Error ? err.message : "写盘失败");
        return;
      }
      if (settled) return;
      try {
        fs.renameSync(partialPath, path.join(UPLOAD_DIR, storedName));
        partialPath = "";
      } catch (error) {
        console.error(`[导演工作台] ${mediaLabel}上传临时文件转正失败：`, error);
        failUpload(`${mediaLabel}上传临时文件转正失败`);
        return;
      }
      settled = true;
      resultResolved = true;
      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
      }
      if (onRequestAbort) {
        req.signal.removeEventListener("abort", onRequestAbort);
      }
      resolve({
        ok: true,
        storedName,
        originalName,
        size,
        mimeType: mimeForExt(ext),
      });
    });

    try {
      source = Readable.fromWeb(req.body as unknown as WebReadableStream);
    } catch (error) {
      console.error(`[导演工作台] ${mediaLabel}请求流初始化失败：`, error);
      failUpload(`${mediaLabel}上传流无效`);
      return;
    }
    source.on("error", (error) => {
      console.error(`[导演工作台] ${mediaLabel}请求流失败：`, error);
      failUpload(`${mediaLabel}上传流意外中断`);
    });
    onRequestAbort = () => failUpload(`${mediaLabel}上传已中断`);
    req.signal.addEventListener("abort", onRequestAbort, { once: true });
    if (req.signal.aborted) {
      onRequestAbort();
      return;
    }
    source.pipe(bodyLimiter).pipe(busboy);
  });

  if (!result.ok || !result.storedName) {
    return fail(result.error ?? "上传失败", 400);
  }

  const incoming = result.size ?? 0;
  const id = result.storedName.split(".")[0];
  const filePath = path.join(UPLOAD_DIR, result.storedName);
  let transactionStarted = false;
  let quotaError: string | null = null;
  try {
    // Serialize quota accounting with the insert so concurrent uploads cannot
    // all pass against the same stale SUM result.
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const totalUsed = (
      db
        .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS s FROM videos")
        .get() as unknown as { s: number }
    ).s;
    const userUsed = (
      db
        .prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS s FROM videos WHERE uploaded_by = ?",
        )
        .get(user.username) as unknown as { s: number }
    ).s;

    if (Number(totalUsed) + incoming > GLOBAL_VIDEO_QUOTA_BYTES) {
      quotaError = "服务器视频总容量已达上限（20GB），请先清理后再上传";
    } else if (Number(userUsed) + incoming > USER_VIDEO_QUOTA_BYTES) {
      quotaError = "你的个人上传配额已达上限（5GB），请先清理后再上传";
    }

    if (quotaError) {
      db.exec("ROLLBACK");
      transactionStarted = false;
    } else {
      db.prepare(
        `INSERT INTO videos (id, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        result.originalName ?? (isVoiceReference ? "未命名音源.wav" : "未命名视频.mp4"),
        result.storedName,
        result.mimeType ?? "application/octet-stream",
        incoming,
        user.username,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      transactionStarted = false;
    }
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
    }
    fs.rmSync(filePath, { force: true });
    throw error;
  }

  if (quotaError) {
    fs.rmSync(filePath, { force: true });
    return fail(quotaError, 413);
  }

    const row = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get(id) as unknown as VideoRow;
    return ok({ video: toVideoOut(row, true) });
  } finally {
    reservation.release();
  }
});
