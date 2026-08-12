// Media receiver client — the owner's Windows GPU box (F: drive) reachable via a
// Cloudflare QUICK tunnel, exactly like ComfyUI (see comfy.ts for the convention).
// Base URL and token come ONLY from UPLOAD_RECEIVER_URL / UPLOAD_RECEIVER_TOKEN in
// .env — never hardcoded. The tunnel URL changes on every cloudflared restart.
// Empty UPLOAD_RECEIVER_URL = remote not configured; the app falls back to its own
// disk (.data/media) for chunked uploads.
//
// Every receiver request except GET /health must carry the X-Upload-Token header.
// Timeouts are tuned to stay well UNDER the hosting proxy's ~2-minute kill: one
// 8 MB chunk must round-trip in seconds; /complete concatenates on the receiver's
// fast local disk, so even a 50 GB file assembles in well under a minute there.

export const RECEIVER_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
export const MAX_CHUNKED_UPLOAD_BYTES = 50 * 1024 ** 3; // 50 GB cap for the chunked path

/** Error carrying the receiver's HTTP status (4xx from the receiver = client error). */
export class ReceiverError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReceiverError";
    this.status = status;
  }
}

export function receiverBaseUrl(): string {
  return (process.env.UPLOAD_RECEIVER_URL || "").replace(/\/+$/, "");
}

export function receiverToken(): string {
  return process.env.UPLOAD_RECEIVER_TOKEN || "";
}

export function receiverConfigured(): boolean {
  return !!receiverBaseUrl() && !!receiverToken();
}

async function receiverJson<T>(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; data: T | null }> {
  const base = receiverBaseUrl();
  const token = receiverToken();
  if (!base || !token) throw new Error("UPLOAD_RECEIVER_URL / UPLOAD_RECEIVER_TOKEN not configured");
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { "X-Upload-Token": token, ...(init.headers || {}) },
      signal: c.signal,
    });
    const text = await r.text();
    let data: T | null = null;
    try { data = text ? JSON.parse(text) as T : null; } catch { data = null; }
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export interface ReceiverHealth {
  ok: boolean;
  free_gb?: number;
  target_dir?: string;
  error?: string;
}

/** GET {base}/health — liveness + free space. Unauthenticated on the receiver. */
export async function receiverHealth(timeoutMs = 5_000): Promise<ReceiverHealth> {
  const base = receiverBaseUrl();
  if (!base) return { ok: false, error: "UPLOAD_RECEIVER_URL not set" };
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/health`, { signal: c.signal });
    if (!r.ok) return { ok: false, error: `receiver HTTP ${r.status}` };
    const h = await r.json() as { ok?: boolean; free_gb?: number; target_dir?: string };
    return { ok: h.ok !== false, free_gb: h.free_gb, target_dir: h.target_dir };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ReceiverStartBody { upload_id: string; filename: string; size: number; total_chunks: number; }

/** POST {base}/start — declare an upload. Throws on receiver error. */
export async function receiverStart(body: ReceiverStartBody, timeoutMs = 15_000): Promise<void> {
  const res = await receiverJson<{ ok?: boolean; error?: string }>("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!res.data?.ok) {
    throw new Error(res.data?.error || `receiver /start HTTP ${res.status}`);
  }
}

/**
 * PUT {base}/chunk/<uploadId>/<index> — forward ONE raw chunk as a streaming body
 * (never buffered by the app). Returns the receiver's {ok, received:[...]}.
 * Throws on failure.
 */
export async function receiverChunk(
  uploadId: string,
  index: number,
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  timeoutMs = 100_000,
): Promise<{ received: number[] }> {
  const res = await receiverJson<{ ok?: boolean; received?: number[]; error?: string }>(`/chunk/${uploadId}/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", ...(contentLength ? { "Content-Length": contentLength } : {}) },
    body: body as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" }, timeoutMs);
  if (!res.data?.ok) {
    const msg = res.data?.error || `receiver /chunk HTTP ${res.status}`;
    throw new ReceiverError(msg, res.status >= 400 && res.status < 600 ? res.status : 502);
  }
  return { received: res.data.received || [] };
}

export interface ReceiverComplete { ok: boolean; path?: string; size?: number; filename?: string; error?: string; }

/** POST {base}/complete/<uploadId> — assemble + verify on the receiver. Returns {path,size,filename}. */
export async function receiverComplete(uploadId: string, timeoutMs = 110_000): Promise<ReceiverComplete> {
  const res = await receiverJson<ReceiverComplete>(`/complete/${uploadId}`, { method: "POST" }, timeoutMs);
  if (!res.data?.ok) {
    return { ok: false, error: res.data?.error || `receiver /complete HTTP ${res.status}` };
  }
  return { ok: true, path: res.data.path, size: res.data.size, filename: res.data.filename };
}

/** POST {base}/abort/<uploadId> — drop the staging area on the receiver. Never throws. */
export async function receiverAbort(uploadId: string, timeoutMs = 15_000): Promise<void> {
  try {
    await receiverJson<{ ok?: boolean }>(`/abort/${uploadId}`, { method: "POST" }, timeoutMs);
  } catch {
    /* abort is best-effort — the app marks the job aborted regardless */
  }
}

export interface ReceiverStatus { ok?: boolean; received?: number[]; received_count?: number; total_chunks?: number; size?: number; error?: string; }

/** GET {base}/status/<uploadId> — ground-truth received chunk list. Throws on failure. */
export async function receiverStatus(uploadId: string, timeoutMs = 15_000): Promise<ReceiverStatus> {
  const res = await receiverJson<ReceiverStatus>(`/status/${uploadId}`, {}, timeoutMs);
  if (!res.data?.ok) throw new Error(res.data?.error || `receiver /status HTTP ${res.status}`);
  return res.data;
}

/** GET {base}/file/<filename> — stream a completed remote file back (Range passthrough). */
export async function receiverFileStream(filename: string, range: string | null, timeoutMs = 20_000) {
  const base = receiverBaseUrl();
  const token = receiverToken();
  if (!base || !token) throw new Error("UPLOAD_RECEIVER_URL / UPLOAD_RECEIVER_TOKEN not configured");
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/file/${encodeURIComponent(filename)}`, {
      headers: { "X-Upload-Token": token, ...(range ? { Range: range } : {}) },
      signal: c.signal,
    });
    return r;
  } finally {
    clearTimeout(timer); // only the header wait is timed; the body streams after
  }
}
