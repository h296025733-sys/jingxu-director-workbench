export interface DisplayPrompt {
  title: string;
  purpose: string;
  content: string;
}

const IMAGE_PROMPT_PATTERN =
  /(?:生图|图片生成|身份锚点|场景锚点|表情故事板|分镜图|参考图提示词|image\s*(?:generation|prompt)|storyboard\s*image)/i;
const VIDEO_PROMPT_PATTERN =
  /(?:seedance|视频|成片|导演提示词|直接粘贴|第\s*[一二三四五六七八九十\d]+\s*段|segment)/i;
const FINAL_PROMPT_PATTERN =
  /(?:直接粘贴|最终|final|ready\s*to\s*paste)/i;

function cleanPromptContent(content: string): string {
  return content
    .replace(
      /(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1|4\s*:\s*5|3\s*:\s*4)\s*[，,、]*/g,
      "",
    )
    .replace(/\b(?:480|720|1080|1440|2160)\s*[pP]\b\s*(?:的)?\s*[，,、]*/g, "")
    .replace(/(?:横屏|竖屏|方形)(?:画幅|视频)?/g, "")
    .replace(/[，,、]\s*[，,、]+/g, "，")
    .replace(/[，,、]\s*的/g, "的")
    .replace(/(^|[。；;\n])\s*[，,、]/g, "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function selectFinalSeedancePrompt(
  prompts: readonly DisplayPrompt[],
): DisplayPrompt | null {
  const nonImageCandidates = prompts
    .filter((prompt) => {
      const label = `${prompt.title} ${prompt.purpose}`;
      return !IMAGE_PROMPT_PATTERN.test(label) && prompt.content.trim();
    })
    .map((prompt) => ({
      ...prompt,
      content: cleanPromptContent(prompt.content),
    }))
    .filter((prompt) => prompt.content);
  const explicitlyVideoCandidates = nonImageCandidates.filter((prompt) =>
    VIDEO_PROMPT_PATTERN.test(`${prompt.title} ${prompt.purpose}`),
  );
  // Current director output contains one final video prompt, but its creative
  // title is intentionally free-form. A title such as “15秒海滩香水喜剧反转”
  // must not disappear merely because it omits the words “视频” or “Seedance”.
  const candidates =
    explicitlyVideoCandidates.length > 0
      ? explicitlyVideoCandidates
      : nonImageCandidates;

  return (
    candidates.find((prompt) =>
      FINAL_PROMPT_PATTERN.test(`${prompt.title} ${prompt.purpose}`),
    ) ??
    candidates.at(-1) ??
    null
  );
}
