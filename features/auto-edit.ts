import type { FeatureDefinition } from "./base";
import { runAutoEditFeature } from "@/lib/auto-edit";
import { AUTO_EDIT_DEFAULT_BRIEF } from "@/lib/auto-edit-defaults";
import { DEFAULT_PREVIEW_VOICE, EDIT_TEMPLATES, EDIT_TEMPLATE_VERSION, PREVIEW_VOICES } from "@/lib/edit-templates";
import { EDIT_COLOR_STYLES } from "@/lib/edit-colors";

export const autoEditFeature: FeatureDefinition = {
  id: "auto_edit",
  name: "自动剪片",
  description: "放入视频，自动完成内容驱动的精剪。",
  icon: "✂",
  status: "ready",
  inputSchema: {
    type: "object",
    required: ["brief"],
    properties: {
      editColorStyle: {type:"select",title:"字幕配色",default:"original",uiLayout:"hidden",enum:EDIT_COLOR_STYLES.map(item=>({label:item.name,value:item.id}))},
      editTemplateId: {
        type: "select", title: "字幕与特效模板", default: "", uiLayout: "hidden",
        enum: [{ label: "沿用原设置", value: "" }, ...EDIT_TEMPLATES.map((item) => ({ label: item.name, value: item.id }))],
      },
      editTemplateVersion: { type: "number", title: "模板版本", default: EDIT_TEMPLATE_VERSION, uiLayout: "hidden" },
      editVoice: { type: "select", title: "成片声音", default: "original", uiLayout: "hidden", enum: [{ label: "保留原声", value: "original" },{label:"添加画外解说",value:"narration"}] },
      editNarrationDepth: {type:"select",title:"解说详略",default:"auto",uiLayout:"hidden",enum:[{label:"自动判断",value:"auto"},{label:"简短点睛",value:"brief"},{label:"完整讲解",value:"full"}]},
      editNarrator: { type:"select",title:"解说音色",default:"female",uiLayout:"hidden",enum:[{label:"女声",value:"female"},{label:"男声",value:"male"}] },
      editVoiceProfile: { type:"select",title:"内置解说音色",default:DEFAULT_PREVIEW_VOICE,uiLayout:"hidden",enum:PREVIEW_VOICES.map((voice)=>({label:voice.label,value:voice.id})) },
      // Keep the historical key so existing tasks and retries remain valid;
      // the referenced record may now be either video or standalone audio.
      voiceReferenceVideoId: { type:"string",title:"克隆音源文件",default:"",uiLayout:"hidden" },
      editNarrationBrief: {type:"text",title:"口播参考文案",default:"",uiLayout:"hidden"},
      editEmotion: { type:"select",title:"解说情绪",default:"neutral",uiLayout:"hidden",enum:[{label:"自然",value:"neutral"},{label:"活力",value:"excited"},{label:"有力",value:"emphatic"}] },
      editMode: {
        type: "select",
        title: "剪辑类型",
        enum: [
          { label: "智能精剪", value: "smart" },
          { label: "真人口播", value: "talking_head" },
          { label: "克隆口播精剪", value: "digital_presenter" },
          { label: "产品展示", value: "product_demo" },
        ],
        default: "smart",
        uiLayout: "hidden",
      },
      brief: {
        type: "text",
        title: "自动精剪要求",
        default: AUTO_EDIT_DEFAULT_BRIEF,
        required: true,
        uiLayout: "hidden",
      },
      referenceImages: {
        type: "file",
        title: "补充图片（可选）",
        description: "产品图、Logo 或需要插入的视频配图。",
        accept: "image/jpeg,image/png,image/webp",
        multiple: true,
        maxFiles: 9,
        uiLayout: "hidden",
      },
      secondaryVideoId: {
        type: "string",
        title: "第二段视频",
        default: "",
        uiLayout: "hidden",
      },
      inputReferenceLabels: {
        type: "text",
        title: "输入素材编号",
        default: "[]",
        uiLayout: "hidden",
      },
      subtitleLanguage: {
        type: "select",
        title: "字幕语言",
        enum: [
          { label: "English", value: "en" },
          { label: "Español", value: "es" },
        ],
        default: "en",
        uiLayout: "full",
      },
      editTargetDuration: {
        type: "number",
        title: "目标时长",
        description: "填 0 自动判断。",
        default: 0,
        min: 0,
        max: 600,
        step: 1,
        uiLayout: "hidden",
      },
      editAspect: {
        type: "select",
        title: "画面方向",
        enum: [
          { label: "自动判断", value: "auto" },
          { label: "竖屏", value: "vertical" },
          { label: "横屏", value: "horizontal" },
          { label: "跟随原片", value: "source" },
        ],
        default: "auto",
        uiLayout: "hidden",
      },
      editCaptions: {
        type: "select",
        title: "字幕",
        enum: [
          { label: "自动判断", value: "auto" },
          { label: "不要字幕", value: "off" },
        ],
        default: "auto",
        uiLayout: "hidden",
      },
      captionStyle: {
        type: "select",
        title: "字幕样式",
        enum: [
          { label: "规整易读", value: "clean" },
          { label: "重点大字", value: "punchy" },
        ],
        default: "punchy",
        uiLayout: "hidden",
      },
      editAudio: {
        type: "select",
        title: "原声",
        enum: [
          { label: "保留", value: "keep" },
          { label: "静音", value: "mute" },
        ],
        default: "keep",
        uiLayout: "hidden",
      },
      transcribe: {
        type: "boolean",
        title: "识别说话内容",
        description: "需要按语义删停顿或自动字幕时保持开启。",
        default: true,
        uiLayout: "hidden",
      },
    },
  },
  run: runAutoEditFeature,
};
