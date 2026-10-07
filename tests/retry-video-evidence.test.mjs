import assert from "node:assert/strict";
import test from "node:test";
import { shouldReuseVideoEvidenceForRetry } from "../lib/video-evidence.ts";

test("retry evidence reuse only runs for tasks that actually have a reference video", () => {
  assert.equal(shouldReuseVideoEvidenceForRetry("", "{}"), false);
  assert.equal(
    shouldReuseVideoEvidenceForRetry(
      "legacy-video-id",
      JSON.stringify({ hasReferenceVideo: false }),
    ),
    false,
  );
  assert.equal(
    shouldReuseVideoEvidenceForRetry(
      "reference-video-id",
      JSON.stringify({ hasReferenceVideo: true }),
    ),
    true,
  );
  assert.equal(shouldReuseVideoEvidenceForRetry("legacy-video-id", "{}"), true);
});
