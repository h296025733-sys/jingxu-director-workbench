/** Versioned, trusted presentation presets. Never put user copy in this catalog. */
import { safeEditGraphics } from "./edit-graphics";
import { EDIT_COLOR_STYLES, editColorStyle } from "./edit-colors";
export const EDIT_TEMPLATE_VERSION = 3;
const LEGACY_EDIT_TEMPLATES = [
  { id: "clear", name: "清透字幕", subtitle: "小字留白 · 轻淡入", captionStyle: "clean", accent: "#DDE5ED", captionPreset: "default", titlePreset: "default", labelPreset: "micro", captionSize: 48, titleSize: 62, labelSize: 48, animations: ["none", "fade"], motionBudget: 0, shakeBudget: 0, reactions: false, transitions: false, guidance: "克制的小号规整字幕，少量短标题；只用淡入，不用弹跳、震动、贴纸和人工转场。镜头仍精剪，不降低内容理解深度。" },
  { id: "focus", name: "重点讲解", subtitle: "三级字号 · 重点轻放大", captionStyle: "punchy", accent: "#B8D8ED", captionPreset: "fine_caption", titlePreset: "fine_hook", labelPreset: "feature", captionSize: 54, titleSize: 86, labelSize: 66, animations: ["none", "fade", "tag", "pop"], motionBudget: 2, shakeBudget: 0, reactions: false, transitions: false, guidance: "规整正文、短大标题、中号事实标签。重点可轻放大，每30秒至多2个动态重点；不用震动、反应贴纸和人工转场，保留原生运镜。" },
  { id: "social", name: "活力社交", subtitle: "字形反差 · 弹性点缀", captionStyle: "punchy", accent: "#E7C5FA", captionPreset: "fine_caption", titlePreset: "hook", labelPreset: "fine_accent", captionSize: 58, titleSize: 92, labelSize: 76, animations: ["none", "fade", "pop", "bounce", "tag", "cta_hold"], motionBudget: 3, shakeBudget: 0, reactions: true, transitions: true, guidance: "粗体短钩子与衬线概念词形成反差。每30秒至多3个动态重点，允许有画面依据的少量反应贴纸；不要震动。只在连续性确有需要时短转场，普通字幕保持稳定。" },
  { id: "impact", name: "强节奏", subtitle: "醒目大字 · 重音冲击", captionStyle: "punchy", accent: "#FFD84D", captionPreset: "fine_caption", titlePreset: "fine_hook", labelPreset: "badge", captionSize: 62, titleSize: 104, labelSize: 76, animations: ["none", "fade", "pop", "punch", "tag", "slide_up", "cta_hold"], motionBudget: 4, shakeBudget: 1, reactions: true, transitions: true, guidance: "窄粗大标题、重点底色标签、稳定正文。每30秒至多4个动态重点，全片至多1次有真实重音依据的短震动。强度来自语义与节拍，不能每句蹦字或每刀转场，不删关键动作换速度。" },
] as const;
const V2_EDIT_TEMPLATES = [
  { ...LEGACY_EDIT_TEMPLATES[0], name: "杂志叙事", subtitle: "衬线题眼 · 细线章节 · 留白构图", captionStyle: "punchy", captionPreset: "fine_caption", titlePreset: "fine_accent", labelPreset: "fine_micro", captionSize: 52, titleSize: 94, labelSize: 58, accent: "#E4CEAD", motionBudget: 3, animations: ["none", "fade", "tag"], guidance: "编辑式杂志叙事：稳定正文，短衬线题眼，细线章节卡，产品本身做主角；可用有依据的画中画/箭头，但不加表情贴纸。不是低配档；完整判断镜头、语音和调色。" },
  { ...LEGACY_EDIT_TEMPLATES[1], name: "产品聚焦", subtitle: "事实图卡 · 指向标记 · 细节画中画", titleSize: 98, labelSize: 68, motionBudget: 5, reactions: true, guidance: "信息设计式产品聚焦：稳定正文、短事实卡、步骤关系，关键产品细节通过真实辅助素材/PIP呈现；可在已确认留白放→/↓引导，不能假造放大细节或圈住错误对象。不使用卡通表情。选点服务于当前实物动作和可见证明，不每句贴卡。" },
  { ...LEGACY_EDIT_TEMPLATES[2], name: "趣味社交", subtitle: "立体表情 · 对话贴纸 · 弹性反应", titleSize: 102, labelSize: 82, motionBudget: 6, guidance: "轻松社交语域：对话贴纸底板、短反应字与真实3D Emoji，表情/反差/揭示成立时可选😳/🙈/✨，原有向下CTA可选👇。优先表达看得见的反应，不要求每片有脸或强加表情。普通语句稳定，真实反应点短弹入，不能堆贴纸遮产品。" },
  { ...LEGACY_EDIT_TEMPLATES[3], name: "动态大字", subtitle: "重音分层 · 冲击字卡 · 短促回弹", titleSize: 116, labelSize: 82, motionBudget: 7, guidance: "字形驱动的动态大字：短窄粗标题、重点底板与较小正文形成明确尺度；强语义加真实重音时单词脉冲/全片一次短震动，普通字幕不跳字。揭示/章节可用一个字卡入场，关键物理动作和声音留白，不套固定快切/闪屏。" },
] as const;
// Preserve v1/v2 retry appearance. V3 is calibrated against actual 1080p renders,
// not a nominal point size on a black preview or a desktop-sized contact sheet.
export const EDIT_TEMPLATES = V2_EDIT_TEMPLATES.map((item) => ({
  ...item,
  captionSize: item.id === "clear" ? 84 : item.id === "impact" ? 100 : 94,
  titleSize: item.id === "clear" ? 142 : item.id === "impact" ? 178 : 162,
  labelSize: item.id === "clear" ? 100 : 122,
}));
export type EditTemplateId = typeof LEGACY_EDIT_TEMPLATES[number]["id"];
export type EditTemplate = typeof EDIT_TEMPLATES[number] | typeof LEGACY_EDIT_TEMPLATES[number];
export const DEFAULT_EDIT_TEMPLATE: EditTemplateId = "focus";

export function getEditTemplate(id: unknown, version: unknown = EDIT_TEMPLATE_VERSION): EditTemplate | null {
  return (Number(version) === 1 ? LEGACY_EDIT_TEMPLATES : Number(version) === 2 ? V2_EDIT_TEMPLATES : EDIT_TEMPLATES).find((item) => item.id === id) ?? null;
}

export function editTemplateValidationError(params: Record<string, unknown>): string | null {
  if (params.editColorStyle != null && !EDIT_COLOR_STYLES.some(item=>item.id===params.editColorStyle)) return "字幕配色无效，请重新选择";
  // Missing id is deliberate legacy compatibility; never change an old retry's style.
  if (params.editTemplateId != null && params.editTemplateId !== "" && !getEditTemplate(params.editTemplateId)) {
    return "剪辑模板已更新，请重新选择模板";
  }
  if (params.editTemplateVersion != null && ![1, 2, 3].includes(Number(params.editTemplateVersion))) {
    return "剪辑模板版本已更新，请重新打开创作窗口";
  }
    if (params.editNarrationBrief != null && (typeof params.editNarrationBrief !== "string" || params.editNarrationBrief.length > 4000)) {
      return "口播参考文案最多4000字，请保留你最想讲的重点";
    }
    if (params.editVoice != null && !["original", "narration"].includes(String(params.editVoice))) {
    return "配音选项无效，请选择保留原声或添加画外解说";
  }
  if (params.editVoice === "narration" && (params.editAudio === "mute" || params.transcribe === false)) {
    return "添加解说需要识别原声并保留现场声音";
  }
  if (params.voiceReferenceVideoId && params.editVoice !== "narration") return "使用自带音源前，请开启画外解说";
  if (params.editNarrationDepth != null && !["auto", "brief", "full"].includes(String(params.editNarrationDepth))) return "解说详略无效，请重新选择";
  if ((params.editNarrator != null && !["male", "female"].includes(String(params.editNarrator))) ||
      (params.editVoiceProfile != null && !isPreviewVoice(params.editVoiceProfile)) ||
      (params.editEmotion != null && !["neutral", "excited", "emphatic"].includes(String(params.editEmotion)))) {
    return "音色或情绪选项无效，请重新选择";
  }
  return null;
}

export function editTemplatePrompt(id: unknown, version: unknown = 1): string {
  const item = getEditTemplate(id, version);
  return item ? `员工已选择视觉包装「${item.name}」v${version}：${item.guidance} 正文/${item.captionPreset}，短标题/${item.titlePreset}，短概念标签/${item.labelPreset}；统一强调色${item.accent}。先锁定内容、源时段、动作因果和音轨，再设计信息图层。每款使用相同的分析、ASR、剪点、原声保护和调色判断，不能把模板强度理解为精剪能力等级。不要复制演示文案、黑幕或时间轴。fine_reaction的😳/🙈/✨/👇在v2中由本地许可PNG渲染；→/↓是引导图形，其他标点为非语言反应。图片必须选点避让主体，无条件贴纸不是精剪。` : "";
}

export const PREVIEW_VOICES = [
  { id: "female-1", label: "女声1", gender: "female" },
  { id: "female-2", label: "女声2", gender: "female" },
  { id: "female-3", label: "女声3", gender: "female" },
  { id: "female-4", label: "女声4", gender: "female" },
  { id: "male-1", label: "男声1", gender: "male" },
  { id: "male-2", label: "男声2", gender: "male" },
  { id: "male-3", label: "男声3", gender: "male" },
] as const;
export const PREVIEW_EMOTIONS = [{ id: "neutral", label: "平淡" }, { id: "excited", label: "激动" }, { id: "emphatic", label: "激昂" }] as const;
export type PreviewVoice = typeof PREVIEW_VOICES[number]["id"];
export type PreviewVoiceGender = typeof PREVIEW_VOICES[number]["gender"];
export type PreviewEmotion = typeof PREVIEW_EMOTIONS[number]["id"];
export const DEFAULT_PREVIEW_VOICE: PreviewVoice = "female-1";

export function isPreviewVoice(value: unknown): value is PreviewVoice {
  return PREVIEW_VOICES.some((voice) => voice.id === value);
}

export function normalizePreviewVoice(value: unknown, legacyGender: unknown = "female"): PreviewVoice {
  if (isPreviewVoice(value)) return value;
  return legacyGender === "male" ? "male-1" : DEFAULT_PREVIEW_VOICE;
}

export function previewVoiceGender(value: unknown): PreviewVoiceGender {
  return PREVIEW_VOICES.find((voice) => voice.id === normalizePreviewVoice(value))!.gender;
}

export function editPreviewUrl(template: EditTemplateId, language: "en" | "es", voice: PreviewVoice, emotion: PreviewEmotion): string {
  return `/api/edit-previews/${template}-${language}-${previewVoiceGender(voice)}-${emotion}.mp4?v=${EDIT_TEMPLATE_VERSION}`;
}

export function voiceAuditionUrl(voice: PreviewVoice): string {
  return `/api/edit-previews/voice-${voice}.wav`;
}

/** Versioned private references used by both short auditions and production narration. */
export const VOICE_TEMPLATE_SLOTS = PREVIEW_VOICES.map((voice) => ({
  id: voice.id, version: 1, status: "audition_ready" as const, engine: "cosyvoice3" as const, languages: ["en", "es"] as const,
  emotions: PREVIEW_EMOTIONS.map((emotion) => emotion.id), productionEnabled: true as const,
}));

type PlanRecord = Record<string, unknown>;
function record(value: unknown): PlanRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as PlanRecord : null;
}

/** Pure, idempotent presentation pass. Does not alter words, timing, clips, PIP or source audio. */
export function applyEditTemplate<T>(plan: T, id: unknown, version: unknown = 1, colorStyle: unknown = "original"): T {
  const template = getEditTemplate(id, version);
  if (!template || !record(plan)) return plan;
  const result = structuredClone(plan) as PlanRecord;
  const output = record(result.output);
  const height = Number(output?.height ?? 1920);
  const width = Number(output?.width ?? 1080);
  const scale = Math.max(0.25, Math.min(height / 1920, width / 1080));
  let shakes = 0;
  const budgetWindows = new Map<number, number>();
  const motionAllowed = (at: number) => {
    const window = Math.floor(Math.max(0, at) / 30);
    const used = budgetWindows.get(window) ?? 0;
    if (used >= template.motionBudget) return false;
    budgetWindows.set(window, used + 1);
    return true;
  };
  result.overlays = (Array.isArray(result.overlays) ? result.overlays : []).flatMap((value) => {
    const item = record(value);
    if (!item) return [value];
    if (item.preset === "fine_reaction") return template.reactions && (Number(version) === 1 || id !== "focus" || ["→", "↓", "✓", "!", "?"].includes(String(item.text))) ? [item] : [];
    const caption = item.kind === "caption";
    const step = String(item.preset).startsWith("fine_step_");
    if (!step) {
      const authoredPreset = String(item.preset ?? "");
      // V3 keeps the planner's *semantic* text hierarchy. Flattening every
      // label into one template preset turned evidence-led micro notes, facts
      // and CTA accents into the same-size caption-like cards.
      const semanticV3Preset = Number(version) >= 3 && !caption
        ? item.kind === "title"
          ? (["fine_accent", "fine_cta", "cta"].includes(authoredPreset) ? authoredPreset : null)
          : (["fine_micro", "micro", "fine_accent", "fine_cta", "cta"].includes(authoredPreset) ? authoredPreset : null)
        : null;
      item.preset = caption ? template.captionPreset : semanticV3Preset ?? (item.kind === "title" ? template.titlePreset : template.labelPreset);
      // A template must not turn a valid 4–6 word fact card into a 1–3 word
      // art-accent preset. That used to abort review before Codex even ran.
      if (Number(version) >= 2 && item.preset === "fine_accent" && String(item.text ?? "").trim().split(/\s+/u).filter(Boolean).length > 3) {
        item.preset = item.kind === "title" ? "fine_hook" : "feature";
      }
      // Bound display size by both the template and source-aware planner's smaller choice.
      const semanticScale = Number(version) >= 3
        ? ["fine_micro", "micro"].includes(String(item.preset)) ? 0.66
          : item.preset === "fine_accent" && item.kind === "title" ? 0.78
            : 1
        : 1;
      const ceiling = (caption ? template.captionSize : item.kind === "title" ? template.titleSize : template.labelSize) * scale * semanticScale;
      item.font_size = Math.max(18, Math.round(Number(version) >= 3
        ? Math.max(ceiling * .82, Math.min(Number(item.font_size) || ceiling, ceiling))
        : Math.min(Number(item.font_size) || ceiling, ceiling)));
    }
    item.color = caption || item.kind === "title" ? "#FFFFFF" : template.labelPreset === "badge" ? "#101010" : template.accent;
    if (item.preset === "badge") item.background_color = template.accent;
    if (!(template.animations as readonly unknown[]).includes(item.animation)) item.animation = "fade";
    if (!["none", "fade"].includes(String(item.animation)) && !motionAllowed(Number(item.start))) item.animation = "fade";
    if (Array.isArray(item.highlights)) {
      item.highlights = item.highlights.map((entry) => {
        const word = record(entry);
        if (!word) return entry;
        word.color = template.accent;
        if (word.motion !== "none") {
          if (!motionAllowed(Number(word.start))) word.motion = "none";
          else if (word.motion === "shake") {
            if (shakes >= template.shakeBudget) word.motion = "pulse";
            else shakes += 1;
          }
        }
        return word;
      });
    }
    return [item];
  });
  // Transition overlaps change timing; never remove them here. The planner sees the restriction.
  if (Number(version) >= 2) {
    let at=0;
    const overlaps=new Map((Array.isArray(result.transitions)?result.transitions:[]).map(v=>{const t=record(v);return [Number(t?.after_clip),Number(t?.duration)];}));
    const ranges=(Array.isArray(result.clips)?result.clips:[]).map((v,i)=>{const c=record(v);const start=at;const duration=c?.kind==="image"?Number(c.duration):(Number(c?.end)-Number(c?.start))/Number(c?.speed??1);at+=duration-(overlaps.get(i)??0);return {start,end:start+duration};});
    const graphics=safeEditGraphics(result.graphic_annotations).filter(g=>ranges.some(r=>Number(g.start)>=r.start&&Number(g.end)<=r.end));
    result.presentation = { version: 2, style: template.id, accent: template.accent, graphics };
    if (editColorStyle(colorStyle) !== "original") {
      (result.presentation as PlanRecord).typography = {version:1, color:editColorStyle(colorStyle)};
    }
  }
  return result as T;
}
