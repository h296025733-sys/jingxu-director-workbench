import type { InputSchema } from "./base";

export function createDirectorInputSchema(options: {
  briefTitle: string;
  briefDescription: string;
  briefPlaceholder: string;
  referenceDelivery: "text_only" | "images_text" | "video_images_text";
  allowVideoReference?: boolean;
}): InputSchema {
  const referenceDeliveryOptions = [
    { label: "只要提示词", value: "text_only" },
    { label: "图片 + 提示词", value: "images_text" },
    ...(options.allowVideoReference === false
      ? []
      : [
          {
            label: "视频 + 图片 + 提示词",
            value: "video_images_text",
          },
        ]),
  ];
  return {
    type: "object",
    required: ["brief"],
    properties: {
      brief: {
        type: "text",
        title: options.briefTitle,
        description: options.briefDescription,
        placeholder: options.briefPlaceholder,
        required: true,
        uiLayout: "full",
      },
      referenceImages: {
        type: "file",
        title: "补充图片（可选）",
        description:
          "人物、产品、包装或场景图都可上传；自家产品请写“这是我的产品图”，随手拍也可以，系统会按需整理成干净参考图。",
        accept: "image/jpeg,image/png,image/webp",
        multiple: true,
        maxFiles: 9,
        uiLayout: "full",
      },
      inputReferenceLabels: {
        type: "text",
        title: "输入素材编号",
        default: "[]",
        uiLayout: "hidden",
      },
      duration: {
        type: "number",
        title: "成片时长（秒）",
        description: "4–60 秒；超过 15 秒时需分段生成。",
        default: 15,
        min: 4,
        max: 60,
        step: 1,
        uiLayout: "half",
      },
      continuity: {
        type: "select",
        title: "是否拼接",
        enum: [
          { label: "自动判断（推荐）", value: "auto" },
          { label: "一次生成，不拼接", value: "single" },
          { label: "分段生成后拼接", value: "stitch" },
        ],
        default: "auto",
        uiLayout: "half",
      },
      referenceDelivery: {
        type: "select",
        title: "给 Seedance 的参考方式",
        enum: referenceDeliveryOptions,
        default: options.referenceDelivery,
        uiLayout: "full",
      },
      sound: {
        type: "select",
        title: "声音",
        enum: [
          { label: "生成配音、环境音和音效", value: "generate" },
          {
            label: "沿用参考节奏与声音",
            value: "reference_rhythm",
          },
          { label: "无声视频", value: "mute" },
        ],
        default: "generate",
        uiLayout: "half",
      },
      platform: {
        type: "select",
        title: "目标平台",
        enum: [{ label: "通用短视频", value: "general" }],
        default: "general",
        uiLayout: "hidden",
      },
      generationModel: {
        type: "select",
        title: "视频生成模型",
        enum: [{ label: "Seedance 2.0", value: "seedance-2.0" }],
        default: "seedance-2.0",
        uiLayout: "hidden",
      },
      generationCount: {
        type: "number",
        title: "生成数量",
        default: 1,
        min: 1,
        max: 1,
        uiLayout: "hidden",
      },
    },
  };
}

export function createOmniDirectorInputSchema(): InputSchema {
  return {
    type: "object",
    required: ["brief"],
    properties: {
      brief: {
        type: "text",
        title: "你想做成什么样？",
        placeholder:
          "直接说人话就好：想卖什么、换成谁、保留原片哪些地方，或者哪里生成失败了……",
        required: true,
        uiLayout: "full",
      },
      referenceImages: {
        type: "file",
        title: "补充图片（可选）",
        description: "人物、产品、包装、场景或风格图都可以。",
        accept: "image/jpeg,image/png,image/webp",
        multiple: true,
        maxFiles: 9,
        uiLayout: "full",
      },
      inputReferenceLabels: {
        type: "text",
        title: "输入素材编号",
        default: "[]",
        uiLayout: "hidden",
      },
      duration: {
        type: "number",
        title: "时长（秒）",
        default: 15,
        min: 4,
        max: 60,
        step: 1,
        uiLayout: "half",
      },
      continuity: {
        type: "select",
        title: "生成方式",
        enum: [
          { label: "自动判断", value: "auto" },
          { label: "一次生成", value: "single" },
          { label: "分段续接", value: "stitch" },
        ],
        default: "auto",
        uiLayout: "half",
      },
      referenceDelivery: {
        type: "select",
        title: "你要拿走什么",
        enum: [
          { label: "只要提示词", value: "text_only" },
          { label: "图片 + 提示词", value: "images_text" },
          {
            label: "图片 + 参考视频 + 提示词",
            value: "video_images_text",
          },
        ],
        default: "images_text",
        uiLayout: "full",
      },
      faceReferencePolicy: {
        type: "select",
        title: "交付素材能否露脸",
        enum: [
          { label: "可以露脸", value: "faces_allowed" },
          { label: "不能露脸", value: "no_faces" },
        ],
        default: "faces_allowed",
        uiLayout: "half",
      },
      targetModel: {
        type: "select",
        title: "准备用在哪",
        enum: [
          { label: "Seedance（推荐）", value: "seedance" },
          { label: "自动适配", value: "auto" },
          { label: "可灵", value: "kling" },
          { label: "Veo", value: "veo" },
          { label: "其他模型", value: "other" },
        ],
        default: "seedance",
        uiLayout: "half",
      },
      sound: {
        type: "select",
        title: "声音",
        enum: [
          { label: "生成声音", value: "generate" },
          { label: "参考原片节奏", value: "reference_rhythm" },
          { label: "无声", value: "mute" },
        ],
        default: "generate",
        uiLayout: "half",
      },
      platform: {
        type: "select",
        title: "发布平台",
        enum: [{ label: "通用短视频", value: "general" }],
        default: "general",
        uiLayout: "hidden",
      },
      generationModel: {
        type: "select",
        title: "视频模型",
        enum: [{ label: "Seedance 2.0", value: "seedance-2.0" }],
        default: "seedance-2.0",
        uiLayout: "hidden",
      },
      generationCount: {
        type: "number",
        title: "生成数量",
        default: 1,
        min: 1,
        max: 1,
        uiLayout: "hidden",
      },
    },
  };
}
