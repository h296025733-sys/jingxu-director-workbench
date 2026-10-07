/** Independent, version-1 text color treatments; never recolor footage. */
export const EDIT_COLOR_STYLES = [
  {id:"original",name:"模板原色",detail:"沿用模板 · 重点单色",colors:["#FFFFFF","#DDE5ED"],animated:false},
  {id:"candy",name:"糖果多彩",detail:"整词撞色 · 明亮活泼",colors:["#FF99C8","#FFE680","#84EDD2","#8FCFFF"],animated:false},
  {id:"ice",name:"冰蓝渐变",detail:"蓝白字间渐变 · 静态",colors:["#70D6FF","#EEF8FF"],animated:false},
  {id:"aurora",name:"极光流动",detail:"青紫字间渐变 · 缓慢流动",colors:["#79F2DF","#CAA6FF"],animated:true},
  {id:"sunset",name:"暖金流动",detail:"金粉字间渐变 · 缓慢流动",colors:["#FFE48A","#FF9AB5"],animated:true},
] as const;
export type EditColorStyle = typeof EDIT_COLOR_STYLES[number]["id"];
export function editColorStyle(value:unknown):EditColorStyle {
  return EDIT_COLOR_STYLES.find(item=>item.id===value)?.id ?? "original";
}
export function colorPreviewUrl(template:string, color:EditColorStyle, language:"en"|"es") {
  return `/api/edit-previews/color1-${template}-${color}-${language}.mp4`;
}

export function editColorInstruction(value:unknown):string {
  const choice=EDIT_COLOR_STYLES.find(item=>item.id===value);
  if(!choice || choice.id==="original")return "";
  return `员工明确选择字幕配色「${choice.name}」：${choice.detail}。这是服务端自动应用的文字包装，优先于默认单色样式，不是新增语义高亮；不要据此捏造highlights、重音或动画理由，也不要把用户选择的多彩/字间流动本身当成质量错误。正文/标题仍保留原词、位置和层级；语义重音优先，已有重点动画时服务端禁用颜色流动。仍检查可读性和主体遮挡，不改变镜头/音轨/剧情以配合颜色。无需在JSON里自行添加ASS或presentation字段。`;
}
