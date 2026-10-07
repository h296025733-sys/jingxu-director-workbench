import { freemem } from "node:os";
import { createMediaGate } from "./local-media-capacity";
// Nested resource permit, NOT a second owner job: avoids same-owner scheduler deadlock.
const holder = globalThis as typeof globalThis & { __jingxuVoiceGate?: ReturnType<typeof createMediaGate> };
const gate = holder.__jingxuVoiceGate ??= createMediaGate(() => ({freeBytes:freemem(), parallelism:1, cpuPercent:0}),1);
export async function withVoiceSlot<T>(signal: AbortSignal, run:()=>Promise<T>) {
  const release=await gate.acquire(signal);
  try {signal.throwIfAborted();return await run();} finally {release();}
}
