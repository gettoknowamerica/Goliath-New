import { createFileRoute } from "@tanstack/react-router";
import { json } from "../-helpers";
import { listModels, OLLAMA_MODEL } from "~/lib/ollama";

// GET /api/ai/health — Ollama connection status for the local AI brain.
// Returns { ollamaReachable, models[], model, baseUrl } — no secrets.
// Intentionally lightweight and honest: when Ollama is down it reports
// reachable:false with the reason; it never fabricates models.
export const Route = createFileRoute("/api/ai/health")({
  server: {
    handlers: {
      GET: async () => {
        const res = await listModels();
        return json({
          ollamaReachable: res.ok,
          models: res.ok ? res.data.map((m) => m.name) : [],
          model: OLLAMA_MODEL,
          baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
          error: res.ok ? null : res.error,
          note: res.ok
            ? `Ollama reachable. Configured model: ${OLLAMA_MODEL}.`
            : "NEEDS_TOOL_ACCESS — start Ollama on the home PC (or set OLLAMA_BASE_URL).",
        });
      },
    },
  },
});
