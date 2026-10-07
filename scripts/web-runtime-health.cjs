// Loaded only by the web launcher. No request content or credentials are logged.
// Keep evidence of event-loop stalls, instead of guessing from gateway errors.
const { monitorEventLoopDelay } = require('node:perf_hooks');
const os = require('node:os');
if (process.env.DW_WEB_SERVICE_PROCESS === '1') {
  const histogram = monitorEventLoopDelay({ resolution: 100 });
  histogram.enable();
  setInterval(() => {
    const maxMs = Math.round(histogram.max / 1e6);
    if (maxMs >= 1000) {
      console.warn('[runtime-health]', JSON.stringify({
        at: new Date().toISOString(), pid: process.pid, eventLoopMaxMs: maxMs,
        rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
        freeMiB: Math.round(os.freemem() / 1024 ** 2),
      }));
    }
    histogram.reset();
  }, 15000).unref();
}
