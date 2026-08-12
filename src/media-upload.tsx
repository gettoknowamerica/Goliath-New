// Media upload UI for Mission Control — chunked client + library surface.
// The browser slices each file at the server-advertised chunk size (8 MB) and
// POSTs chunks sequentially as raw octet-stream bodies (uploadId/index ride in
// query params), then calls upload-complete. Chunk failures retry 3x with
// backoff; a failed file keeps its server-side job and its Retry button resumes
// from the received_count reported by /api/media/upload/status — never from the
// start. The library merges uploaded items (local app storage or the owner's
// F: drive via the receiver) with ComfyUI renders.
import { useEffect, useRef, useState } from "react";

// ── types ────────────────────────────────────────────────────────────────────
export type MediaItem = {
  id: number;
  aspect: string;
  source: string; // 'upload' (local) | 'remote' (F: drive)
  kind: string; // 'video' | 'image' | 'audio' | 'doc'
  title: string | null;
  filename: string;
  thumb: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export type ViewerMedia = {
  key: string;
  title: string;
  kind: string;
  url: string;
  source: "render" | "upload" | "remote";
  id?: number;
  filename?: string;
};

export type UploadTask = {
  key: string;
  filename: string;
  size: number;
  aspect: string;
  uploadId: string | null;
  target: "remote" | "local" | null;
  chunkSize: number;
  totalChunks: number;
  received: number;
  progress: number; // 0..100
  status: "queued" | "starting" | "uploading" | "done" | "error" | "aborted";
  error?: string;
  itemId?: number;
  file: File;
};

export type LibraryFilter = "all" | "uploads" | "renders";

// ── helpers ──────────────────────────────────────────────────────────────────
// Mirrors the server's extension allowlist (src/media-files.ts) for the client
// side: accept attr + drag-drop filtering. Anything else is rejected.
const EXT_KIND: Record<string, string> = {
  mp4: "video", mov: "video", webm: "video", m4v: "video", mkv: "video", avi: "video",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", avif: "image", bmp: "image", ico: "image",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", aac: "audio", aiff: "audio", wma: "audio",
  pdf: "doc", doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", ppt: "doc", pptx: "doc", txt: "doc", md: "doc", csv: "doc", rtf: "doc",
};

export const MEDIA_ACCEPT = "video/*,image/*,audio/*,.mp4,.mov,.webm,.m4v,.mkv,.avi,.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp,.ico,.mp3,.wav,.ogg,.m4a,.flac,.aac,.aiff,.wma,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.rtf";

export function clientKind(filename: string): string {
  const i = filename.lastIndexOf(".");
  const ext = i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
  return EXT_KIND[ext] ?? "other";
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Playback URL for a library item — local uploads via /api/media/file, F: drive items via /api/media/remote/view (which 503s when the receiver isn't configured). */
export function mediaItemUrl(m: MediaItem): string {
  return m.source === "remote"
    ? `/api/media/remote/view?filename=${encodeURIComponent(m.filename)}`
    : `/api/media/file/${encodeURIComponent(m.filename)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (done: number, total: number) => Math.max(0, Math.min(100, Math.round((done / total) * 100)));

// ── uploader hook ────────────────────────────────────────────────────────────
export function useMediaUploader(onDone?: () => void) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const tasksRef = useRef<UploadTask[]>([]);
  tasksRef.current = tasks;
  const busyRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const patch = (key: string, p: Partial<UploadTask>) =>
    setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));

  async function uploadOne(key: string) {
    const first = tasksRef.current.find((t) => t.key === key);
    if (!first) return;
    patch(key, { status: "starting", error: undefined });
    try {
      const t0 = tasksRef.current.find((x) => x.key === key)!;
      // 1. start — unless a previous attempt already holds an uploadId (retry/resume).
      //    NOTE: do NOT re-read tasksRef synchronously after patch() below — React
      //    hasn't re-rendered yet, so the ref would still show uploadId:null.
      let uploadId: string;
      let chunkSize: number;
      let totalChunks: number;
      let target: "remote" | "local" | null = null;
      if (t0.uploadId) {
        uploadId = t0.uploadId;
        chunkSize = t0.chunkSize || 8 * 1024 * 1024;
        totalChunks = Math.max(1, t0.totalChunks || Math.ceil(t0.size / chunkSize));
        target = t0.target;
      } else {
        const r = await fetch("/api/media/upload/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: t0.filename, size: t0.size, aspect: t0.aspect }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `upload start failed (HTTP ${r.status})`);
        uploadId = d.uploadId;
        chunkSize = d.chunk_size || 8 * 1024 * 1024;
        totalChunks = Math.max(1, d.total_chunks || Math.ceil(t0.size / chunkSize));
        target = d.target === "remote" ? "remote" : "local";
        patch(key, { uploadId, target, chunkSize, totalChunks, progress: 0, received: 0 });
      }
      patch(key, { status: "uploading", target, totalChunks, chunkSize });

      // 2. resume from server truth — the job may already hold chunks from a
      //    failed earlier attempt (Retry) or an interrupted session.
      let startIndex = 0;
      try {
        const sr = await fetch(`/api/media/upload/status?uploadId=${encodeURIComponent(uploadId)}`);
        if (sr.ok) {
          const sd = await sr.json();
          startIndex = Math.min(Math.max(0, Number(sd.job?.received_count) || 0), totalChunks);
        }
      } catch { /* keep 0 */ }
      patch(key, { received: startIndex, progress: pct(startIndex, totalChunks) });

      // 3. sequential chunks — each with 3 attempts + backoff. Re-sending an
      //    index is safe (the server overwrites chunk-N atomically).
      for (let i = startIndex; i < totalChunks; i++) {
        if (tasksRef.current.find((x) => x.key === key)?.status === "aborted") return;
        const start = i * chunkSize;
        const slice = t0.file.slice(start, Math.min(t0.size, start + chunkSize));
        let attempts = 0;
        for (;;) {
          try {
            const res = await fetch(`/api/media/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: slice,
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || `chunk ${i} failed (HTTP ${res.status})`);
            break;
          } catch (e) {
            if (tasksRef.current.find((x) => x.key === key)?.status === "aborted") return;
            if (++attempts >= 3) throw e;
            await sleep(600 * attempts + Math.random() * 400);
          }
        }
        patch(key, { received: i + 1, progress: pct(i + 1, totalChunks) });
      }

      // 4. assemble + record the media item
      const cr = await fetch("/api/media/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId }),
      });
      const cd = await cr.json().catch(() => ({}));
      if (!cr.ok) throw new Error(cd.error || `upload complete failed (HTTP ${cr.status})`);
      patch(key, { status: "done", progress: 100, received: totalChunks, itemId: cd.item?.id });
      onDoneRef.current?.();
    } catch (e) {
      if (tasksRef.current.find((x) => x.key === key)?.status === "aborted") return;
      patch(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Worker: upload queued files one at a time so each file gets the full pipe.
  useEffect(() => {
    if (busyRef.current) return;
    const next = tasks.find((t) => t.status === "queued");
    if (!next) return;
    busyRef.current = true;
    uploadOne(next.key).finally(() => { busyRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  function enqueue(files: File[], aspect: string) {
    const fresh: UploadTask[] = files.map((file) => ({
      key: crypto.randomUUID(),
      filename: file.name,
      size: file.size,
      aspect,
      uploadId: null,
      target: null,
      chunkSize: 8 * 1024 * 1024,
      totalChunks: 1,
      received: 0,
      progress: 0,
      status: "queued",
      file,
    }));
    setTasks((ts) => [...ts, ...fresh]);
  }

  function cancelTask(key: string) {
    const t = tasksRef.current.find((x) => x.key === key);
    if (!t) return;
    patch(key, { status: "aborted" });
    if (t.uploadId && (t.status === "starting" || t.status === "uploading" || t.status === "error")) {
      fetch("/api/media/upload/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: t.uploadId }),
      }).catch(() => { /* best-effort — job row is marked aborted client-side */ });
    }
  }

  function retryTask(key: string) {
    const t = tasksRef.current.find((x) => x.key === key);
    if (!t || t.status !== "error") return;
    patch(key, { status: "queued", error: undefined });
  }

  function clearTask(key: string) {
    setTasks((ts) => ts.filter((t) => t.key !== key));
  }

  function clearFinished() {
    setTasks((ts) => ts.filter((t) => t.status !== "done" && t.status !== "aborted"));
  }

  return { tasks, enqueue, cancelTask, retryTask, clearTask, clearFinished };
}

// ── shared bits ──────────────────────────────────────────────────────────────
const KIND_ICON: Record<string, string> = { video: "▶", image: "▧", audio: "♪", doc: "▤", other: "▤" };

function TaskStatusChip({ status }: { status: UploadTask["status"] }) {
  const styles: Record<UploadTask["status"], string> = {
    queued: "bg-white/[0.07] text-slate-300",
    starting: "bg-amber-400/15 text-amber-300",
    uploading: "bg-amber-400/15 text-amber-300",
    done: "bg-emerald-400/15 text-emerald-300",
    error: "bg-rose-500/15 text-rose-300",
    aborted: "bg-white/[0.06] text-slate-500",
  };
  const labels: Record<UploadTask["status"], string> = {
    queued: "queued", starting: "starting", uploading: "uploading", done: "done", error: "failed", aborted: "cancelled",
  };
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase ${styles[status]}`}>{labels[status]}</span>;
}

// ── upload zone (Scorsese workbench) ─────────────────────────────────────────
export function MediaUploadZone({ tasks, aspect, setAspect, onEnqueue, onCancel, onRetry, onClearTask, onClearFinished }: {
  tasks: UploadTask[];
  aspect: string;
  setAspect: (a: string) => void;
  onEnqueue: (files: File[], aspect: string) => void;
  onCancel: (key: string) => void;
  onRetry: (key: string) => void;
  onClearTask: (key: string) => void;
  onClearFinished: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pickError, setPickError] = useState("");

  const addFiles = (list: FileList | File[]) => {
    const picked = Array.from(list).filter((f) => f.size > 0);
    if (picked.length === 0) return;
    const bad = picked.filter((f) => clientKind(f.name) === "other");
    if (bad.length > 0) {
      setPickError(`Skipped ${bad.length} unsupported file(s): ${bad.slice(0, 3).map((f) => f.name).join(", ")}`);
    }
    const good = picked.filter((f) => clientKind(f.name) !== "other");
    if (good.length === 0) return;
    setPickError("");
    onEnqueue(good, aspect);
  };

  const hasFinished = tasks.some((t) => t.status === "done" || t.status === "aborted");
  const activeCount = tasks.filter((t) => t.status === "queued" || t.status === "starting" || t.status === "uploading").length;

  const line = (t: UploadTask) =>
    t.status === "starting" ? "contacting server…"
    : t.status === "queued" ? "waiting for a free slot…"
    : t.status === "uploading" ? `${t.received} / ${t.totalChunks} chunks · ${t.progress}%${t.target === "remote" ? " · streaming to F: drive" : ""}`
    : t.status === "done" ? "saved to the library"
    : t.status === "error" ? "failed — Retry resumes from the last received chunk"
    : "cancelled";

  return <div className="mb-4 rounded-2xl border border-white/[0.08] bg-[#0b0e14]/70 p-3">
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Upload raw footage &amp; assets</span>
      <span className="text-[10px] text-slate-600">chunked · survives the proxy</span>
      <div className="ml-auto flex items-center gap-2">
        <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Aspect</label>
        <select value={aspect} onChange={(e) => setAspect(e.target.value)} className="rounded-lg border border-white/10 bg-[#0e1219] px-2 py-1 text-xs font-semibold text-slate-200 outline-none focus:border-amber-400/50">
          <option value="scorsese">Scorsese</option>
          <option value="general">General</option>
        </select>
        <button onClick={() => inputRef.current?.click()} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-1.5 text-xs font-black text-amber-950 transition hover:from-amber-200 hover:to-amber-400">Choose files</button>
      </div>
    </div>

    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      className={`grid cursor-pointer place-items-center rounded-xl border border-dashed px-4 py-5 text-center transition ${dragging ? "border-amber-400/70 bg-amber-400/[0.07]" : "border-white/15 bg-white/[0.02] hover:border-amber-400/40 hover:bg-white/[0.04]"}`}
    >
      <div>
        <div className="text-xl text-amber-300/80">⇪</div>
        <p className="mt-1 text-xs font-semibold text-slate-300">Drag &amp; drop raw video, pictures or audio — or click to browse</p>
        <p className="mt-0.5 text-[10px] text-slate-500">mp4 · mov · webm · mkv · png · jpg · webp · gif · mp3 · wav · pdf — up to 50 GB, uploaded in 8 MB chunks</p>
      </div>
    </div>
    <input ref={inputRef} type="file" multiple hidden accept={MEDIA_ACCEPT} onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }} />

    {pickError && <p className="mt-2 text-[11px] font-semibold text-rose-300">{pickError}</p>}

    {tasks.length > 0 && <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Queue <span className="normal-case text-slate-600">({tasks.length}{activeCount ? ` · ${activeCount} active` : ""})</span></p>
        {hasFinished && <button onClick={onClearFinished} className="text-[10px] font-bold text-slate-500 transition hover:text-amber-300">Clear finished</button>}
      </div>
      {tasks.map((t) => <div key={t.key} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/[0.05] text-[10px] text-amber-300">{KIND_ICON[clientKind(t.filename)] ?? "▤"}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-semibold text-slate-200">{t.filename}</span>
              <span className="shrink-0 text-[10px] font-bold text-slate-400">{fmtBytes(t.size)}</span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <span className="shrink-0 text-[10px] text-slate-500">{line(t)}</span>
              <TaskStatusChip status={t.status} />
            </div>
            {(t.status === "starting" || t.status === "uploading") && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-300 transition-all" style={{ width: `${t.progress}%` }} /></div>}
            {t.status === "error" && t.error && <p className="mt-1 truncate text-[10px] font-semibold text-rose-300">{t.error}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(t.status === "queued" || t.status === "starting" || t.status === "uploading") && <button onClick={() => onCancel(t.key)} className="rounded-md border border-rose-500/30 px-2 py-1 text-[10px] font-bold text-rose-300 transition hover:bg-rose-500/10" title="Cancel upload">✕</button>}
            {t.status === "error" && <><button onClick={() => onRetry(t.key)} className="rounded-md border border-amber-400/30 px-2 py-1 text-[10px] font-bold text-amber-300 transition hover:bg-amber-400/10">↻ Retry</button><button onClick={() => onClearTask(t.key)} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-400 transition hover:bg-white/5" title="Remove from queue">✕</button></>}
            {t.status === "done" && <span className="px-1 text-[11px] font-black text-emerald-300" title="Uploaded">✓</span>}
            {t.status === "aborted" && <button onClick={() => onClearTask(t.key)} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-400 transition hover:bg-white/5" title="Remove from queue">✕</button>}
          </div>
        </div>
      </div>)}
    </div>}
  </div>;
}

// ── compact uploads strip (right inspector) ──────────────────────────────────
export function UploadsStrip({ tasks, onCancel, onRetry }: { tasks: UploadTask[]; onCancel: (k: string) => void; onRetry: (k: string) => void }) {
  const active = tasks.filter((t) => t.status === "queued" || t.status === "starting" || t.status === "uploading" || t.status === "error");
  if (active.length === 0) return <p className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[11px] text-slate-500">No uploads in progress.</p>;
  return <div className="space-y-1.5">
    {active.map((t) => (
      <div key={t.key} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[10px] font-semibold text-slate-300">{t.filename}</span>
          <span className="shrink-0 text-[10px] font-black text-amber-300">{t.progress}%</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-300 transition-all" style={{ width: `${t.progress}%` }} /></div>
          {t.status === "error" ? <button onClick={() => onRetry(t.key)} className="shrink-0 rounded border border-amber-400/30 px-1.5 py-0.5 text-[9px] font-bold text-amber-300 transition hover:bg-amber-400/10">Retry</button> : <button onClick={() => onCancel(t.key)} className="shrink-0 text-[10px] text-slate-500 transition hover:text-rose-300" title="Cancel">✕</button>}
        </div>
        {t.status === "error" && t.error && <p className="mt-1 truncate text-[9px] font-semibold text-rose-300">{t.error}</p>}
      </div>
    ))}
  </div>;
}

// ── library (uploads + renders merged) ───────────────────────────────────────
function MediaThumb({ entry }: { entry: ViewerMedia }) {
  const [failed, setFailed] = useState(false);
  if (entry.kind === "image") {
    if (failed) return <ThumbFallback entry={entry} />;
    return <img src={entry.url} alt={entry.title} loading="lazy" className="h-full w-full bg-[#0b0e14] object-cover" onError={() => setFailed(true)} />;
  }
  if (entry.kind === "video") {
    if (failed) return <ThumbFallback entry={entry} />;
    return <video src={entry.url} preload="metadata" muted playsInline className="h-full w-full bg-black object-cover" onError={() => setFailed(true)} />;
  }
  return <ThumbFallback entry={entry} />;
}

function ThumbFallback({ entry }: { entry: ViewerMedia }) {
  return <div className="grid h-full w-full place-items-center bg-[#0b0e14]"><span className="text-2xl text-amber-300/70">{entry.kind === "video" ? "▶" : KIND_ICON[entry.kind] ?? "▤"}</span></div>;
}

export function MediaLibrary({ entries, filter, setFilter, viewerKey, onPlay, onDelete, busyDelete }: {
  entries: ViewerMedia[];
  filter: LibraryFilter;
  setFilter: (f: LibraryFilter) => void;
  viewerKey?: string;
  onPlay: (e: ViewerMedia) => void;
  onDelete: (e: ViewerMedia) => void;
  busyDelete: number | null;
}) {
  const counts = {
    all: entries.length,
    uploads: entries.filter((e) => e.source !== "render").length,
    renders: entries.filter((e) => e.source === "render").length,
  };
  const shown = filter === "all" ? entries : entries.filter((e) => (filter === "uploads" ? e.source !== "render" : e.source === "render"));
  const emptyMsg = filter === "all" ? "No media yet — drop footage or assets above."
    : filter === "uploads" ? "No uploads yet — drop footage or assets above."
    : "No renders in ComfyUI history yet.";
  return <div>
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Library <span className="normal-case text-slate-600">({counts.all} items · click to play)</span></p>
      <div className="ml-auto flex items-center gap-1">
        {(["all", "uploads", "renders"] as LibraryFilter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize transition ${filter === f ? "border border-amber-400/40 bg-amber-400/15 text-amber-300" : "border border-white/10 text-slate-400 hover:text-amber-200"}`}>{f} <span className="opacity-60">{counts[f]}</span></button>
        ))}
      </div>
    </div>
    {shown.length === 0
      ? <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-8 text-center text-xs text-slate-500">{emptyMsg}</p>
      : <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-5 2xl:grid-cols-6">
          {shown.map((e) => (
            <div key={e.key} onClick={() => onPlay(e)} title={e.title} className={`group relative cursor-pointer overflow-hidden rounded-lg border transition hover:border-amber-400/60 ${viewerKey === e.key ? "border-amber-400/70 ring-1 ring-amber-400/40" : "border-white/10"} ${e.kind === "image" ? "aspect-square" : "aspect-video"}`}>
              <MediaThumb entry={e} />
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold uppercase text-amber-300">{e.kind}</span>
              {e.source === "remote" && <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold uppercase text-sky-300">F:</span>}
              {e.source === "render" && <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold uppercase text-violet-300">render</span>}
              {e.id != null && <button onClick={(ev) => { ev.stopPropagation(); onDelete(e); }} disabled={busyDelete === e.id} className="absolute right-1 top-1 hidden rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-rose-300 transition hover:bg-rose-600/80 group-hover:block disabled:opacity-40" title="Delete from library">✕</button>}
            </div>
          ))}
        </div>}
  </div>;
}
