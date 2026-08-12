// ComfyUI client — owner's GPU box (RTX 3080) reachable via a Cloudflare QUICK tunnel.
// Base URL comes ONLY from COMFYUI_BASE_URL (see .env) — never hardcoded here.
// The tunnel URL changes every time cloudflared restarts; update .env when it does.
import type { ComfyHistoryEntry, ComfyQueueState, ComfySystemStats, ComfyWorkflowOutputs } from "./types/comfy";

const DEFAULT_TIMEOUT_MS = 10000;

export function comfyBaseUrl(): string {
  return (process.env.COMFYUI_BASE_URL || "").replace(/\/+$/, "");
}

export function comfyConfigured(): boolean {
  return !!process.env.COMFYUI_BASE_URL;
}

function comfyError(msg: string, cause?: unknown): { ok: false; error: string } {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return { ok: false, error: `${msg}${detail}` };
}

async function comfyFetch<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const base = comfyBaseUrl();
  if (!base) throw new Error("COMFYUI_BASE_URL is not configured");
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, { ...init, signal: c.signal });
    const text = await r.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`ComfyUI invalid JSON (HTTP ${r.status})`);
    }
    if (!r.ok) {
      const msg = data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface ComfyHealth {
  ok: boolean;
  comfyui_version?: string;
  device?: string;
  vram_free?: number;
  error?: string;
}

/** GET {base}/system_stats — liveness + GPU info. */
export async function comfyHealth(): Promise<ComfyHealth> {
  try {
    const stats = await comfyFetch<ComfySystemStats>("/system_stats", undefined, 10_000);
    const dev = stats?.devices?.[0];
    return {
      ok: true,
      comfyui_version: stats?.system?.comfyui_version || "unknown",
      device: dev ? `${dev.name}` : undefined,
      vram_free: dev?.vram_free,
    };
  } catch (err) {
    return comfyError("ComfyUI health check failed", err);
  }
}

/** GET {base}/queue — running + pending prompt ids. */
export async function comfyQueue(): Promise<ComfyQueueState> {
  try {
    const q = await comfyFetch<ComfyQueueState>("/queue", undefined, 10_000);
    return { queue_running: q?.queue_running || [], queue_pending: q?.queue_pending || [] };
  } catch (err) {
    throw new Error(`ComfyUI queue check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST {base}/prompt — submit a workflow (API-format prompt graph). Returns prompt_id. */
export async function submitWorkflow(workflow: object, timeoutMs = 20_000): Promise<string> {
  const res = await comfyFetch<{ prompt_id?: string; number?: number; node_errors?: unknown }>(
    "/prompt",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow }) },
    timeoutMs,
  );
  if (!res?.prompt_id) {
    const detail = res?.node_errors ? ` node_errors=${JSON.stringify(res.node_errors).slice(0, 500)}` : "";
    throw new Error(`ComfyUI did not return a prompt_id${detail}`);
  }
  return res.prompt_id;
}

export interface ComfyHistoryStatus {
  status: "completed" | "executing" | "failed" | "not_found";
  outputs: ComfyWorkflowOutputs;
  error?: string;
}

/** GET {base}/history/{promptId} — execution status + outputs (images/video). */
export async function comfyHistory(promptId: string, timeoutMs = 15_000): Promise<ComfyHistoryStatus> {
  try {
    const hist = await comfyFetch<Record<string, ComfyHistoryEntry>>(`/history/${promptId}`, undefined, timeoutMs);
    const entry = hist?.[promptId];
    if (!entry) return { status: "not_found", outputs: {} };
    const outputs: ComfyWorkflowOutputs = {};
    for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
      const images = out.images?.filter((i) => i.filename) || [];
      const video = out.video?.filter((v) => v.filename) || [];
      if (images.length || video.length) outputs[nodeId] = { images, video };
    }
    if (entry.status?.status_str === "error") {
      const err = entry.status?.messages
        ?.filter((m: unknown[]) => Array.isArray(m) && m[0] === "execution_error")
        .map((m: unknown[]) => (m[1] && typeof m[1] === "object" ? JSON.stringify(m[1]).slice(0, 400) : String(m[1])))
        .join("; ") || "execution error";
      return { status: "failed", outputs, error: err };
    }
    const completed = entry.status?.completed || entry.outputs ? Object.keys(entry.outputs).length > 0 : false;
    return { status: completed ? "completed" : "executing", outputs };
  } catch (err) {
    throw new Error(`ComfyUI history check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ComfyViewParams {
  filename: string;
  subfolder?: string;
  type?: string;
}

/**
 * GET {base}/view — fetch a rendered output (image/video) by filename.
 * Returns { ok, status, contentType, bytes } or { ok:false, error }.
 */
export async function comfyView(params: ComfyViewParams, timeoutMs = 30_000) {
  const base = comfyBaseUrl();
  if (!base) return { ok: false, error: "COMFYUI_BASE_URL is not configured" };
  const q = new URLSearchParams({ filename: params.filename });
  if (params.subfolder) q.set("subfolder", params.subfolder);
  if (params.type) q.set("type", params.type);
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/view?${q.toString()}`, { signal: c.signal });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, status: r.status, contentType: r.headers.get("content-type") || "", bytes: buf };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
