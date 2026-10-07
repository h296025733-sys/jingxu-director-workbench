import type { Stats } from "node:fs";

type FileStat = Pick<Stats, "size" | "mtime" | "mtimeMs">;

export interface ParsedByteRange {
  start: number;
  end: number;
}

/**
 * Build a strong validator without exposing a local path. The files served by
 * these routes are immutable (or atomically replaced, for thumbnails), so size
 * plus the high-resolution modification time is a stable representation ID.
 */
export function fileEntityTag(stat: FileStat): string {
  const modifiedMicros = Math.max(0, Math.trunc(stat.mtimeMs * 1000));
  return `"${stat.size.toString(36)}-${modifiedMicros.toString(36)}"`;
}

function stripWeakPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

/** GET/HEAD If-None-Match uses weak comparison and takes precedence over Range. */
export function ifNoneMatchMatches(
  headerValue: string | null,
  etag: string,
): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(",")
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === "*" || stripWeakPrefix(candidate) === etag,
    );
}

/**
 * If-Range only accepts a strong matching ETag, or an HTTP date that is not
 * older than the current representation. A mismatch means ignore Range and
 * return the complete file.
 */
export function ifRangeAllowsPartial(
  headerValue: string | null,
  etag: string,
  modifiedAtMs: number,
): boolean {
  if (!headerValue) return true;
  const value = headerValue.trim();
  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) return value === etag;
  const parsedDate = Date.parse(value);
  if (!Number.isFinite(parsedDate)) return false;
  return Math.floor(modifiedAtMs / 1000) * 1000 <= parsedDate;
}

/** Parse one RFC 9110 byte range. Multiple ranges are intentionally rejected. */
export function parseSingleByteRange(
  headerValue: string,
  size: number,
): ParsedByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function privateRevalidationHeaders(
  stat: FileStat,
  etag = fileEntityTag(stat),
): Record<string, string> {
  return {
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}
