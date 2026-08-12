import { createFileRoute } from "@tanstack/react-router";
import { startDripRun } from "~/drip-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// POST /api/drip/start {campaign?, limit?, dry_run?} — enqueue eligible leads for
// a drip campaign and fire the background worker. dry_run DEFAULTS to true: the
// run renders emails and writes send_log rows with status 'dry_run' but NEVER
// calls Resend. Pass dry_run=false explicitly (owner sign-off required) to send.
export const Route = createFileRoute("/api/drip/start")({ server: { handlers: { POST: async ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  try {
    const body = await request.json() as { campaign?: string | number; limit?: unknown; dry_run?: unknown };
    const { runId, alreadyRunning, enqueued, campaignId } = startDripRun({
      campaign: body.campaign,
      limit: body.limit != null ? Number(body.limit) : null,
      dryRun: body.dry_run !== false,
    });
    return json({ runId, status: "running", alreadyRunning, enqueued, campaignId, dryRun: body.dry_run !== false });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
} } } });
