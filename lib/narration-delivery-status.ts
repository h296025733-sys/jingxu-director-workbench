/** Stable delivery state shared by persistence, employee DTOs and UI. */
export type NarrationDeliveryStatus = "delivered" | "partial" | "incomplete";
export function normalizeNarrationStatus(value: unknown): NarrationDeliveryStatus | undefined {
  if (value === "partial" || value === "incomplete") return value;
  if (["delivered", "repaired_continuous_delivery", "repaired_full_delivery"].includes(String(value))) return "delivered";
  return undefined;
}

export function narrationStatusFromResult(params: Record<string, unknown>, result: unknown): NarrationDeliveryStatus | undefined {
  if (params.editVoice !== "narration") return undefined;
  const r = result as {extra?: {editing?: {narrationStatus?:unknown; narrationNote?:unknown}}} | null;
  const editing = r?.extra?.editing;
  // Explicit incomplete/partial always wins over an optimistic legacy note.
  return normalizeNarrationStatus(editing?.narrationStatus)
    ?? (typeof editing?.narrationNote === "string" && editing.narrationNote.startsWith("已补充") ? "delivered" : "incomplete");
}
