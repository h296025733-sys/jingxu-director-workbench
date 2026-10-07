import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import { addWatermarkBatchItem, cancelWaitingWatermarkItem, listWatermarkBatchItems, WatermarkBatchError } from "@/lib/watermark-batches";
import { startWatermarkBatchRunner } from "@/lib/watermark-batch-runner";

export const GET = withAuth<NoParams>(async (_req, _ctx, user) => {
  startWatermarkBatchRunner();
  return ok({ items: listWatermarkBatchItems(user.username) });
});
export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  try {
    const id = addWatermarkBatchItem(user.username, await readJson(req, 4096));
    startWatermarkBatchRunner();
    return ok({ id });
  } catch (error) {
    if (error instanceof WatermarkBatchError) return fail(error.message, error.status);
    throw error;
  }
});
export const DELETE = withAuth<NoParams>(async (req, _ctx, user) => {
  try {
    const body = await readJson(req, 4096);
    cancelWaitingWatermarkItem(user.username, String(body.id ?? ""));
    return ok({ canceled: true });
  } catch (error) {
    if (error instanceof WatermarkBatchError) return fail(error.message, error.status);
    throw error;
  }
});
