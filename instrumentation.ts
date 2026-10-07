export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" &&
      process.env.NEXT_PHASE !== "phase-production-build" &&
      process.env.NEXT_PRIVATE_BUILD_WORKER !== "1" &&
      (process.env.DW_WEB_SERVICE_PROCESS === "1" || process.env.DW_TEST_DATA_DIR)) {
    const { startWatermarkBatchRunner } = await import("./lib/watermark-batch-runner");
    startWatermarkBatchRunner();
  }
}
