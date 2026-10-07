import type { VideoOut } from "./types";
import {
  isRetryableUploadStatus,
  isRetryableUploadFailure,
  parseUploadResponseBody,
  PUBLIC_WORKBENCH_ENTRY_URL,
  PUBLIC_WORKBENCH_TARGET_URL,
  shouldUseResumableVideoUpload,
} from "./video-upload-client-policy";

const VIDEO_UPLOAD_TIMEOUT_MS = 16 * 60 * 1000;
const REMOTE_CHUNK_CONCURRENCY = 6;
const REMOTE_CHUNK_TIMEOUT_MS = 110_000;
const REMOTE_CHUNK_BYTES = 1024 * 1024;
const REMOTE_CHUNK_MAX_ATTEMPTS = 3;
const REMOTE_INIT_MAX_ATTEMPTS = 4;
const REMOTE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const REMOTE_COMPLETE_DEADLINE_MS = 12 * 60 * 1000;
const THUMBNAIL_METADATA_TIMEOUT_MS = 6000;
const THUMBNAIL_SEEK_TIMEOUT_MS = 4000;

export interface VideoUploadProgress {
  percent: number;
  phase: "uploading" | "saving";
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  statusText?: string;
}

export type VideoUploadPurpose = "video" | "voice_reference";

class UploadHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UploadHttpError";
  }
}

export class VideoUploadConnectionError extends Error {
  readonly recoveryUrl = PUBLIC_WORKBENCH_ENTRY_URL;

  constructor(
    message: string,
    readonly entryChanged: boolean,
  ) {
    super(message);
    this.name = "VideoUploadConnectionError";
  }
}

export type VideoUploadRecovery =
  | { kind: "reconnect"; url: string }
  | { kind: "retry" }
  | null;

export function getVideoUploadRecovery(error: unknown): VideoUploadRecovery {
  if (error instanceof VideoUploadConnectionError) {
    return error.entryChanged
      ? { kind: "reconnect", url: error.recoveryUrl }
      : { kind: "retry" };
  }
  if (
    error instanceof UploadHttpError &&
    isRetryableUploadStatus(error.status)
  ) {
    return { kind: "retry" };
  }
  return null;
}

function isRemoteUploadEndpoint(): boolean {
  return (
    typeof window !== "undefined" &&
    shouldUseResumableVideoUpload(window.location.hostname)
  );
}

function isRotatingQuickTunnelPage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(".trycloudflare.com")
  );
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("视频上传已取消"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error("视频上传已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new Error("UPLOAD_REQUEST_TIMEOUT")),
    timeoutMs,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function currentPublishedTunnelUrl(): Promise<string | null> {
  if (!isRemoteUploadEndpoint()) return null;
  try {
    const response = await fetchWithTimeout(
      `${PUBLIC_WORKBENCH_TARGET_URL}?v=${Date.now()}`,
      { cache: "no-store", credentials: "omit" },
      8000,
    );
    if (!response.ok) return null;
    const parsed = parseUploadResponseBody(await response.text());
    if (parsed.kind !== "json" || typeof parsed.value.url !== "string") {
      return null;
    }
    const target = new URL(parsed.value.url);
    if (
      target.protocol !== "https:" ||
      !target.hostname.endsWith(".trycloudflare.com")
    ) {
      return null;
    }
    return target.origin;
  } catch {
    return null;
  }
}

async function publicConnectionError(
  fallback = "公网连接在上传时中断，请重试",
): Promise<VideoUploadConnectionError> {
  const publishedTarget = await currentPublishedTunnelUrl();
  const entryChanged =
    isRotatingQuickTunnelPage() &&
    Boolean(publishedTarget) &&
    typeof window !== "undefined" &&
    publishedTarget !== window.location.origin;
  return new VideoUploadConnectionError(
    entryChanged
      ? "公网入口已经更新，请点“重新连接”打开固定入口后再上传"
      : fallback,
    entryChanged,
  );
}

async function ensureCurrentPublicEntry(): Promise<void> {
  const publishedTarget = await currentPublishedTunnelUrl();
  if (
    isRotatingQuickTunnelPage() &&
    publishedTarget &&
    typeof window !== "undefined" &&
    publishedTarget !== window.location.origin
  ) {
    throw new VideoUploadConnectionError(
      "当前页面是已失效的旧入口，请点“重新连接”后再上传",
      true,
    );
  }
}

async function readUploadResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const parsed = parseUploadResponseBody(await response.text());
  if (parsed.kind !== "json") {
    if (isRemoteUploadEndpoint()) {
      throw await publicConnectionError(
        response.status >= 500
          ? "公网服务暂时中断，请稍后重试"
          : "上传服务返回异常，请重试",
      );
    }
    throw new UploadHttpError(fallback, response.status);
  }
  const error = parsed.value.error;
  if (!response.ok) {
    throw new UploadHttpError(
      typeof error === "string" && error.trim() ? error : fallback,
      response.status,
      typeof parsed.value.code === "string" ? parsed.value.code : undefined,
    );
  }
  return parsed.value as T;
}

function uploadErrorIsRetryable(error: unknown): boolean {
  if (error instanceof VideoUploadConnectionError) return !error.entryChanged;
  if (error instanceof UploadHttpError) {
    return isRetryableUploadFailure(error.status, error.code);
  }
  return false;
}

async function normalizeNetworkUploadError(
  error: unknown,
  fallback: string,
): Promise<Error> {
  if (
    error instanceof VideoUploadConnectionError ||
    error instanceof UploadHttpError
  ) {
    return error;
  }
  if (isRemoteUploadEndpoint()) return publicConnectionError(fallback);
  return new UploadHttpError(fallback, 0);
}

async function xhrUploadError(
  xhr: XMLHttpRequest,
  fallback: string,
): Promise<Error> {
  const parsed = parseUploadResponseBody(xhr.responseText || "");
  if (parsed.kind === "json") {
    const detail = parsed.value.error;
    return new UploadHttpError(
      typeof detail === "string" && detail.trim() ? detail : fallback,
      xhr.status,
      typeof parsed.value.code === "string" ? parsed.value.code : undefined,
    );
  }
  if (isRemoteUploadEndpoint()) return publicConnectionError(fallback);
  return new UploadHttpError(fallback, xhr.status);
}

function uploadVideoFileOnce(
  file: File,
  onProgress?: (progress: VideoUploadProgress) => void,
  signal?: AbortSignal,
  purpose: VideoUploadPurpose = "video",
): Promise<VideoOut> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = performance.now();
    const abort = () => xhr.abort();
    if (signal?.aborted) {
      reject(new Error("视频上传已取消"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => signal?.removeEventListener("abort", abort);
    xhr.open(
      "POST",
      purpose === "voice_reference"
        ? "/api/videos?purpose=voice_reference"
        : "/api/videos",
    );
    xhr.timeout = VIDEO_UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const elapsedSeconds = Math.max(0.1, (performance.now() - startedAt) / 1000);
        onProgress?.({
          percent: Math.min(99, Math.round((event.loaded / event.total) * 100)),
          phase: "uploading",
          transferredBytes: event.loaded,
          totalBytes: event.total,
          bytesPerSecond: event.loaded / elapsedSeconds,
        });
      }
    };
    xhr.upload.onload = () => {
      const elapsedSeconds = Math.max(0.1, (performance.now() - startedAt) / 1000);
      onProgress?.({
        percent: 100,
        phase: "saving",
        transferredBytes: file.size,
        totalBytes: file.size,
        bytesPerSecond: file.size / elapsedSeconds,
      });
    };
    xhr.onload = async () => {
      finish();
      const parsed = parseUploadResponseBody(xhr.responseText || "");
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(await xhrUploadError(xhr, "视频上传失败"));
        return;
      }
      if (parsed.kind !== "json") {
        reject(await xhrUploadError(xhr, "视频保存响应异常，请重试"));
        return;
      }
      const data = parsed.value as { error?: unknown; video?: VideoOut };
      if (!data.video || typeof data.video.id !== "string") {
        reject(new Error("上传响应缺少视频 ID"));
        return;
      }
      resolve(data.video);
    };
    xhr.onerror = async () => {
      finish();
      reject(
        isRemoteUploadEndpoint()
          ? await publicConnectionError("公网连接在上传时中断，请重试")
          : new UploadHttpError("网络错误，视频上传失败", 0),
      );
    };
    xhr.ontimeout = () => {
      finish();
      reject(new UploadHttpError("视频上传超时", 408));
    };
    xhr.onabort = () => {
      finish();
      reject(new Error("视频上传已取消"));
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

interface UploadSessionResponse {
  session?: {
    id: string;
    chunkSize: number;
    chunkCount: number;
    totalSize: number;
  };
}

function uploadVideoChunk(
  sessionId: string,
  index: number,
  chunk: Blob,
  signal: AbortSignal,
  onLoaded: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (signal.aborted) {
      reject(new Error("视频上传已取消"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => signal.removeEventListener("abort", abort);
    xhr.open(
      "PUT",
      `/api/videos/upload-sessions/${encodeURIComponent(sessionId)}/chunks/${index}`,
    );
    xhr.timeout = REMOTE_CHUNK_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onLoaded(event.loaded);
    xhr.onload = async () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        onLoaded(chunk.size);
        resolve();
        return;
      }
      reject(await xhrUploadError(xhr, `第 ${index + 1} 块视频上传失败`));
    };
    xhr.onerror = async () => {
      finish();
      reject(
        isRemoteUploadEndpoint()
          ? await publicConnectionError(`第 ${index + 1} 块网络中断，正在准备重试`)
          : new UploadHttpError(`第 ${index + 1} 块网络中断`, 0),
      );
    };
    xhr.ontimeout = () => {
      finish();
      reject(new UploadHttpError(`第 ${index + 1} 块视频上传超时`, 408));
    };
    xhr.onabort = () => {
      finish();
      reject(new Error("视频上传已取消"));
    };
    xhr.send(chunk);
  });
}

async function uploadVideoFileInChunks(
  file: File,
  onProgress?: (progress: VideoUploadProgress) => void,
  signal?: AbortSignal,
  purpose: VideoUploadPurpose = "video",
): Promise<VideoOut> {
  if (signal?.aborted) throw new Error("视频上传已取消");
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  // Record the ID before POST: its response can disappear after the server
  // has created the reservation. Cancellation must still know what to release.
  let sessionId = crypto.randomUUID();
  const onPageHide = () => {
    controller.abort();
    if (sessionId && !completionStarted) {
      rememberUploadCleanup(sessionId);
      void fetch(`/api/videos/upload-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE", credentials: "same-origin", keepalive: true,
      }).catch(() => undefined);
    }
  };
  window.addEventListener("pagehide", onPageHide);
  let succeeded = false;
  let completionStarted = false;
  try {
    await Promise.all(pendingUploadCleanups().slice(0, 4).map(cleanupVideoUploadSession));
    await ensureCurrentPublicEntry();
    const idempotencyKey = sessionId;
    let initialized: UploadSessionResponse | null = null;
    let initError: Error = new Error("无法创建视频上传任务");
    for (let attempt = 0; attempt < REMOTE_INIT_MAX_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) throw new Error("视频上传已取消");
      try {
        const initResponse = await fetchWithTimeout(
          "/api/videos/upload-sessions",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              size: file.size,
              idempotencyKey,
              chunkSize: REMOTE_CHUNK_BYTES,
              purpose,
            }),
            signal: controller.signal,
          },
          REMOTE_REQUEST_TIMEOUT_MS,
        );
        initialized = await readUploadResponse<UploadSessionResponse>(
          initResponse,
          "无法创建视频上传任务",
        );
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const normalized = await normalizeNetworkUploadError(
          error,
          "公网连接暂时中断，正在准备重试",
        );
        initError = normalized;
        if (
          !uploadErrorIsRetryable(normalized) ||
          attempt >= REMOTE_INIT_MAX_ATTEMPTS - 1
        ) {
          throw initError;
        }
        onProgress?.({
          percent: 0,
          phase: "uploading",
          transferredBytes: 0,
          totalBytes: file.size,
          bytesPerSecond: 0,
          statusText: `连接有波动，正在重试（${attempt + 2}/${REMOTE_INIT_MAX_ATTEMPTS}）`,
        });
        await pause(500 * (attempt + 1), controller.signal);
        await ensureCurrentPublicEntry();
      }
    }
    const session = initialized?.session;
    if (
      !session ||
      typeof session.id !== "string" ||
      !Number.isSafeInteger(session.chunkSize) ||
      session.chunkSize <= 0 ||
      !Number.isSafeInteger(session.chunkCount) ||
      session.chunkCount <= 0 ||
      session.totalSize !== file.size
    ) {
      throw new Error("视频上传任务返回无效");
    }
    sessionId = session.id;

    const loadedByChunk = new Array<number>(session.chunkCount).fill(0);
    const completedByChunk = new Array<boolean>(session.chunkCount).fill(false);
    const startedAt = performance.now();
    const report = (index: number, loaded: number, statusText?: string) => {
      loadedByChunk[index] = Math.max(
        completedByChunk[index] ? loadedByChunk[index] : 0,
        Math.min(
          loaded,
          Math.min(session.chunkSize, file.size - index * session.chunkSize),
        ),
      );
      const transferredBytes = loadedByChunk.reduce(
        (sum, value) => sum + value,
        0,
      );
      const elapsedSeconds = Math.max(
        0.1,
        (performance.now() - startedAt) / 1000,
      );
      // A browser can report 100% before the tunnel/server acknowledges a
      // request. Only enter the saving phase after every chunk response has
      // succeeded; otherwise a failed request looks permanently stuck at 100%.
      const allBytesSent = completedByChunk.every(Boolean);
      onProgress?.({
        percent: allBytesSent
          ? 100
          : Math.min(99, Math.round((transferredBytes / file.size) * 100)),
        phase: allBytesSent ? "saving" : "uploading",
        transferredBytes,
        totalBytes: file.size,
        bytesPerSecond: transferredBytes / elapsedSeconds,
        statusText,
      });
    };

    const resetUnconfirmedChunk = (index: number, statusText: string) => {
      if (!completedByChunk[index]) loadedByChunk[index] = 0;
      report(index, loadedByChunk[index], statusText);
    };

    const markChunkCompleted = (index: number, size: number) => {
      completedByChunk[index] = true;
      loadedByChunk[index] = size;
      report(index, size);
    };

    let nextIndex = 0;
    let concurrency = REMOTE_CHUNK_CONCURRENCY;
    let activeRequests = 0;
    let lastConfirmationAt = performance.now();
    const heartbeat = window.setInterval(() => {
      if (controller.signal.aborted || performance.now() - lastConfirmationAt < 10_000) return;
      const count = completedByChunk.filter(Boolean).length;
      report(0, loadedByChunk[0], `正在传送视频，已完成 ${count}/${session.chunkCount}，网络较慢时会自动重试`);
    }, 3000);
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= session.chunkCount) return;
        const start = index * session.chunkSize;
        const end = Math.min(file.size, start + session.chunkSize);
        let lastError: unknown;
        for (let attempt = 0; attempt < REMOTE_CHUNK_MAX_ATTEMPTS; attempt += 1) {
          try {
            while (activeRequests >= concurrency && !controller.signal.aborted) {
              await pause(100, controller.signal);
            }
            if (controller.signal.aborted) throw new Error("视频上传已取消");
            activeRequests += 1;
            try {
              await uploadVideoChunk(
                session.id, index, file.slice(start, end), controller.signal,
                (loaded) => report(index, loaded),
              );
            } finally {
              activeRequests -= 1;
            }
            lastConfirmationAt = performance.now();
            markChunkCompleted(index, end - start);
            lastError = undefined;
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error;
            if (
              uploadErrorIsRetryable(error) &&
              attempt < REMOTE_CHUNK_MAX_ATTEMPTS - 1
            ) {
              concurrency = Math.max(2, Math.floor(concurrency / 2));
              resetUnconfirmedChunk(
                index,
                `已保留传好的部分，正在降低并发重试（${attempt + 2}/${REMOTE_CHUNK_MAX_ATTEMPTS}）`,
              );
              await pause(500 * (attempt + 1), controller.signal);
              await ensureCurrentPublicEntry();
              continue;
            }
            break;
          }
        }
        if (lastError) {
          throw lastError;
        }
      }
    };
    const workers = Array.from(
          { length: Math.min(REMOTE_CHUNK_CONCURRENCY, session.chunkCount) },
          () => worker(),
        );
    try {
      await Promise.all(workers);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      throw error;
    } finally {
      window.clearInterval(heartbeat);
    }

    const elapsedSeconds = Math.max(
      0.1,
      (performance.now() - startedAt) / 1000,
    );
    onProgress?.({
      percent: 100,
      phase: "saving",
      transferredBytes: file.size,
      totalBytes: file.size,
      bytesPerSecond: file.size / elapsedSeconds,
    });

    let lastError: Error = new Error("视频保存失败");
    let completeAttempt = 0;
    const completeDeadline = Date.now() + REMOTE_COMPLETE_DEADLINE_MS;
    while (Date.now() < completeDeadline) {
      if (controller.signal.aborted) throw new Error("视频上传已取消");
      completeAttempt += 1;
      try {
        completionStarted = true;
        const completeResponse = await fetchWithTimeout(
          `/api/videos/upload-sessions/${encodeURIComponent(session.id)}/complete`,
          {
            method: "POST",
            credentials: "same-origin",
            signal: controller.signal,
          },
          REMOTE_REQUEST_TIMEOUT_MS,
        );
        const completed = await readUploadResponse<{ video?: VideoOut }>(
          completeResponse,
          "视频保存失败",
        );
        if (!completed.video || typeof completed.video.id !== "string") {
          throw new UploadHttpError("视频保存响应缺少视频 ID", 500);
        }
        succeeded = true;
        void cleanupVideoUploadSession(session.id);
        return completed.video;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const normalized = await normalizeNetworkUploadError(
          error,
          "公网连接在保存视频时中断，正在确认结果",
        );
        lastError = normalized;
        if (!uploadErrorIsRetryable(normalized)) throw normalized;
        await ensureCurrentPublicEntry();
        const secondsLeft = Math.max(
          0,
          Math.ceil((completeDeadline - Date.now()) / 1000),
        );
        onProgress?.({
          percent: 100,
          phase: "saving",
          transferredBytes: file.size,
          totalBytes: file.size,
          bytesPerSecond: file.size / elapsedSeconds,
          statusText:
            normalized instanceof UploadHttpError && normalized.status === 409
              ? "视频正在服务器保存，正在确认结果…"
              : `连接有波动，正在确认保存结果（约剩 ${secondsLeft} 秒）`,
        });
        await pause(Math.min(5000, 750 + completeAttempt * 500), controller.signal);
      }
    }
    throw lastError;
  } catch (error) {
    // Promise.all aborts sibling requests after a real chunk failure. Do not
    // turn that internal cleanup into a misleading user-cancelled message.
    if (signal?.aborted) {
      throw new Error("视频上传已取消");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    window.removeEventListener("pagehide", onPageHide);
    // Once completion may have reached the server, deleting the session can
    // erase the only idempotency record after the video was actually saved.
    // Leave that uncertain session for the server's stale-session cleanup.
    if (sessionId && !succeeded && !completionStarted) {
      await cleanupVideoUploadSession(sessionId);
    }
  }
}

const UPLOAD_CLEANUP_KEY = "jingxu:failed-upload-cleanup:v1";

function pendingUploadCleanups(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(UPLOAD_CLEANUP_KEY) || "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(-16)
      : [];
  } catch { return []; }
}

function rememberUploadCleanup(id: string, remove = false): void {
  try {
    const pending = pendingUploadCleanups().filter(value => value !== id);
    if (!remove) pending.push(id);
    window.localStorage.setItem(UPLOAD_CLEANUP_KEY, JSON.stringify(pending.slice(-16)));
  } catch {
    // Private browsing may disable storage; server cancellation still applies.
  }
}

export async function cleanupVideoUploadSession(sessionId: string): Promise<boolean> {
  rememberUploadCleanup(sessionId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `/api/videos/upload-sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", credentials: "same-origin", keepalive: true },
        4000,
      );
      if (response.ok || response.status === 404) {
        rememberUploadCleanup(sessionId, true);
        return true;
      }
      if (!isRetryableUploadStatus(response.status)) return false;
    } catch {
      // The server also reclaims idle empty sessions if a browser disappears.
    }
    if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)));
  }
  return false;
}

export function uploadVideoFile(
  file: File,
  onProgress?: (progress: VideoUploadProgress) => void,
  signal?: AbortSignal,
  purpose: VideoUploadPurpose = "video",
): Promise<VideoOut> {
  return isRemoteUploadEndpoint()
    ? uploadVideoFileInChunks(file, onProgress, signal, purpose)
    : uploadVideoFileOnce(file, onProgress, signal, purpose);
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "seeked",
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频封面读取超时"));
    }, timeoutMs);
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频解码失败"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/** 在浏览器端从视频文件截取一帧作为封面（无需 ffmpeg）。 */
export async function generateVideoThumbnail(
  file: File,
): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    const metadataReady = waitForVideoEvent(
      video,
      "loadedmetadata",
      THUMBNAIL_METADATA_TIMEOUT_MS,
    );
    video.src = objectUrl;
    video.load();
    await metadataReady;
    if (!video.videoWidth || !video.videoHeight) return null;

    const seekReady = waitForVideoEvent(
      video,
      "seeked",
      THUMBNAIL_SEEK_TIMEOUT_MS,
    );
    video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    await seekReady;

    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
