"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { NarrationDepth } from "@/lib/edit-narration";
import { EDIT_COLOR_STYLES, editColorStyle, colorPreviewUrl, type EditColorStyle } from "@/lib/edit-colors";
import {
  DEFAULT_EDIT_TEMPLATE, EDIT_TEMPLATES, EDIT_TEMPLATE_VERSION, PREVIEW_EMOTIONS, PREVIEW_VOICES,
  editPreviewUrl, getEditTemplate, voiceAuditionUrl, type EditTemplateId, type PreviewEmotion, type PreviewVoice,
} from "@/lib/edit-templates";

export function EditTemplatePicker({ templateId, language, disabled, onTemplate, onLanguage, narration, narrator:voice, emotion, onNarration, onNarrator:setVoice, onEmotion:setEmotion, depth, onDepth, colorStyle, onColorStyle, narrationBrief, onNarrationBrief, usingUploadedVoice=false }: {
  narrationBrief:string; onNarrationBrief:(value:string)=>void;
  colorStyle:string; onColorStyle:(value:EditColorStyle)=>void;
  templateId: string; language: "en" | "es"; disabled: boolean;
  onTemplate: (id: EditTemplateId) => void; onLanguage: (language: "en" | "es") => void;
  narration:boolean; narrator:PreviewVoice; emotion:PreviewEmotion;
  usingUploadedVoice?:boolean;
  onNarration:(enabled:boolean)=>void; onNarrator:(voice:PreviewVoice)=>void; onEmotion:(emotion:PreviewEmotion)=>void;
  depth:NarrationDepth; onDepth:(depth:NarrationDepth)=>void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const template = getEditTemplate(templateId) ?? getEditTemplate(DEFAULT_EDIT_TEMPLATE)!;
  const url = editPreviewUrl(template.id, language, voice, emotion);
  const auditionUrl = voiceAuditionUrl(voice);
  const selectedColor = editColorStyle(colorStyle);
  const colorUrl = colorPreviewUrl(template.id,selectedColor,language);
  const pill = "cursor-pointer rounded-lg border border-zinc-200 px-3 py-2 text-center text-xs text-zinc-600 transition-colors hover:border-zinc-400 peer-checked:border-zinc-900 peer-checked:bg-zinc-900 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2";
  return (
    <div className="mt-5 border-t border-zinc-200 pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-950">选一个剪辑模板</h3>
        <span className="text-[11px] text-zinc-500">同一套精剪 · 不同视觉表达</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(140px,0.7fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="relative mx-auto max-w-[230px] overflow-hidden rounded-xl bg-black">
            <video key={`${url}-${retry}`} src={url} controls muted playsInline preload="none"
              width={432} height={768} aria-label={`${template.name}字幕和特效静音预览`}
              poster={`/edit-previews/v${EDIT_TEMPLATE_VERSION}/${template.id}-${language}.jpg`}
              onError={() => setFailedUrl(url)} className="aspect-[9/16] max-h-[330px] w-full object-contain">
              当前浏览器不支持视频预览。
            </video>
            {failedUrl === url && <div className="absolute inset-0 grid place-content-center gap-3 bg-black/90 p-4 text-center text-xs text-white" role="status">
              <p>预览未加载，已选模板不受影响</p>
              <button type="button" className="rounded-md border border-white/40 p-2 focus-visible:ring-2 focus-visible:ring-white" onClick={() => { setFailedUrl(null); setRetry((value) => value + 1); }}>重新加载预览</button>
            </div>}
          </div>
          <p className="mt-2 text-center text-[11px] text-zinc-500">黑底样片仅预览字幕和特效；音色在右侧单独试听。</p>
        </div>
        <div className="min-w-0 space-y-4">
          <fieldset disabled={disabled} className="grid grid-cols-2 gap-2 disabled:opacity-60">
            <legend className="sr-only">字幕与特效模板</legend>
            {EDIT_TEMPLATES.map((item) => <label key={item.id} className="min-w-0">
              <input className="peer sr-only" type="radio" name="edit-template" value={item.id} checked={template.id === item.id} onChange={() => onTemplate(item.id)} />
              <span className={cn("block h-full cursor-pointer rounded-xl border border-zinc-200 bg-white px-3 py-3 transition-colors hover:border-zinc-400 peer-checked:border-indigo-500 peer-checked:bg-indigo-50/60 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2")}>
                <span className="block text-sm font-semibold text-zinc-900">{item.name}</span>
                <span className="mt-1 block text-[10px] leading-4 text-zinc-500">{item.subtitle}</span>
              </span>
            </label>)}
          </fieldset>
          <fieldset disabled={disabled} className="disabled:opacity-60">
            <legend className="mb-2 text-xs font-medium text-zinc-800">字幕配色 <span className="font-normal text-zinc-400">可搭配上方任一模板</span></legend>
            <div className="grid grid-cols-2 gap-2">{EDIT_COLOR_STYLES.map(item=><label key={item.id} className="min-w-0">
              <input className="peer sr-only" type="radio" name="edit-color" checked={selectedColor===item.id} onChange={()=>onColorStyle(item.id)}/>
              <span className="block cursor-pointer rounded-lg border border-zinc-200 p-2.5 peer-checked:border-indigo-500 peer-checked:bg-indigo-50/60 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500">
                <span aria-hidden="true" className="mb-2 flex h-6 overflow-hidden rounded bg-zinc-950" style={{background:`linear-gradient(110deg,${item.colors.join(",")})`}} />
                <span className="block text-xs font-semibold text-zinc-900">{item.name}</span>
                <span className="mt-1 block text-[10px] text-zinc-500">{item.detail}</span>
              </span>
            </label>)}</div>
            {selectedColor!=="original" && <div className="mt-3">
              <video key={`${colorUrl}-${retry}`} src={colorUrl} poster={`/edit-color-previews/v1/color1-${template.id}-${selectedColor}-${language}.jpg`} controls muted playsInline preload="none" aria-label="字幕配色实际渲染预览" onError={()=>setFailedUrl(colorUrl)} className="aspect-video w-full rounded-lg bg-black" />
              {failedUrl===colorUrl && <p role="status" className="mt-2 text-xs text-zinc-600">配色预览暂未加载，已选设置仍然保留。<button type="button" className="ml-2 underline" onClick={()=>{setFailedUrl(null);setRetry(value=>value+1);}}>重新加载</button></p>}
              <p className="mt-1 text-[10px] leading-4 text-zinc-500">点击看真实配色样片（无声）。上方另行试听音色。流动只作用于文字；已有重音动画时使用静态配色。</p>
            </div>}
          </fieldset>
          <fieldset disabled={disabled}>
            <legend className="mb-2 text-xs font-medium text-zinc-800">新增解说语言</legend>
            <div className="flex gap-2">{([{ id: "en", label: "英语" }, { id: "es", label: "西语" }] as const).map((item) => <label key={item.id}>
              <input className="peer sr-only" type="radio" name="edit-language" checked={language === item.id} onChange={() => onLanguage(item.id)} />
              <span className={cn(pill, "block")}>{item.label}</span>
            </label>)}</div>
            <p className="mt-1.5 text-[10px] text-zinc-500">原声自动识别语言，不强行翻译；新增解说使用所选语言。</p>
          </fieldset>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
            <input type="checkbox" checked={narration} disabled={disabled} onChange={e=>onNarration(e.target.checked)} className="mt-1 h-4 w-4 accent-indigo-600" />
            <span><span className="block text-sm font-semibold text-zinc-900">添加画外解说</span><span className="mt-1 block text-[11px] leading-5 text-zinc-500">{narration ? "已开启配音：有口播时按需补充，无口播时结合画面写解说。操作声仍保留。" : "当前仅保留原声。原视频没有声音，成片也会无声；勾选后才会制作配音。"}</span></span>
          </label>
          {narration && <fieldset disabled={disabled}>
            <legend className="mb-2 text-xs font-medium text-zinc-800">解说详略</legend>
            <div className="flex flex-wrap gap-2">{([{id:"auto",label:"自动判断"},{id:"brief",label:"简短点睛"},{id:"full",label:"完整讲解"}] as const).map(item=><label key={item.id}>
              <input className="peer sr-only" type="radio" name="narration-depth" checked={depth===item.id} onChange={()=>onDepth(item.id)}/>
              <span className={cn(pill,"block")}>{item.label}</span>
            </label>)}</div>
            <p className="mt-2 text-[11px] leading-5 text-zinc-500">{depth==="brief" ? "少量短句点出重点，给画面和声音留白。" : depth==="full" ? "围绕画面组织连贯讲解，不填满每一秒；不会盖住或替换原口播。" : "原口播丰富时少补充，无口播且信息丰富时完整讲解，氛围片轻点睛。"}</p>
          </fieldset>}
          {narration && <div className="space-y-2">
            <label htmlFor="edit-narration-brief" className="block text-xs font-medium text-zinc-800">口播参考文案 <span className="font-normal text-zinc-400">可选</span></label>
            <textarea id="edit-narration-brief" value={narrationBrief} onChange={event=>onNarrationBrief(event.target.value)} disabled={disabled} maxLength={4000} rows={5}
              aria-describedby="edit-narration-brief-help" placeholder="写下你大概想讲的内容，中文也可以。例如：先讲外出携带的场景，再介绍视频里的磁吸拆分操作，最后提醒看看产品细节。"
              className="w-full resize-y rounded-xl border border-zinc-200 bg-white p-3 text-sm leading-6 text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60" />
            <p id="edit-narration-brief-help" className="text-[11px] leading-5 text-zinc-500">填了就按你的思路结合画面润色、精简，以所选英语或西语讲解；不填则自动策划。不会照念分析要求或覆盖原片人声。{narrationBrief.length}/4000</p>
          </div>}
          <fieldset disabled={disabled}>
            <legend className="mb-2 text-xs font-medium text-zinc-800">{usingUploadedVoice ? "解说情绪" : "内置解说音色"}</legend>
            {!usingUploadedVoice && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{PREVIEW_VOICES.map((item) => <label key={item.id}>
              <input className="peer sr-only" type="radio" name="preview-voice" checked={voice === item.id} onChange={() => setVoice(item.id)} />
              <span className={cn(pill, "block")}>{item.label}</span>
            </label>)}</div>}
            {!usingUploadedVoice && <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5">
              <p className="mb-2 text-[10px] text-zinc-500">当前音色短试听（实际文案按所选语言与情绪生成）</p>
              <audio key={`${auditionUrl}-${retry}`} src={auditionUrl} controls preload="none" aria-label={`${PREVIEW_VOICES.find((item)=>item.id===voice)?.label ?? "内置音色"}试听`} onError={()=>setFailedUrl(auditionUrl)} className="h-9 w-full" />
              {failedUrl===auditionUrl && <p role="status" className="mt-2 text-[10px] text-zinc-600">音色试听暂未加载，已选设置仍然保留。<button type="button" className="ml-2 underline" onClick={()=>{setFailedUrl(null);setRetry(value=>value+1);}}>重新加载</button></p>}
            </div>}
            <div className="mt-2 flex flex-wrap gap-2">{PREVIEW_EMOTIONS.map((item) => <label key={item.id}>
              <input className="peer sr-only" type="radio" name="preview-emotion" aria-label={`${item.label}音色试听`} checked={emotion === item.id} onChange={() => setEmotion(item.id)} />
              <span className={cn(pill, "block")}>{item.label}</span>
            </label>)}</div>
          </fieldset>
          <p className="text-[11px] leading-5 text-zinc-500">{usingUploadedVoice ? "选“平淡”会优先跟随上传样本的自然节奏；激动/激昂会尝试语气指令，相似度可能变化。黑底样片仍是内置音色，不代表你的克隆效果。" : narration ? "音色、语言、情绪用于新增画外解说，不替换原人物声音，也不翻译原片对白。若识别不确定或原声太满，会说明原因并保留精剪。" : "当前只试听音色，不新增口播。无口播视频也不会自动加人声；需要时勾选上方选项。"}</p>
        </div>
      </div>
    </div>
  );
}
