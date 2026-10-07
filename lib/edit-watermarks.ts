/** Shared by every template/mode. Coordinates and clocks belong to the source,
 * before fit/crop/motion/PIP. Never accept an executable filter from a model. */
export const EDIT_WATERMARK_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    inspected: { type: "boolean" },
    regions: { type: "array", maxItems: 12, items: {
      type: "object", additionalProperties: false,
      properties: {
        source: { type: "string" }, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 },
        x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
        width: { type: "number", minimum: 0, maximum: 1 }, height: { type: "number", minimum: 0, maximum: 1 },
        kind: { type: "string", enum: ["overlay_watermark", "embedded_brand", "caption", "uncertain"] },
        safe_to_remove: { type: "boolean" },
        evidence_times: { type: "array", minItems: 0, maxItems: 6, items: { type: "number", minimum: 0 } },
        evidence: { type: "string", maxLength: 500 },
      }, required: ["source", "start", "end", "x", "y", "width", "height", "kind", "safe_to_remove", "evidence_times", "evidence"],
    } },
  }, required: ["inspected", "regions"],
} as const;

export const EDIT_WATERMARK_INSTRUCTION = [
  "所有剪辑模式和模板共用自动去水印。逐一检查主视频和实际使用的辅助视频，填写watermark_cleanup。没有水印用inspected=true,regions=[]；没看清用inspected=false，不得当成没有。",
  "只把后加的平台、生成器、账号标记作为overlay_watermark；实拍产品Logo、包装文字、正常字幕、展示UI不是水印。source必须来自清单，坐标是自动旋转后原画面的归一化左上角及宽高，不包含接触表边框，start/end是原视频时钟。",
  "每次都扫描四角、四边和中央，不默认只找右下角，不以品牌名称或固定字样作为识别条件。水印可能是黑字、白字、任意彩色或半透明文字、圆形/不规则图标、图文组合；同片可以有多处不同标记。逐处用叠加关系、跨镜头固定的屏幕位置及实际可见内容判断；不能因形状不同、没有读清账号名或不在角落就当作不存在，也不能把所有文字/图案一律当作水印。",
  "先看全部接触表的出现/消失和位置变化，再用WATERMARK_DETAIL的完整画面核对细字、图标、阴影边缘；标签中的SOURCE_TIME是该图原视频秒数。务必检查最后两秒才出现的账号和结尾标记，不把全片套一个水印框。",
  "每个固定位置和连续出现时段独立记录，至少两个不同时间的实际画面覆盖区间首尾，evidence_times只填真实附图时刻。跳位前后是不同的固定区域，不等于连续移动：分别记录，不用巨大联合框。safe_to_remove判断该固定位置的空间修补安全；若只是精确切换帧在相邻采样之间，且间隔不超过2秒，可填写实际有标记的首尾采样时刻并允许安全小区域修补，本地会在前后最多2秒内逐帧核对并校准起止，不因这个小的时间不确定性一律拒绝。真正连续移动、空间位置不确定、缺少足够区间证据或遮住关键主体时才标不安全。",
  "safe_to_remove表示允许局部修补而非保证无痕：小范围固定水印，只要不覆盖脸部特征、关键手部动作、产品细节或字幕且周围有可用像素，可以为true；普通衣料、墙面、地面、景物有纹理或背景变化，本身不是一律拒绝修补的理由，细轮廓修补会保留文字间背景。遮挡重要内容或大面积不透明块才应保留。坐标紧包全部文字、彩色图标和阴影，禁止把旁边正常文字框进去。",
  "如果首帧到最后可解码帧一直在同一位置，应start=0,end=素材时长，evidence_times仍保留真实尾帧秒数；容器末尾不足0.75秒的无采样余量不是水印消失依据。只在明确看到出现/消失时分时段，不得漏掉片尾几帧。",
  "服务端会以多帧一致的文字/图标细轮廓蒙版逐帧局部修补，并检查字形残留；不将整个检测框抹掉、不裁画面。相邻平台图标、账号、生成器标记可以分别紧包成框，避免把大量无水印背景包括进来。固定且安全的较大检测框不等于大面积擦除；有主体风险仍须safe_to_remove=false并说明，不得因为有修补算法而虚称安全。",
  "横向很长但很细的账号行、纵向细条也要单独完整记录，不得因跨度长就漏掉或切成随意碎片；完整框的短边不超过画面4%、面积不超过4%时仍可交给细轮廓检查。不要把底部账号误当口播字幕，也不要把真实字幕当账号。连续存在的同一生成器字样不可仅因旁边的平台图标消失就切掉其时段。时间仍以实际附图为准；本地会在两秒校准被真实边界截断时，最多追加到前后八秒逐帧查证，不能据此猜测时间或允许移动目标。",
  "没有生成式纹理重建或任意运动追踪；遮住的真实细节不可保证恢复。不得删镜头、改动作、时长、速度或原声，不得用新字幕/贴纸盖水印。",
].join(" ");

type Source = {source: string; kind?: string; durationSeconds?: number};
type Region = Record<string, unknown> & {source: string; start: number; end: number; safe_to_remove: boolean};
export type WatermarkCleanup = {inspected: boolean; regions: Region[]; deferred: number; version?: number};
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Optional cleanup must not make a good edit fail. Reject only the unsafe edit,
 * retain an audit/warning, and never manufacture evidence to pass the gate. */
export function normalizeWatermarkCleanup(raw: unknown, sources: readonly Source[]): WatermarkCleanup {
  const value = record(raw);
  const regions: Region[] = [];
  let deferred = 0;
  let promotedEdgeCrops = 0;
  if (!Array.isArray(value.regions)) return {inspected: false, regions, deferred};
  for (const item of value.regions.slice(0, 12)) {
    const r = record(item);
    const source = sources.find(s => s.source === r.source && s.kind !== "image");
    if (!source || ![r.start,r.end,r.x,r.y,r.width,r.height].every(v => typeof v === "number" && Number.isFinite(v))) { deferred++; continue; }
    const [start,end,x,y,w,h] = [r.start,r.end,r.x,r.y,r.width,r.height] as number[];
    if (start < 0 || end <= start || end > (source.durationSeconds ?? end) + .05 || x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 1 || y+h > 1) { deferred++; continue; }
    if (r.kind === "embedded_brand" || r.kind === "caption") continue;
    const times = Array.isArray(r.evidence_times) ? [...new Set(r.evidence_times.filter(t => typeof t === "number" && Number.isFinite(t) && t >= start-.05 && t <= end+.05))] as number[] : [];
    // Supplied observations must span the proposed removal range, not two near-identical frames.
    const covered = times.length >= 2 && Math.min(...times) <= start + .75 && Math.max(...times) >= end - .75 && Math.max(...times)-Math.min(...times) >= Math.min(.5,(end-start)*.5);
    const hasEvidence = typeof r.evidence === "string" && r.evidence.trim().length >= 12;
    // V3 admits a larger *search* rectangle, never a larger rectangular erasure.
    // Its renderer must establish a small stable glyph mask before touching pixels.
    const v3 = value.version === 3;
    // A thin account line can span most of an edge without being a large wipe.
    // Native V3 still limits actual glyph pixels, temporal stability and fidelity.
    const compact = w <= (v3 ? .38 : .3) && h <= (v3 ? .20 : .12) && w*h <= (v3 ? .06 : .025);
    const thinStrip = v3 && Math.min(w,h) <= .04 && w*h <= .04;
    const boundedOverlay = value.inspected === true && r.kind === "overlay_watermark" && covered &&
      (compact || thinStrip) && hasEvidence;
    const interpolationSafe = boundedOverlay && r.safe_to_remove === true;
    const duration = source.durationSeconds;
    const fullSourceBottomEdge = boundedOverlay && typeof duration === "number" && start <= .75 && end >= duration-.75 && y >= .94 && y+h >= .985;
    const cropFraction = fullSourceBottomEdge ? Math.round((1-Math.max(0,y-.006))*10000)/10000 : 0;
    const edgeCropSafe = !v3 && fullSourceBottomEdge && cropFraction >= .01 && cropFraction <= .06;
    const safe = interpolationSafe || edgeCropSafe;
    if (edgeCropSafe && r.safe_to_remove !== true) promotedEdgeCrops++;
    if (!safe) deferred++;
    regions.push({source: source.source,start,end,x,y,width:w,height:h,kind: r.kind === "overlay_watermark" ? "overlay_watermark" : "uncertain",safe_to_remove:safe,method:edgeCropSafe ? "edge_crop" : "interpolate",...(edgeCropSafe ? {crop_fraction:cropFraction} : {}),evidence_times:times,evidence:typeof r.evidence === "string" ? r.evidence.slice(0,500) : ""});
  }
  deferred += Math.max(0, value.regions.length-12);
  const priorDeferred = typeof value.deferred === "number" && Number.isFinite(value.deferred) ? Math.min(100,value.deferred) : 0;
  return {inspected: value.inspected === true, regions, deferred: Math.max(deferred, priorDeferred-promotedEdgeCrops), ...([2,3].includes(Number(value.version)) ? {version: Number(value.version)} : {})};
}

/** Execution, not the proposed plan, determines the employee-facing outcome. */
export function watermarkExecutionNote(raw: unknown): string {
  const r = record(raw);
  const processed = Number(r.processed || 0), deferred = Number(r.deferred || 0);
  if (r.inspected !== true) return "去水印待完善：尚未完成可靠识别，原片已保留。";
  if (deferred > 0) return `去水印待完善：已处理${processed}处，另有${deferred}处未通过局部修补检查；原片已保留。`;
  if (processed > 0) return `已逐帧局部修补${processed}处水印，并抽查首中尾修补区域；原画面和原声保留，局部纹理可能略有平滑。`;
  return "未发现可确认的平台水印，已保留原片；这不代表已去除所有水印。";
}

export function watermarkResultNote(plan: unknown): string {
  const p = record(plan), c = record(p.watermark_cleanup);
  if (c.inspected !== true) return "未完成水印识别，成片仍可下载，请检查源片水印。";
  const regions = Array.isArray(c.regions) ? c.regions.map(record) : [];
  const cropped = regions.filter(r => r.safe_to_remove === true && r.method === "edge_crop").length;
  const repaired = regions.filter(r => r.safe_to_remove === true && r.method !== "edge_crop").length;
  const deferred = Number(c.deferred || 0);
  return [repaired ? `已局部修补${repaired}处水印，请播放核对修补区域。` : "", cropped ? `已通过轻微边缘裁切移除${cropped}处固定水印，请播放核对构图。` : "", deferred ? "部分水印因位置不确定或会损伤主体未处理，已保留可用成片。" : ""].filter(Boolean).join("");
}
