const MATERIAL_REFERENCE_PATTERN = /@(图片|视频|音频)\d+/gu;
const TIME_RANGE_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:[–—~-]|至|到|to)\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?\b)/giu;

function collectReferences(content: string): string[] {
  return [...content.matchAll(MATERIAL_REFERENCE_PATTERN)].map((match) => match[0]);
}

function collectTimeRanges(content: string): string[] {
  return [...content.matchAll(TIME_RANGE_PATTERN)].map((match) => {
    const start = Number(match[1]);
    const end = Number(match[2]);
    return `${start.toFixed(3)}-${end.toFixed(3)}`;
  });
}

function collectNumbers(content: string): string[] {
  return [...content.matchAll(/\d+(?:\.\d+)?/gu)].map((match) =>
    String(Number(match[0])),
  );
}

function collectProtectedEnglishQuotes(content: string): string[] {
  return [...content.matchAll(/[“"]([^”"]+)[”"]/gu)]
    .map((match) => match[1].trim())
    .filter((value) => /[A-Za-z]/u.test(value));
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Validate only invariants that a translation must never reinterpret. */
export function inspectPromptTranslation(
  source: string,
  translated: string,
): string[] {
  const issues: string[] = [];
  const cleanSource = source.trim();
  const cleanTranslation = translated.trim();
  if (!cleanTranslation) return ["英文提示词为空"];
  if (cleanTranslation === cleanSource) issues.push("提示词没有翻译成英文");
  if (!sameSequence(collectReferences(cleanSource), collectReferences(cleanTranslation))) {
    issues.push("@图片、@视频或@音频编号与中文原文不一致");
  }
  if (!sameSequence(collectTimeRanges(cleanSource), collectTimeRanges(cleanTranslation))) {
    issues.push("时间段与中文原文不一致");
  }
  if (!sameSequence(collectNumbers(cleanSource), collectNumbers(cleanTranslation))) {
    issues.push("数字、型号或参数与中文原文不一致");
  }
  const protectedQuotes = collectProtectedEnglishQuotes(cleanSource);
  if (protectedQuotes.some((value) => !cleanTranslation.includes(value))) {
    issues.push("原文中已经确定的英文台词或文字被改动");
  }
  const sourceLength = Array.from(cleanSource).length;
  const translatedLength = Array.from(cleanTranslation).length;
  if (
    sourceLength > 0 &&
    (translatedLength < Math.max(80, sourceLength * 0.35) ||
      translatedLength > sourceLength * 5)
  ) {
    issues.push("英文提示词长度异常，可能遗漏或添加了内容");
  }
  if (
    /(?:人工确认|网页|后台|工作台|内部流程|待确认|请员工|点击|上传后再|系统将)/u.test(
      cleanTranslation,
    )
  ) {
    issues.push("英文提示词混入了内部流程说明");
  }
  return issues;
}
