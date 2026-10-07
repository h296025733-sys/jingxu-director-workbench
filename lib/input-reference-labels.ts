export interface InputReferenceMention {
  type: "image" | "video";
  number: number;
  label: string;
}

export function inputImageLabel(number: number): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("Input image reference number must be a positive integer");
  }
  return `参考图片${number}`;
}

export function inputVideoLabel(number = 1): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("Input video reference number must be a positive integer");
  }
  return `参考视频${number}`;
}

export function bracketInputReference(label: string): string {
  return `【${label}】`;
}

/**
 * Labels are persisted with the task because removing an earlier image must not
 * silently change what a reference in the user's brief points to.
 */
export function parseInputImageLabels(
  value: unknown,
  expectedCount: number,
): string[] | null {
  if (expectedCount === 0) return [];
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
  const labels = parsed.map((item) => String(item).trim());
  if (
    labels.some((label) => !/^参考图片[1-9]\d*$/.test(label)) ||
    new Set(labels).size !== labels.length
  ) {
    return null;
  }
  return labels;
}

export function extractInputReferenceMentions(
  content: string,
): InputReferenceMention[] {
  const mentions: InputReferenceMention[] = [];
  const pattern = /参考\s*(图片|图|视频)\s*([1-9]\d*)/gu;
  for (const match of content.matchAll(pattern)) {
    const number = Number(match[2]);
    const type = match[1] === "视频" ? "video" : "image";
    mentions.push({
      type,
      number,
      label: type === "video" ? inputVideoLabel(number) : inputImageLabel(number),
    });
  }
  return mentions;
}
