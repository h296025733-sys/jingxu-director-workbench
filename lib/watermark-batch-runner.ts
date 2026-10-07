import "server-only";
import { dispatchWaitingWatermarks } from "./watermark-batches";
import { scheduleTask } from "./tasks";

const holder = globalThis as typeof globalThis & { __dwWatermarkIntakeTimer?: ReturnType<typeof setInterval> };
export function pumpWatermarkBatches(): void {
  for (const id of dispatchWaitingWatermarks()) scheduleTask(id);
}
export function startWatermarkBatchRunner(): void {
  if (holder.__dwWatermarkIntakeTimer || process.env.NEXT_PHASE === "phase-production-build" || process.env.NEXT_PRIVATE_BUILD_WORKER === "1") return;
  const tick = () => {
    try { pumpWatermarkBatches(); }
    catch (error) { console.error("[watermark-batch] intake dispatch error", error); }
  };
  holder.__dwWatermarkIntakeTimer = setInterval(tick, 5000);
  holder.__dwWatermarkIntakeTimer.unref();
  tick();
}
