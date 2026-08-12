import { createFileRoute } from "@tanstack/react-router";
import { comfyBaseUrl, comfyConfigured } from "~/comfy";
import { comfyKindOf } from "~/media-files";
import { json } from "../-helpers";
// GET /api/media/comfy — pull ComfyUI /history?max_items=50 and map every completed
// prompt's outputs to lightweight {prompt_id, title, filename, subfolder, type, kind,
// created} entries, newest first. Never throws: {configured, entries, count, error?}.
// The tunnel URL is never exposed to the client.

function extractPositivePrompt(prompt: unknown): string {
  if (!Array.isArray(prompt) || prompt.length === 0) return "";
  // Modern ComfyUI history stores prompt as [number, prompt_id, graphObject,
  // extra...] (older builds: [[nodeId, node], ...]). Scan every element and treat
  // any entry shaped {class_type, inputs} as a node, so wrapper objects like
  // {"create_time": ...} are skipped and the real graph is found wherever it sits.
  let fallback = "";
  for (const el of prompt) {
    if (!el || typeof el !== "object") continue;
    const nodes: Array<[string, Record<string, unknown>]> = Array.isArray(el)
      ? el as Array<[string, Record<string, unknown>]>
      : Object.entries(el as Record<string, Record<string, unknown>>);
    for (const [, node] of nodes) {
      if (!node || typeof node !== "object" || typeof node.class_type !== "string") continue;
      const inputs = (node.inputs || {}) as Record<string, unknown>;
      if (typeof inputs.text === "string" && inputs.text.trim()) {
        if (node.class_type === "CLIPTextEncode") return inputs.text.trim();
        if (!fallback) fallback = inputs.text.trim();
      }
      if (typeof inputs.positive === "string" && inputs.positive.trim()) return inputs.positive.trim();
    }
  }
  return fallback;
}

function historyCreated(status: { status_str?: string; completed?: number | boolean; messages?: unknown[] } | undefined): string {
  // Some ComfyUI builds set completed=true (boolean); the ms timestamp then lives
  // in the execution_success message. Others set completed to a ms timestamp.
  const completed = status?.completed;
  if (typeof completed === "number" && completed > 1_000_000_000_000) return new Date(completed).toISOString();
  for (const m of status?.messages ?? []) {
    if (Array.isArray(m) && m[0] === "execution_success" && m[1] && typeof m[1] === "object") {
      const ts = (m[1] as Record<string, unknown>).timestamp;
      if (typeof ts === "number") return new Date(ts).toISOString();
    }
  }
  return new Date().toISOString();
}

export const Route = createFileRoute("/api/media/comfy")({
  server: {
    handlers: {
      GET: async () => {
        if (!comfyConfigured()) {
          return json({ configured: false, entries: [], count: 0, error: "COMFYUI_BASE_URL not set" });
        }
        const c = new AbortController();
        const timer = setTimeout(() => c.abort(), 15_000);
        try {
          const r = await fetch(`${comfyBaseUrl()}/history?max_items=50`, { signal: c.signal });
          if (!r.ok) return json({ configured: true, entries: [], count: 0, error: `ComfyUI HTTP ${r.status}` });
          const hist = await r.json() as Record<string, {
            prompt?: unknown;
            outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }>; video?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
            status?: { status_str?: string; completed?: number; messages?: unknown[] };
          }>;
          const entries: Array<Record<string, unknown>> = [];
          for (const [promptId, entry] of Object.entries(hist)) {
            if (!entry || entry.status?.status_str === "error") continue;
            const title = (extractPositivePrompt(entry.prompt).slice(0, 80).trim() || "Render");
            const created = historyCreated(entry.status);
            for (const out of Object.values(entry.outputs || {})) {
              for (const f of [...(out.images || []), ...(out.video || [])]) {
                if (!f?.filename) continue;
                entries.push({
                  prompt_id: promptId,
                  title,
                  filename: f.filename,
                  subfolder: f.subfolder || "",
                  type: f.type || "output",
                  kind: comfyKindOf(f.filename),
                  created,
                });
              }
            }
          }
          entries.sort((a, b) => String(b.created).localeCompare(String(a.created)));
          return json({ configured: true, entries, count: entries.length });
        } catch (e) {
          return json({ configured: true, entries: [], count: 0, error: e instanceof Error ? e.message : String(e) });
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
