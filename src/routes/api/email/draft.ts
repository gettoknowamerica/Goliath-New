import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { draftLeadEmail, fromAddress } from "~/email";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
export const Route = createFileRoute("/api/email/draft")({ server: { handlers: { POST: async ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); try { const b = await request.json() as any; const lead = b.lead || db.query<any>("SELECT * FROM imported_leads WHERE id=?").get(Number(b.leadId)) || db.query<any>("SELECT * FROM leads WHERE id=?").get(Number(b.leadId)); if (!lead) return json({ error: "Lead not found" }, 404); return json({ ...(await draftLeadEmail(lead)), from: fromAddress(), to: lead.email || "" }); } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); } } } } });
