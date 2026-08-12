// Ollama — the local AI brain connection layer.
//
// This is the connection layer for ALL future local-AI features (Kokoro chat,
// AI-assisted drafting, local enrichment scoring, …). It talks to Ollama's
// NATIVE API (not the OpenAI-compat /v1 surface — that one is used separately
// by src/email.ts via OLLAMA_URL and is intentionally left untouched).
//
// Honesty rules (GOLIATH-OMNI-CAPABILITIES.md):
//  - Every call fails GRACEFULLY with a clear error string; we never invent
//    tool output and never pretend a model answered when it did not.
//  - A health shape is available to every feature via the same helpers below:
//    if Ollama is down, features report NEEDS_TOOL_ACCESS/Ollama-unreachable
//    instead of fabricating.
//
// Env:
//   OLLAMA_BASE_URL  default http://localhost:11434
//   OLLAMA_MODEL     default llama3.1:8b  (8B-class fits the RTX 3080 10GB;
//                    Glimmer 30B Q4 ~18GB does NOT fit 10GB VRAM — see README)
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

export type OllamaModelInfo = { name: string; size?: number; digest?: string };

export type OllamaResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** GET {OLLAMA_BASE_URL}/api/tags — list installed models. */
export async function listModels(): Promise<OllamaResult<OllamaModelInfo[]>> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return err(`Ollama /api/tags returned HTTP ${res.status} (is Ollama running on ${OLLAMA_BASE_URL}?)`);
      }
      const body = (await res.json()) as { models?: Array<{ name: string; size?: number; digest?: string }> };
      return { ok: true, data: body.models ?? [] };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(
      `Ollama unreachable at ${OLLAMA_BASE_URL} (${msg}). Start Ollama (or set OLLAMA_BASE_URL). ` +
        `Status: NEEDS_TOOL_ACCESS — Ollama not reachable.`,
    );
  }
}

export type OllamaChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** POST {OLLAMA_BASE_URL}/api/chat with OLLAMA_MODEL. Returns the reply text. */
export async function chat(
  messages: OllamaChatMessage[],
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<OllamaResult<string>> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: { temperature: opts.temperature ?? 0.7 },
        }),
      });
      if (!res.ok) {
        return err(`Ollama /api/chat returned HTTP ${res.status} (model "${OLLAMA_MODEL}" present? try: ollama pull ${OLLAMA_MODEL})`);
      }
      const body = (await res.json()) as { message?: { content?: string } };
      const content = body.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        return err(`Ollama /api/chat returned an empty reply (model "${OLLAMA_MODEL}").`);
      }
      return { ok: true, data: content };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(
      `Ollama unreachable at ${OLLAMA_BASE_URL} (${msg}). Status: NEEDS_TOOL_ACCESS — Ollama not reachable.`,
    );
  }
}

/** One-shot convenience: does the configured model exist locally? */
export async function modelInstalled(): Promise<OllamaResult<boolean>> {
  const res = await listModels();
  if (!res.ok) return res;
  return { ok: true, data: res.data.some((m) => m.name === OLLAMA_MODEL) };
}
