import fs from "node:fs";
import path from "node:path";
import { ASSET_DIR, OPS_REFERENCE_VIDEO_DIR, THUMB_DIR, UPLOAD_DIR } from "./paths";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".ts": "video/mp2t",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".caf": "audio/x-caf",
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** 通过文件头魔数识别真实视频格式，防止伪装文件上传（存储型 XSS 防护） */
export function detectVideoExt(buffer: Buffer): string | null {
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 4, 8) === "ftyp"
  ) {
    return ".mp4"; // mp4 / mov / m4v
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) {
    return ".webm"; // EBML：webm / mkv
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "AVI "
  ) {
    return ".avi";
  }
  if (buffer.length >= 3 && buffer.toString("latin1", 0, 3) === "FLV") {
    return ".flv";
  }
  if (buffer.length >= 16) {
    const asf = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");
    if (buffer.subarray(0, 16).equals(asf)) return ".wmv";
  }
  if (
    buffer.length >= 376 &&
    buffer[0] === 0x47 &&
    buffer[188] === 0x47 &&
    buffer[376] === 0x47
  ) {
    return ".ts"; // MPEG-TS
  }
  return null;
}

/**
 * Voice references may be either a supported video or a real audio file.
 * Detection is based on file bytes; the original suffix only disambiguates
 * container families whose signatures are shared (MP4/M4A, OGG/OPUS,
 * ASF/WMV/WMA).
 */
export function detectVoiceReferenceExt(
  buffer: Buffer,
  originalName = "",
): string | null {
  const suppliedExt = path.extname(originalName).toLowerCase();
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WAVE"
  ) {
    return ".wav";
  }
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "fLaC") {
    return ".flac";
  }
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "OggS") {
    return suppliedExt === ".opus" ? ".opus" : ".ogg";
  }
  if (
    buffer.length >= 3 &&
    buffer.toString("latin1", 0, 3) === "ID3"
  ) {
    return ".mp3";
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xf6) === 0xf0
  ) {
    return ".aac";
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xe0) === 0xe0 &&
    (buffer[1] & 0x06) !== 0
  ) {
    return ".mp3";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "FORM" &&
    ["AIFF", "AIFC"].includes(buffer.toString("latin1", 8, 12))
  ) {
    return ".aiff";
  }
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "caff") {
    return ".caf";
  }

  const videoExt = detectVideoExt(buffer);
  if (!videoExt) return null;
  if (videoExt === ".mp4" && [".m4a", ".m4b"].includes(suppliedExt)) {
    return ".m4a";
  }
  if (videoExt === ".wmv" && suppliedExt === ".wma") return ".wma";
  return videoExt;
}

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Detect the supported image format from file bytes, never from client MIME. */
export function detectImageExt(buffer: Buffer): string | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return ".jpg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

export function mimeForImageExt(ext: string): string {
  return IMAGE_MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

function safeChildPath(root: string, fileName: string, label: string): string {
  if (
    !fileName ||
    path.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName ||
    path.posix.basename(fileName) !== fileName
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const rootPath = path.resolve(root);
  const candidate = path.resolve(rootPath, fileName);
  if (!candidate.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid ${label}`);
  }
  return candidate;
}

export function getAssetPath(storedName: string): string {
  return safeChildPath(ASSET_DIR, storedName, "asset filename");
}

export function deleteAssetFile(storedName: string): void {
  const filePath = getAssetPath(storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function getVideoPath(storedName: string): string {
  return safeChildPath(UPLOAD_DIR, storedName, "video filename");
}

export function deleteVideoFile(storedName: string): void {
  const filePath = getVideoPath(storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function getOpsReferenceVideoPath(storedName: string): string {
  return safeChildPath(OPS_REFERENCE_VIDEO_DIR, storedName, "operations reference video filename");
}

export function deleteOpsReferenceVideoFile(storedName: string): void {
  const filePath = getOpsReferenceVideoPath(storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

const THUMB_EXTS = ["jpg", "png", "webp"];

function getThumbnailFilePath(videoId: string, ext: string): string {
  return safeChildPath(THUMB_DIR, `${videoId}.${ext}`, "thumbnail filename");
}

export function saveThumbnail(videoId: string, dataUrl: string): string {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("不支持的缩略图格式");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) throw new Error("缩略图内容为空");
  if (buffer.length > 1024 * 1024) throw new Error("缩略图超过 1MB 上限");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  // 删除旧的缩略图，避免扩展名变化后残留
  deleteThumbnail(videoId);
  const filePath = getThumbnailFilePath(videoId, ext);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function getThumbnailPath(videoId: string): string | null {
  for (const ext of THUMB_EXTS) {
    const filePath = getThumbnailFilePath(videoId, ext);
    if (fs.existsSync(/* turbopackIgnore: true */ filePath)) return filePath;
  }
  return null;
}

export function deleteThumbnail(videoId: string): void {
  for (const ext of THUMB_EXTS) {
    const filePath = getThumbnailFilePath(videoId, ext);
    if (fs.existsSync(/* turbopackIgnore: true */ filePath)) fs.unlinkSync(filePath);
  }
}

export function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
