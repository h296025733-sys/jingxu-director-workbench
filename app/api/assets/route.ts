import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import Busboy from "busboy";
import { db } from "@/lib/db";
import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { ASSET_DIR } from "@/lib/paths";
import { detectImageExt, mimeForImageExt } from "@/lib/storage";
import type { AssetOut, AssetRow } from "@/lib/types";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;
const GLOBAL_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const PROBE_BYTES = 12;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_ACTIVE_UPLOADS_PER_USER = 2;
const MAX_ACTIVE_UPLOADS_GLOBAL = 8;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const ASSET_UPLOAD_PROCESS_EPOCH = Date.now();
let staleAssetUploadCleanupComplete = false;
const MANAGED_ASSET_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

interface AssetUploadReservation {
  username: string;
  bytes: number;
}

const activeAssetUploadReservations = new Map<string, AssetUploadReservation>();

function cleanupStaleAssetUploadPartials(): void {
  if (
    staleAssetUploadCleanupComplete ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(/* turbopackIgnore: true */ ASSET_DIR, {
      withFileTypes: true,
    });
  } catch (error) {
    console.error("[导演工作台] 扫描参考图上传临时文件失败：", error);
    return;
  }
  let cleanupSucceeded = true;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isPartial = entry.name.endsWith(".uploading");
    const finalName = isPartial
      ? entry.name.slice(0, -".uploading".length)
      : entry.name;
    if (!MANAGED_ASSET_NAME.test(finalName)) continue;
    const candidate = path.join(ASSET_DIR, entry.name);
    try {
      const stat = fs.statSync(/* turbopackIgnore: true */ candidate);
      if (stat.mtimeMs >= ASSET_UPLOAD_PROCESS_EPOCH) continue;
      if (
        !isPartial &&
        db
          .prepare("SELECT 1 FROM assets WHERE stored_name = ?")
          .get(entry.name)
      ) {
        continue;
      }
      fs.rmSync(/* turbopackIgnore: true */ candidate, { force: true });
    } catch (error) {
      cleanupSucceeded = false;
      console.error(
        "[导演工作台] 清理上次进程遗留的参考图上传临时文件失败：",
        error,
      );
    }
  }
  staleAssetUploadCleanupComplete = cleanupSucceeded;
}

function removeAssetFileBestEffort(filePath: string): void {
  try {
    fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true });
  } catch (error) {
    console.error("[导演工作台] 清理参考图上传文件失败：", error);
  }
}

function reserveAssetUpload(
  username: string,
  request: Request,
): { release: () => void } | { error: string; status: number } {
  const userReservations = [...activeAssetUploadReservations.values()].filter(
    (reservation) => reservation.username === username,
  );
  if (userReservations.length >= MAX_ACTIVE_UPLOADS_PER_USER) {
    return { error: "每位用户最多同时上传 2 张参考图片", status: 429 };
  }
  if (activeAssetUploadReservations.size >= MAX_ACTIVE_UPLOADS_GLOBAL) {
    return { error: "服务器同时上传的参考图片过多，请稍后再试", status: 429 };
  }
  const contentLength = Number(request.headers.get("content-length"));
  const reservedBytes =
    Number.isSafeInteger(contentLength) && contentLength > 0
      ? Math.min(MAX_FILE_BYTES, contentLength)
      : MAX_FILE_BYTES;
  const activeGlobalBytes = [...activeAssetUploadReservations.values()].reduce(
    (sum, reservation) => sum + reservation.bytes,
    0,
  );
  const activeUserBytes = userReservations.reduce(
    (sum, reservation) => sum + reservation.bytes,
    0,
  );
  const totalUsed = Number(
    (
      db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS size FROM assets").get() as unknown as {
        size: number;
      }
    ).size,
  );
  const userUsed = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS size FROM assets WHERE uploaded_by = ?",
        )
        .get(username) as unknown as { size: number }
    ).size,
  );
  if (totalUsed + activeGlobalBytes + reservedBytes > GLOBAL_QUOTA_BYTES) {
    return { error: "服务器参考图片容量（含上传中内容）已达 2GB 上限", status: 413 };
  }
  if (userUsed + activeUserBytes + reservedBytes > USER_QUOTA_BYTES) {
    return { error: "个人参考图片容量（含上传中内容）已达 500MB 上限", status: 413 };
  }
  const token = randomUUID();
  activeAssetUploadReservations.set(token, { username, bytes: reservedBytes });
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      activeAssetUploadReservations.delete(token);
    },
  };
}

interface UploadResult {
  ok: boolean;
  error?: string;
  id?: string;
  storedName?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
}

function toAssetOut(row: AssetRow): AssetOut {
  return {
    id: row.id,
    name: row.original_name,
    size: row.size_bytes,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    url: `/api/assets/${encodeURIComponent(row.id)}/file`,
  };
}

function cleanOriginalName(value: string): string {
  return path
    .basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
}

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  const scope = req.nextUrl.searchParams.get("scope");
  const unlinkedValue = req.nextUrl.searchParams.get("unlinked");
  const onlyUnlinked =
    scope === "unlinked" || unlinkedValue === "1" || unlinkedValue === "true";

  const sql = onlyUnlinked
    ? `SELECT a.* FROM assets a
       WHERE a.uploaded_by = ?
         AND NOT EXISTS (
           SELECT 1 FROM task_assets ta WHERE ta.asset_id = a.id
         )
       ORDER BY a.created_at DESC`
    : `SELECT a.* FROM assets a
       WHERE a.uploaded_by = ?
       ORDER BY a.created_at DESC`;
  const rows = db.prepare(sql).all(user.username) as unknown as AssetRow[];
  return ok({ assets: rows.map(toAssetOut) });
});

/** Stream one image to disk and retain only its small format probe in memory. */
export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return fail("请使用 multipart/form-data 上传图片", 415);
  }
  if (!req.body) return fail("上传请求没有内容", 400);
  const requestLength = Number(req.headers.get("content-length"));
  if (
    Number.isSafeInteger(requestLength) &&
    requestLength > MAX_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    return fail("图片上传请求超过 21MB 上限", 413);
  }
  cleanupStaleAssetUploadPartials();

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: Object.fromEntries(req.headers.entries()),
      defParamCharset: "utf8",
      limits: {
        files: 1,
        fileSize: MAX_FILE_BYTES,
        fields: 0,
        fieldSize: 0,
        parts: 2,
      },
    });
  } catch {
    return fail("multipart/form-data 请求格式无效", 400);
  }

  const reservation = reserveAssetUpload(user.username, req);
  if ("error" in reservation) return fail(reservation.error, reservation.status);

  try {
    const result = await new Promise<UploadResult>((resolve) => {
    let receivedFile = false;
    let originalName = "";
    let id = "";
    let storedName = "";
    let partialPath = "";
    let ext = "";
    let size = 0;
    let probeChunks: Buffer[] = [];
    let probeSize = 0;
    let writeStream: fs.WriteStream | null = null;
    let currentFileStream: Readable | null = null;
    let source: Readable | null = null;
    let writeFinished = false;
    let writeClosed = false;
    let parserFinished = false;
    let settled = false;
    let resultResolved = false;
    let requestBytes = 0;
    let uploadTimer: ReturnType<typeof setTimeout> | null = null;

    const bodyLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        requestBytes += chunk.length;
        if (
          requestBytes >
          MAX_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
        ) {
          callback(new Error("ASSET_REQUEST_TOO_LARGE"));
          return;
        }
        callback(null, chunk);
      },
    });

    const cleanupPartialFile = () => {
      for (const candidate of [
        partialPath,
        storedName ? path.join(ASSET_DIR, storedName) : "",
      ]) {
        if (candidate) removeAssetFileBestEffort(candidate);
      }
    };

    let onRequestAbort: (() => void) | null = null;
    const resolveOnce = (value: UploadResult) => {
      if (resultResolved) return;
      resultResolved = true;
      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
      }
      if (onRequestAbort) {
        req.signal.removeEventListener("abort", onRequestAbort);
      }
      resolve(value);
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
        resolveOnce({ ok: false, error });
      });
    };

    const failInternal = (label: string, error: unknown) => {
      console.error(`[导演工作台] ${label}：`, error);
      failUpload("图片上传流意外中断");
    };

    uploadTimer = setTimeout(
      () => failUpload("图片上传超时，请重新上传"),
      UPLOAD_TIMEOUT_MS,
    );
    uploadTimer.unref();

    const finishUpload = () => {
      if (
        settled ||
        !parserFinished ||
        !writeFinished ||
        !writeClosed ||
        !id ||
        !storedName ||
        !ext
      ) {
        return;
      }
      settled = true;
      resolveOnce({
        ok: true,
        id,
        storedName,
        originalName: originalName || `未命名图片${ext}`,
        mimeType: mimeForImageExt(ext),
        size,
      });
    };

    const startWrite = (initialData: Buffer): boolean => {
      const detected = detectImageExt(initialData);
      if (!detected) return false;

      ext = detected;
      id = randomUUID();
      storedName = `${id}${ext}`;
      partialPath = path.join(ASSET_DIR, `${storedName}.uploading`);
      size = initialData.length;
      writeStream = fs.createWriteStream(partialPath, {
        flags: "wx",
      });
      writeStream.on("error", (error) =>
        failInternal("参考图写入失败", error),
      );
      writeStream.on("finish", () => {
        writeFinished = true;
        finishUpload();
      });
      writeStream.on("close", () => {
        writeClosed = true;
        if (!writeFinished && !settled) {
          failUpload("图片写入提前结束");
          return;
        }
        finishUpload();
      });
      writeStream.write(initialData);
      return true;
    };

    busboy.on("file", (fieldName, stream, info) => {
      currentFileStream = stream;
      if (receivedFile || fieldName !== "file") {
        failUpload(
          receivedFile
            ? "一次只能上传一张图片"
            : "图片必须使用 file 表单字段上传",
        );
        return;
      }
      receivedFile = true;
      originalName = cleanOriginalName(info.filename ?? "");
      let fileEnded = false;

      stream.on("limit", () => failUpload("图片超过 20MB 上限"));

      stream.on("error", (error) =>
        failInternal("参考图请求流失败", error),
      );

      stream.on("data", (chunk: Buffer) => {
        if (settled) return;

        if (!writeStream) {
          probeChunks.push(chunk);
          probeSize += chunk.length;
          if (probeSize >= PROBE_BYTES) {
            const initialData = Buffer.concat(probeChunks, probeSize);
            probeChunks = [];
            if (!startWrite(initialData)) {
              failUpload("仅支持内容真实有效的 JPG、PNG 或 WebP 图片");
            }
          }
          return;
        }

        size += chunk.length;
        if (!writeStream.write(chunk)) {
          stream.pause();
          writeStream.once("drain", () => {
            if (!settled && !stream.destroyed) stream.resume();
          });
        }
      });

      stream.on("end", () => {
        fileEnded = true;
        if (settled) return;
        if (!writeStream) {
          const initialData = Buffer.concat(probeChunks, probeSize);
          probeChunks = [];
          if (!startWrite(initialData)) {
            failUpload("仅支持内容真实有效的 JPG、PNG 或 WebP 图片");
            return;
          }
        }
        const activeWriteStream = writeStream;
        if (!activeWriteStream) {
          failUpload("图片写入未能启动");
          return;
        }
        activeWriteStream.end();
      });
      stream.on("close", () => {
        if (!fileEnded && !settled) {
          failUpload("图片上传提前结束");
        }
      });
    });

    busboy.on("field", () =>
      failUpload("只允许上传 file 图片字段"),
    );
    busboy.on("fieldsLimit", () =>
      failUpload("图片上传不允许额外字段"),
    );
    busboy.on("filesLimit", () =>
      failUpload("一次只能上传一张图片"),
    );
    busboy.on("partsLimit", () =>
      failUpload("一次只能上传一张图片"),
    );
    busboy.on("error", (error) =>
      failInternal("multipart 图片解析失败", error),
    );
    busboy.on("finish", () => {
      parserFinished = true;
      if (!receivedFile) {
        failUpload("未收到图片文件");
        return;
      }
      finishUpload();
    });
    busboy.on("close", () => {
      if (!parserFinished && !settled) {
        failUpload("图片上传请求提前结束");
      }
    });

    bodyLimiter.on("error", (error) => {
      if (error.message === "ASSET_REQUEST_TOO_LARGE") {
        failUpload("图片上传请求超过 21MB 上限");
        return;
      }
      failInternal("参考图请求限流失败", error);
    });

    try {
      source = Readable.fromWeb(req.body as unknown as WebReadableStream);
    } catch (error) {
      failInternal("参考图请求流初始化失败", error);
      return;
    }
    source.on("error", (error) =>
      failInternal("参考图请求流失败", error),
    );
    onRequestAbort = () => failUpload("图片上传已中断");
    req.signal.addEventListener("abort", onRequestAbort, { once: true });
    if (req.signal.aborted) {
      onRequestAbort();
      return;
    }
    source.pipe(bodyLimiter).pipe(busboy);
  });

  if (
    !result.ok ||
    !result.id ||
    !result.storedName ||
    result.size === undefined
  ) {
    return fail(result.error ?? "图片上传失败", 400);
  }

  const filePath = path.join(ASSET_DIR, result.storedName);
  const partialFilePath = path.join(
    ASSET_DIR,
    `${result.storedName}.uploading`,
  );
  const incoming = result.size;
  let transactionStarted = false;
  let quotaError: string | null = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const totalUsedRow = db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS size FROM assets")
      .get() as unknown as { size: number };
    const userUsedRow = db
      .prepare(
        "SELECT COALESCE(SUM(size_bytes), 0) AS size FROM assets WHERE uploaded_by = ?",
      )
      .get(user.username) as unknown as { size: number };

    if (Number(totalUsedRow.size) + incoming > GLOBAL_QUOTA_BYTES) {
      quotaError = "服务器参考图片总容量已达 2GB 上限，请先清理后再上传";
    } else if (Number(userUsedRow.size) + incoming > USER_QUOTA_BYTES) {
      quotaError = "你的参考图片容量已达 500MB 上限，请先清理后再上传";
    }

    if (quotaError) {
      db.exec("ROLLBACK");
      transactionStarted = false;
    } else {
      db.prepare(
        `INSERT INTO assets
           (id, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        result.id,
        result.originalName ?? `未命名图片${path.extname(result.storedName)}`,
        result.storedName,
        result.mimeType ?? "application/octet-stream",
        incoming,
        user.username,
        new Date().toISOString(),
      );
      try {
        fs.renameSync(
          /* turbopackIgnore: true */ partialFilePath,
          filePath,
        );
      } catch (error) {
        console.error("[导演工作台] 参考图上传临时文件转正失败：", error);
        throw new Error("参考图上传文件转正失败");
      }
      logAudit(
        user.username,
        "asset_upload",
        `上传参考图片 ${result.originalName ?? result.storedName} (${incoming} bytes, id=${result.id})`,
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
    removeAssetFileBestEffort(partialFilePath);
    removeAssetFileBestEffort(filePath);
    throw error;
  }

  if (quotaError) {
    removeAssetFileBestEffort(partialFilePath);
    removeAssetFileBestEffort(filePath);
    return fail(quotaError, 413);
  }

    const row = db
      .prepare("SELECT * FROM assets WHERE id = ?")
      .get(result.id) as unknown as AssetRow;
    return ok({ asset: toAssetOut(row) });
  } finally {
    reservation.release();
  }
});
