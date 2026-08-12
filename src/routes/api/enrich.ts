import { createFileRoute } from "@tanstack/react-router";
import { startEnrichRun } from "~/enrich-worker";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// POST /api/enrich now ONLY starts a background run and returns immediately
// (well under a second). The worker (src/enrich-worker.ts) processes leads one
// at a time behind the scenes; poll GET /api/enrich/status for progress and
// POST /api/enrich/stop to stop. No request ever stays open long enough for
// the hosting proxy (~2 min) to kill it.
const MAX_BATCH = 25;
export const Route = createFileRoute("/api/enrich")({ server: { handlers: { POST: async ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  try {
    const body = await request.json() as { all?: unknown; limit?: unknown };
    const all = body.all === true;
    const requested = Number(body.limit);
    const hasLimit = Number.isFinite(requested) && requested > 0;
    if (!all && !hasLimit) return json({ error: "all:true or a positive limit is required" }, 400);
    const mode = hasLimit ? "batch" : "all";
    const limit = hasLimit ? Math.min(MAX_BATCH, Math.floor(requested)) : undefined;
    const { runId, alreadyRunning } = startEnrichRun({ mode, limit });
    return json({ runId, status: "running", alreadyRunning });
  } catch { return json({ error: "Invalid request" }, 400); }
} } } });
