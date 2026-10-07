import { DEFAULT_EDIT_TEMPLATE, DEFAULT_PREVIEW_VOICE, EDIT_TEMPLATE_VERSION } from "./edit-templates";

const AUTO_EDIT_PREVIOUS_DEFAULT_BRIEFS = [
  "自动精剪：以视频1为主线，保留原意、人物与产品身份以及完整动作；删除明确停顿、口误、重复、无信息黑场和无效等待。根据真实画面与转录自动判断叙事类型，先用最强的可见或可听信息形成开场钩子，再推进主体并自然收尾。字幕逐字忠于原声，只在钩子、关键数字、痛点、证明或行动点做少量内容驱动强调。若有视频2，仅在与当前语句或动作直接相关时短切或静音画中画；画中画存在安全留白且确能引导注意时可加醒目箭头，不遮脸、嘴、产品、手部或字幕。不得创造素材中不存在的产品效果、卖点、台词、音乐、音效或动作。",
] as const;

const AUTO_EDIT_PREVIOUS_HIERARCHY_BRIEF =
  "自动精剪：以视频1为主线，保留原意、人物与产品身份以及完整动作；删除明确停顿、口误、重复、无信息黑场和无效等待。根据真实画面与转录自动判断叙事类型，先用最强的可见或可听信息形成开场钩子，再推进主体并自然收尾。字幕逐字忠于原声；有足够内容时形成大号钩子、中号数字/痛点/证明/结果强调和规整口播字幕的清楚层级，轻量颜文字或符号只落在确有作用且有留白的节点，不机械套模板。若有视频2，仅在与当前语句或动作直接相关时短切或静音画中画；画中画存在安全留白且确能引导注意时可加醒目箭头，不遮脸、嘴、产品、手部或字幕。不得创造素材中不存在的产品效果、卖点、台词、音乐、音效或动作。";

export const AUTO_EDIT_DEFAULT_BRIEF = AUTO_EDIT_PREVIOUS_HIERARCHY_BRIEF +
  "先检查并保留原片有价值的开场运镜及其落点、独特产品状态和完整因果动作。需要提速时先局部微加速非口播的移动与展示，再删除确实无信息的等待；自动时长不设固定缩短比例。保留主视频原声，包括无口播处的磁吸拆装、咔哒、摩擦等动作声；关键接触和分离瞬间保持自然速度，不用静音、闪屏或转场盖掉。原生运镜和动作本身已形成节奏时不强加特效。字幕用统一配色和有依据的字号层级，画面精彩处留白。";

export function isAutoEditDefaultBrief(value: string): boolean {
  const normalized = value.trim();
  return normalized === AUTO_EDIT_DEFAULT_BRIEF || normalized === AUTO_EDIT_PREVIOUS_HIERARCHY_BRIEF ||
    AUTO_EDIT_PREVIOUS_DEFAULT_BRIEFS.some((brief) => brief === normalized);
}

export const AUTO_EDIT_DEFAULT_PARAMS = {
  editTemplateId: DEFAULT_EDIT_TEMPLATE,
  editTemplateVersion: EDIT_TEMPLATE_VERSION,
  editVoice: "original",
  editNarrator: "female",
  editVoiceProfile: DEFAULT_PREVIEW_VOICE,
  editEmotion: "neutral",
  brief: AUTO_EDIT_DEFAULT_BRIEF,
  editMode: "smart",
  editTargetDuration: 0,
  editAspect: "auto",
  editCaptions: "auto",
  captionStyle: "punchy",
  editAudio: "keep",
  transcribe: true,
  subtitleLanguage: "en",
} as const;
