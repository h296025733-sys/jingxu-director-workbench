export const PUBLIC_WORKBENCH_ENTRY_URL =
  "https://h296025733-sys.github.io/director-workbench-entry/";
export const PUBLIC_WORKBENCH_TARGET_URL = `${PUBLIC_WORKBENCH_ENTRY_URL}target.json`;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

/**
 * Direct office/LAN addresses can use one streaming multipart request. Every
 * public hostname uses resumable chunks, including future custom domains.
 */
export function shouldUseResumableVideoUpload(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    isPrivateIpv4(normalized)
  ) {
    return false;
  }
  // A single-label Windows host name is an office/LAN address. Public DNS
  // names contain at least one dot.
  if (!normalized.includes(":") && !normalized.includes(".")) return false;
  return true;
}

export type UploadResponseBody =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "empty" }
  | { kind: "html" }
  | { kind: "invalid" };

/** Parse without ever exposing a proxy HTML body to employees. */
export function parseUploadResponseBody(text: string): UploadResponseBody {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^<!doctype\s+html|^<html\b|<body\b/i.test(trimmed)) {
    return { kind: "html" };
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { kind: "json", value: value as Record<string, unknown> };
    }
  } catch {
    // Classified as invalid below.
  }
  return { kind: "invalid" };
}

export function isRetryableUploadStatus(status: number): boolean {
  return (
    status === 0 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

export function isRetryableUploadFailure(status: number, code?: string): boolean {
  // Capacity is a real state, not a broken connection. Do not spend four long
  // network retries on an account that still has two legitimate uploads.
  if (code === "UPLOAD_USER_BUSY" || code === "UPLOAD_SERVER_BUSY") return false;
  return isRetryableUploadStatus(status);
}
