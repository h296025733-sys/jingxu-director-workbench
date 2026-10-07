"use client";

interface WritableFileHandle {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface AppFileHandle {
  createWritable(): Promise<WritableFileHandle>;
}

interface AppDirectoryHandle {
  name: string;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  getFileHandle(name: string, options: { create: true }): Promise<AppFileHandle>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<AppDirectoryHandle>;
  }
}

const DB_NAME = "director-workbench-preferences";
const STORE_NAME = "handles";
const DIRECTORY_KEY = "downloads";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开下载设置"));
  });
}

async function storedDirectory(): Promise<AppDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(DIRECTORY_KEY);
      request.onsuccess = () => resolve((request.result as AppDirectoryHandle) ?? null);
      request.onerror = () => reject(request.error ?? new Error("无法读取下载设置"));
    });
  } finally {
    database.close();
  }
}

async function storeDirectory(handle: AppDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(handle, DIRECTORY_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("无法保存下载设置"));
    });
  } finally {
    database.close();
  }
}

export function supportsRememberedDownloadFolder(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function currentDownloadFolderName(): Promise<string | null> {
  try {
    return (await storedDirectory())?.name ?? null;
  } catch {
    return null;
  }
}

export async function chooseDownloadFolder(): Promise<string> {
  if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持记住下载文件夹");
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await storeDirectory(handle);
  return handle.name;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (cleaned || "导演工作台附件").slice(0, 160);
}

function browserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadAttachment(
  url: string,
  suggestedName: string,
): Promise<"folder" | "browser"> {
  const fileName = safeFileName(suggestedName);
  const directory = await storedDirectory().catch(() => null);
  if (!directory) {
    browserDownload(url, fileName);
    return "browser";
  }
  let permission = await directory.queryPermission?.({ mode: "readwrite" });
  if (permission !== "granted") {
    permission = await directory.requestPermission?.({ mode: "readwrite" });
  }
  if (permission !== "granted") {
    browserDownload(url, fileName);
    return "browser";
  }
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("附件下载失败");
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(await response.blob());
  await writable.close();
  return "folder";
}
