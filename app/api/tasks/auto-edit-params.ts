import { editTemplateValidationError } from "@/lib/edit-templates";
const TRANSCRIPT_REQUIRED_EDIT_MODES = new Set([
  "talking_head",
  "digital_presenter",
]);

const EDIT_MODE_LABELS: Record<string, string> = {
  talking_head: "真人口播",
  digital_presenter: "克隆口播精剪",
};

function requiresTranscript(featureId: string, params: Record<string, unknown>): boolean {
  return (
    featureId === "auto_edit" &&
    TRANSCRIPT_REQUIRED_EDIT_MODES.has(String(params.editMode ?? ""))
  );
}

/**
 * New tasks must not enter the queue with a mode that cannot be planned from
 * the submitted evidence. The UI also enforces this, but the API remains the
 * authoritative boundary for stale clients and direct requests.
 */
export function autoEditTranscriptValidationError(
  featureId: string,
  params: Record<string, unknown>,
): string | null {
  if (featureId === "auto_edit") {
    const error = editTemplateValidationError(params);
    if (error) return error;
  }
  if (!requiresTranscript(featureId, params) || params.transcribe === true) {
    return null;
  }
  const modeLabel = EDIT_MODE_LABELS[String(params.editMode)] ?? "当前口播剪辑类型";
  return `「${modeLabel}」必须开启「识别说话内容」，请开启后再提交`;
}

/**
 * Historical tasks may predate the transcript requirement. Retrying should
 * upgrade those records instead of creating a task that is guaranteed to fail.
 */
export function normalizeAutoEditTranscriptForRetry(
  featureId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!requiresTranscript(featureId, params) || params.transcribe === true) {
    return params;
  }
  return { ...params, transcribe: true };
}
