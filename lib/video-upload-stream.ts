import "server-only";
import fs from "node:fs/promises";

/** A canceled proxy body can leave WebStream.cancel() pending indefinitely.
 * Do not await that network cleanup before closing our file and releasing the
 * session lock. Pending reads are observed, and cannot write after abort.
 */
export async function receiveVideoUploadChunk(
  body: ReadableStream<Uint8Array>,
  destination: string,
  expectedBytes: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<number> {
  const reader = body.getReader();
  const abortError = () => new DOMException("Upload aborted", "AbortError");
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  // The observer also covers an abort while the initial file open is pending.
  void aborted.catch(() => undefined);
  if (signal.aborted) onAbort();
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  let done = false;
  let received = 0;
  try {
    if (signal.aborted) throw abortError();
    file = await fs.open(destination, "wx");
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw abortError();
      if (next.done) { done = true; break; }
      received += next.value.byteLength;
      if (received > expectedBytes) throw new Error("CHUNK_TOO_LARGE");
      let offset = 0;
      while (offset < next.value.byteLength) {
        if (signal.aborted) throw abortError();
        const { bytesWritten } = await file.write(next.value, offset, next.value.byteLength - offset);
        if (!bytesWritten) throw new Error("CHUNK_WRITE_STOPPED");
        offset += bytesWritten;
      }
      onProgress(received);
    }
    return received;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!done) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close();
  }
}
