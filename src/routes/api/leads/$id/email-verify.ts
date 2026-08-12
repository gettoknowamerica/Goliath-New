import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// POST /api/leads/:id/email-verify {verified: 1|0} — approve/reject a lead's
// promoted email. Only leads with email_verified=1 become drip-eligible.
export const Route = createFileRoute("/api/leads/$id/email-verify")({ server: { handlers: { POST: async ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  try {
    const segs = new URL(request.url).pathname.split("/").filter(Boolean);
    const id = Number(segs[segs.length - 2]);
    if (!Number.isFinite(id)) return json({ error: "Invalid lead id" }, 400);
    const body = await request.json() as { verified?: unknown };
    const verified = body.verified === 1 || body.verified === true ? 1 : 0;
    const lead = db.query<any>("SELECT id, contact_name, email, email_source_url, email_verified, town, score FROM imported_leads WHERE id=?").get(id);
    if (!lead) return json({ error: "Lead not found" }, 404);
    db.run("UPDATE imported_leads SET email_verified=? WHERE id=?", verified, id);
    return json({ ...lead, email_verified: verified });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
} } } });
