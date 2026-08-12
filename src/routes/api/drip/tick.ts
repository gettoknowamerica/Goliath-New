import { createFileRoute } from "@tanstack/react-router";
import { tickDripRun } from "~/drip-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// POST /api/drip/tick {dry_run?} — process any due pending queue rows right now
// (used for verification and manual nudges). Starts a background worker pass if
// none is active; dry_run defaults to true (no Resend calls).
export const Route = createFileRoute("/api/drip/tick")({ server: { handlers: { POST: async ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  try {
    const body = await request.json().catch(() => ({})) as { dry_run?: unknown };
    const { runId, alreadyRunning } = tickDripRun({ dryRun: body.dry_run !== false });
    return json({ runId, status: "running", alreadyRunning, dryRun: body.dry_run !== false });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
} } } });
