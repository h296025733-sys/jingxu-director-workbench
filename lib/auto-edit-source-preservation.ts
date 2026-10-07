type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}

/** `keep` means keep the main recording, not only words recognized by ASR.
 * A still-image planner cannot establish that a speech gap contains no useful
 * sound. Never replace that gap (clicks, release sounds, room tone) with silence.
 * Use the input manifest, not the first timeline clip, to identify the mainline.
 */
export function preserveMainSourceAudio<T>(
  value: T,
  sources: readonly { source: string; kind: string }[],
  editAudio: "keep" | "mute",
): T {
  const plan = record(value);
  const main = sources.find((source) => source.kind === "video")?.source;
  if (!plan || !main || editAudio !== "keep" || !Array.isArray(plan.clips)) return value;
  const normalizedMain = main.replaceAll("\\", "/");
  let changed = false;
  const clips = plan.clips.map((value) => {
    const clip = record(value);
    if (!clip || clip.kind !== "video" ||
      String(clip.source).replaceAll("\\", "/") !== normalizedMain) return value;
    const gain = Number(clip.audio_gain_db ?? 0);
    const effectivelySilent = Number.isFinite(gain) && gain < -40;
    if (clip.mute !== true && !effectivelySilent) return value;
    changed = true;
    return { ...clip, mute: false, ...(effectivelySilent ? { audio_gain_db: 0 } : {}) };
  });
  return changed ? { ...plan, clips } as T : value;
}

/** Source-time accounting, not a semantic judgement or an audio listening test. */
export function summarizeEditSourceCoverage(
  value: unknown,
  sources: readonly { source: string; kind: string; durationSeconds?: number }[],
) {
  const plan = record(value);
  const clips = Array.isArray(plan?.clips) ? plan.clips : [];
  return sources.filter((source) => source.kind === "video").map((source) => {
    const duration = source.durationSeconds ?? 0;
    const ranges = clips.flatMap((value) => {
      const clip = record(value);
      if (!clip || clip.kind !== "video" || String(clip.source).replaceAll("\\", "/") !==
        source.source.replaceAll("\\", "/")) return [];
      const start = Number(clip.start);
      const end = Number(clip.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];
      return [{ start, end, speed: Number(clip.speed ?? 1), muted: clip.mute === true }];
    }).sort((a, b) => a.start - b.start);
    const omitted: Array<{ start: number; end: number }> = [];
    let coveredTo = 0;
    for (const range of ranges) {
      if (range.start > coveredTo + 0.04) omitted.push({ start: coveredTo, end: range.start });
      coveredTo = Math.max(coveredTo, range.end);
    }
    if (duration > coveredTo + 0.04) omitted.push({ start: coveredTo, end: duration });
    return { source: source.source, sourceSeconds: duration, retainedSourceRanges: ranges,
      omittedSourceRanges: omitted, semanticValueOfOmissions: "not_measured" };
  });
}
