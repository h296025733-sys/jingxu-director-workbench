import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import { db } from "@/lib/db";
import {
  fileEntityTag,
  ifNoneMatchMatches,
  ifRangeAllowsPartial,
  parseSingleByteRange,
  privateRevalidationHeaders,
} from "@/lib/http-file-response";
import { OPS_REFERENCE_VIDEO_DIR } from "@/lib/paths";
import {
  deleteOpsReferenceVideoFile,
  detectVideoExt,
  getOpsReferenceVideoPath,
  mimeForExt,
} from "@/lib/storage";

export const runtime = "nodejs";

const MAX_REFERENCE_VIDEO_BYTES = 100 * 1024 * 1024;

interface ReferenceVideoRow {
  account_id: string;
  stored_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  handle: string;
  display_name: string;
}

function cleanAccountId(value: string | null): string {
  return value?.trim().slice(0, 120) || "";
}

function cleanOriginalName(value: string | null): string {
  const raw = value?.trim() || "reference-video";
  const base = path.win32.basename(path.posix.basename(raw));
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240) || "reference-video";
}

function findAccount(accountId: string): AccountRow | undefined {
  return db.prepare("SELECT id, handle, display_name FROM ops_accounts WHERE id = ?")
    .get(accountId) as unknown as AccountRow | undefined;
}

function findReferenceVideo(accountId: string): ReferenceVideoRow | undefined {
  return db.prepare("SELECT * FROM ops_account_reference_videos WHERE account_id = ?")
    .get(accountId) as unknown as ReferenceVideoRow | undefined;
}

function videoPayload(row: ReferenceVideoRow) {
  return {
    accountId: row.account_id,
    filename: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    updatedAt: row.updated_at,
    streamUrl: `/api/forms/reference-video?accountId=${encodeURIComponent(row.account_id)}&file=1&v=${encodeURIComponent(row.updated_at)}`,
  };
}

function bumpRevision(timestamp: string): number {
  db.prepare("UPDATE ops_state SET revision = revision + 1, updated_at = ? WHERE id = 1").run(timestamp);
  const row = db.prepare("SELECT revision FROM ops_state WHERE id = 1").get() as unknown as { revision: number };
  return Number(row.revision);
}

function insertHistory(options: {
  actorUsername: string;
  actorDisplayName: string;
  account: AccountRow;
  summary: string;
  before: unknown;
  after: unknown;
  timestamp: string;
}) {
  db.prepare(
    `INSERT INTO ops_change_logs
      (actor_username, actor_display_name, entity_type, entity_id, entity_label,
       action, summary, before_json, after_json, created_at)
     VALUES (?, ?, 'account', ?, ?, 'update', ?, ?, ?, ?)`,
  ).run(
    options.actorUsername,
    options.actorDisplayName,
    options.account.id,
    `${options.account.display_name}（${options.account.handle}）`,
    options.summary,
    options.before === null ? null : JSON.stringify(options.before),
    options.after === null ? null : JSON.stringify(options.after),
    options.timestamp,
  );
}

export const GET = withAuth<NoParams>(async (req) => {
  const accountId = cleanAccountId(req.nextUrl.searchParams.get("accountId"));
  if (!accountId) return fail("缺少账号，请刷新后重试。", 400);
  if (!findAccount(accountId)) return fail("账号不存在，请刷新后重试。", 404);

  const row = findReferenceVideo(accountId);
  if (req.nextUrl.searchParams.get("file") !== "1") {
    return ok({ video: row ? videoPayload(row) : null });
  }
  if (!row) return fail("参考视频不存在。", 404);

  const filePath = getOpsReferenceVideoPath(row.stored_name);
  if (!fs.existsSync(filePath)) return fail("参考视频文件已丢失，请重新上传。", 404);
  const stat = fs.statSync(filePath);
  const etag = fileEntityTag(stat);
  const headers = {
    ...privateRevalidationHeaders(stat, etag),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
  };
  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const requestedRange = req.headers.get("range");
  const range = requestedRange && ifRangeAllowsPartial(req.headers.get("if-range"), etag, stat.mtimeMs)
    ? parseSingleByteRange(requestedRange, stat.size)
    : undefined;
  if (requestedRange && range === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" },
    });
  }
  if (range) {
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start: range.start, end: range.end })) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Type": row.mime_type,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(filePath)) as unknown as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": row.mime_type,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
    },
  });
});

export const PUT = withAuth<NoParams>(async (req, _ctx, user) => {
  const accountId = cleanAccountId(req.nextUrl.searchParams.get("accountId"));
  if (!accountId) return fail("缺少账号，请刷新后重试。", 400);
  const account = findAccount(accountId);
  if (!account) return fail("账号不存在，请刷新后重试。", 404);
  if (!req.body) return fail("没有收到视频文件。", 400);

  const contentLength = Number(req.headers.get("content-length"));
  const expectedSize = Number(req.nextUrl.searchParams.get("size"));
  if ((Number.isSafeInteger(contentLength) && contentLength > MAX_REFERENCE_VIDEO_BYTES)
    || (Number.isSafeInteger(expectedSize) && expectedSize > MAX_REFERENCE_VIDEO_BYTES)) {
    return fail("单个参考视频不能超过 100MB。", 413);
  }

  const partialName = `${randomUUID()}.partial`;
  const partialPath = path.join(OPS_REFERENCE_VIDEO_DIR, partialName);
  let total = 0;
  let tooLarge = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_REFERENCE_VIDEO_BYTES) {
        tooLarge = true;
        callback(new Error("REFERENCE_VIDEO_TOO_LARGE"));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    const source = Readable.fromWeb(req.body as unknown as WebReadableStream);
    await pipeline(source, limiter, fs.createWriteStream(partialPath, { flags: "wx" }), { signal: req.signal });
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    if (tooLarge) return fail("单个参考视频不能超过 100MB。", 413);
    if (req.signal.aborted) return fail("上传已取消，请重新选择视频。", 400);
    console.error("[镜序] 账号参考视频上传失败：", error);
    return fail("参考视频上传中断，请重试。", 400);
  }

  if (!total || (Number.isSafeInteger(expectedSize) && expectedSize > 0 && expectedSize !== total)) {
    fs.rmSync(partialPath, { force: true });
    return fail("参考视频没有完整上传，请重试。", 400);
  }

  const probe = Buffer.alloc(Math.min(4096, total));
  const descriptor = fs.openSync(partialPath, "r");
  let probeLength = 0;
  try {
    probeLength = fs.readSync(descriptor, probe, 0, probe.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const extension = detectVideoExt(probe.subarray(0, probeLength));
  if (extension !== ".mp4" && extension !== ".webm") {
    fs.rmSync(partialPath, { force: true });
    return fail("文件内容不是支持的视频（请使用 MP4、MOV、M4V 或 WebM）。", 400);
  }

  const storedName = `${randomUUID()}${extension}`;
  const finalPath = getOpsReferenceVideoPath(storedName);
  fs.renameSync(partialPath, finalPath);
  const timestamp = new Date().toISOString();
  const originalName = cleanOriginalName(req.nextUrl.searchParams.get("filename"));
  const mimeType = mimeForExt(extension);
  let oldRow: ReferenceVideoRow | undefined;
  let revision = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    oldRow = findReferenceVideo(accountId);
    const createdAt = oldRow?.created_at || timestamp;
    db.prepare(
      `INSERT INTO ops_account_reference_videos
        (account_id, stored_name, original_name, mime_type, size_bytes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         stored_name = excluded.stored_name,
         original_name = excluded.original_name,
         mime_type = excluded.mime_type,
         size_bytes = excluded.size_bytes,
         created_by = excluded.created_by,
         updated_at = excluded.updated_at`,
    ).run(accountId, storedName, originalName, mimeType, total, user.username, createdAt, timestamp);
    const current = findReferenceVideo(accountId);
    if (!current) throw new Error("Reference video metadata was not persisted");
    insertHistory({
      actorUsername: user.username,
      actorDisplayName: user.displayName,
      account,
      summary: `${oldRow ? "替换" : "上传"}了账号 ${account.handle} 的参考视频`,
      before: oldRow ? videoPayload(oldRow) : null,
      after: videoPayload(current),
      timestamp,
    });
    revision = bumpRevision(timestamp);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    fs.rmSync(finalPath, { force: true });
    throw error;
  }
  if (oldRow && oldRow.stored_name !== storedName) {
    try { deleteOpsReferenceVideoFile(oldRow.stored_name); } catch (error) { console.error("[镜序] 清理旧参考视频失败：", error); }
  }
  const current = findReferenceVideo(accountId);
  return ok({ video: current ? videoPayload(current) : null, revision });
});

export const DELETE = withAuth<NoParams>(async (req, _ctx, user) => {
  const accountId = cleanAccountId(req.nextUrl.searchParams.get("accountId"));
  if (!accountId) return fail("缺少账号，请刷新后重试。", 400);
  const account = findAccount(accountId);
  if (!account) return fail("账号不存在，请刷新后重试。", 404);
  const oldRow = findReferenceVideo(accountId);
  if (!oldRow) return ok({ removed: false });

  const timestamp = new Date().toISOString();
  let revision = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM ops_account_reference_videos WHERE account_id = ?").run(accountId);
    insertHistory({
      actorUsername: user.username,
      actorDisplayName: user.displayName,
      account,
      summary: `移除了账号 ${account.handle} 的参考视频`,
      before: videoPayload(oldRow),
      after: null,
      timestamp,
    });
    revision = bumpRevision(timestamp);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    throw error;
  }
  try { deleteOpsReferenceVideoFile(oldRow.stored_name); } catch (error) { console.error("[镜序] 删除参考视频文件失败：", error); }
  return ok({ removed: true, revision });
});
