"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AudioLines, Plus, Upload, X } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/client";
import { uploadVideoFile, type VideoUploadProgress } from "@/lib/video-client";
import type { VideoOut } from "@/lib/types";
import { toast } from "sonner";

interface Voice { id: string; name: string; status: "new" | "ready"; sourceIds: string[] }
interface VoiceTask { id: number; voiceId: string; text: string; status: string; progress: number; message: string; error: string | null; audioUrl: string | null; language: string; emotion: string }
interface Library { voices: Voice[]; tasks: VoiceTask[] }
const fieldClass = "w-full min-w-0 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";

export default function VoicesPage() {
  const [library, setLibrary] = useState<Library>({ voices: [], tasks: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [sources, setSources] = useState<VideoOut[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("en");
  const [emotion, setEmotion] = useState("neutral");
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<VideoUploadProgress | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pollInFlight = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const data = await apiGet<Library>("/api/voices", { signal });
      if (signal?.aborted) return;
      setLibrary(data); setLoaded(true); setError("");
      setSelected(previous => data.voices.some(v => v.id === previous) ? previous : data.voices[0]?.id ?? "");
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "暂时无法读取音色，请刷新"); }
    finally { pollInFlight.current = false; }
  }, []);
  const active = library.tasks.some(t => t.status === "pending" || t.status === "running");
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => { c.abort(); uploadAbort.current?.abort(); }; }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    const tick = () => { if (!document.hidden) void refresh(c.signal); };
    const interval = window.setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => { c.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", tick); };
  }, [active, refresh]);
  async function addFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    if (sources.length + files.length > 2) { toast.error("每个音色最多2个参考文件"); return; }
    const controller = new AbortController(); uploadAbort.current = controller; setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const result = await uploadVideoFile(file, setUpload, controller.signal, "voice_reference");
        setSources(previous => [...previous, result]);
      }
    } catch (e) { if (!controller.signal.aborted) toast.error(e instanceof Error ? e.message : "上传未完成，可重新添加"); }
    finally { setBusy(false); setUpload(null); uploadAbort.current = null; }
  }
  async function save() {
    setBusy(true);
    try {
      const result = await apiSend<{ id: string }>("/api/voices", "POST", { name, sourceIds: sources.map(s => s.id), authorized });
      await refresh(); setSelected(result.id); setAdding(false); setName(""); setSources([]); setAuthorized(false);
      toast.success("音色已保存，输入台词生成试听后即可在剪辑里复用");
    } catch (e) { toast.error(e instanceof Error ? e.message : "保存未完成"); }
    finally { setBusy(false); }
  }
  async function generate() {
    setBusy(true);
    try {
      await apiSend(`/api/voices/${selected}/generate`, "POST", { text, language, emotion });
      await refresh(); toast.success("配音已加入队列，可以离开页面，稍后回来下载");
    } catch (e) { toast.error(e instanceof Error ? e.message : "未能提交，台词仍在这里"); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!window.confirm("归档这个音色？已生成的配音和正在处理的剪辑不受影响。")) return;
    setBusy(true);
    try { await apiSend(`/api/voices/${selected}`, "PATCH", { archive: true }); await refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "归档未完成"); }
    finally { setBusy(false); }
  }
  const voice = library.voices.find(v => v.id === selected);
  return <AppShell active="/voices">
    <main className="mx-auto max-w-5xl space-y-6 py-3 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight"><AudioLines className="h-7 w-7 text-indigo-600" />声音克隆</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">保存你的音色，换一段台词继续说。配音可下载，也可在自动剪辑里选用。</p></div>
        <Link href="/dashboard?create=auto_edit" className="rounded-lg px-3 py-2 text-sm text-indigo-600 underline underline-offset-4">去自动剪辑</Link>
      </header>
      {error && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{error} <button onClick={() => void refresh()} className="underline">重新加载</button></div>}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4 rounded-2xl border bg-white p-5">
          <div className="flex items-center justify-between"><h2 className="font-semibold">我的音色</h2><Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(!adding)}><Plus className="mr-1 h-3 w-3" />新建</Button></div>
          <p className="text-xs leading-5 text-zinc-500">音色按账号私有保存；换设备登录同一账号也能复用。</p>
          {!loaded && !error && <p role="status" className="text-sm text-zinc-500">正在读取…</p>}
          {loaded && library.voices.length === 0 && <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed p-5 text-left text-sm leading-6 text-zinc-500">添加第一个音色<br />支持视频、WAV、MP3 等音频</button>}
          <div className="space-y-2" role="radiogroup" aria-label="我的音色">
            {library.voices.map(v => <button key={v.id} role="radio" aria-checked={selected === v.id} disabled={busy} onClick={() => { setSelected(v.id); setAdding(false); }} className={`w-full rounded-xl border p-3 text-left focus-visible:ring-2 focus-visible:ring-indigo-500 ${selected === v.id ? "border-indigo-400 bg-indigo-50" : "border-zinc-200"}`}><span className="block break-words text-sm font-medium">{v.name}</span><span className="mt-1 block text-xs text-zinc-500">{v.status === "ready" ? "可重复使用 · 可用于剪辑" : "已保存 · 首次生成时准备音色"}</span></button>)}
          </div>
          {voice && !adding && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void archive()}>归档当前音色</Button>}
        </aside>
        <section className="min-w-0 space-y-5 rounded-2xl border bg-white p-5 sm:p-7">
          {adding ? <>
            <h2 className="text-lg font-semibold">保存新音色</h2>
            <label className="block space-y-2 text-sm"><span>音色名字</span><input className={fieldClass} value={name} maxLength={40} placeholder="例如：我的自然男声" disabled={busy} onChange={e => setName(e.target.value)} /></label>
            <div className="space-y-3 rounded-xl bg-zinc-50 p-4">
              <p className="text-sm font-medium">1–2 个同一人的参考文件</p>
              <p className="text-xs leading-6 text-zinc-500">用单人、清晰、少背景音乐的录音。每个文件检查前3分钟，选取较清楚的连续人声；第二个文件用于择优，不混合不同人的声音。</p>
              <input ref={input} type="file" multiple accept="audio/*,video/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,.aiff,.aif,.caf,.mp4,.mov,.mkv" className="sr-only" aria-label="添加参考音频或视频" onChange={e => { void addFiles(e.target.files); e.target.value = ""; }} />
              {sources.map(s => <div key={s.id} className="flex items-center gap-2 rounded-lg border bg-white p-2 text-xs"><span className="min-w-0 flex-1 truncate">{s.name}</span><button disabled={busy} aria-label={`移除 ${s.name}`} onClick={() => setSources(previous => previous.filter(p => p.id !== s.id))} className="rounded p-1 hover:bg-zinc-100"><X className="h-4 w-4" /></button></div>)}
              {upload ? <div role="status" className="space-y-2 text-xs"><p>正在上传 {upload.percent}% · {upload.statusText || (upload.phase === "saving" ? "正在保存" : "传输中")}</p><progress max={100} value={upload.percent} className="w-full" /><Button size="sm" variant="outline" onClick={() => uploadAbort.current?.abort()}>取消上传</Button></div>
                : <Button variant="outline" disabled={busy || sources.length >= 2} onClick={() => input.current?.click()}><Upload className="mr-2 h-4 w-4" />添加音频 / 视频</Button>}
            </div>
            <label className="flex items-start gap-2 text-xs leading-5 text-zinc-600"><input type="checkbox" checked={authorized} disabled={busy} onChange={e => setAuthorized(e.target.checked)} className="mt-1" />这是我本人或已获授权的声音，不用于冒充他人或欺骗。</label>
            <div className="flex gap-2"><Button disabled={busy || !authorized || !name.trim() || !sources.length} onClick={() => void save()}>保存音色</Button><Button variant="ghost" disabled={busy} onClick={() => setAdding(false)}>返回配音</Button></div>
          </> : <>
            <div className="border-l-4 border-indigo-500 pl-4"><h2 className="text-lg font-semibold">{voice ? `用「${voice.name}」说` : "让你的声音说新台词"}</h2><p className="mt-1 text-xs leading-6 text-zinc-500">整段连续配音，不按视频片段拆成一句句播报。按原文朗读，不自动翻译或改写。</p></div>
            <label className="block space-y-2 text-sm"><span>要说的话</span><textarea className={`${fieldClass} min-h-48 leading-7`} maxLength={500} value={text} placeholder="直接填写英语或西班牙语台词，标点可以帮助自然停顿。" onChange={e => setText(e.target.value)} /><span className="block text-right text-xs text-zinc-400">{text.length} / 500 字符</span></label>
            <div className="grid grid-cols-2 gap-3"><label className="space-y-2 text-sm"><span>台词语言</span><select className={fieldClass} value={language} onChange={e => setLanguage(e.target.value)}><option value="en">英语</option><option value="es">西班牙语</option></select></label>
              <label className="space-y-2 text-sm"><span>语气</span><select className={fieldClass} value={emotion} onChange={e => setEmotion(e.target.value)}><option value="neutral">自然 · 沿用参考节奏</option><option value="excited">轻快有活力</option><option value="emphatic">自信有感染力</option></select></label></div>
            <Button disabled={busy || !selected || !text.trim()} onClick={() => void generate()}>{busy ? "正在提交…" : "生成配音"}</Button>
            <p className="text-xs leading-6 text-zinc-500">音源清晰度与语言会影响相似度。台词核对不等于音色、情绪已满意，请先试听；不满意可保留音色重新生成。</p>
          </>}
        </section>
      </div>
      <section className="space-y-3"><h2 className="text-base font-semibold">最近的配音</h2>
        {loaded && !library.tasks.length && <p className="text-sm text-zinc-500">生成后会留在这里，台词也会保存，方便修改和再次使用。</p>}
        {library.tasks.map(task => <article key={task.id} className="space-y-3 rounded-xl border bg-white p-4">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{library.voices.find(v => v.id === task.voiceId)?.name || "已归档音色"} · #{task.id}</strong><span className="text-zinc-500">{task.status === "succeeded" ? "可试听下载" : task.status === "pending" ? "等待处理" : task.status === "running" ? `处理中 ${task.progress}%` : task.status === "canceled" ? "已取消" : "需要重试"}</span></div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-600">{task.text}</p>
          {task.audioUrl ? <div className="flex flex-wrap items-center gap-3"><audio controls preload="none" src={task.audioUrl} className="w-full sm:w-80" aria-label={`配音 ${task.id}`} /><a href={task.audioUrl} download={`voice-${task.id}.wav`} className="text-sm text-indigo-600 underline underline-offset-4">下载 WAV</a></div> : <p role="status" className="text-xs leading-6 text-zinc-500">{task.error || task.message}</p>}
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { setText(task.text); setLanguage(task.language); setEmotion(task.emotion); if (library.voices.some(v => v.id === task.voiceId)) setSelected(task.voiceId); setAdding(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}>带入台词修改</Button>
            {(task.status === "pending" || task.status === "running") && <Button variant="ghost" size="sm" onClick={async () => { try { await apiSend(`/api/tasks/${task.id}/cancel`); await refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : "取消未完成"); } }}>取消</Button>}</div>
        </article>)}
      </section>
    </main>
  </AppShell>;
}
