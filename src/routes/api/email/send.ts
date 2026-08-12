import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { draftLeadEmail, fromAddress } from "~/email";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

const ensure = () => { const cols = db.query<any>("PRAGMA table_info(send_log)").all().map(c => c.name); for (const c of ["event_type", "updated_at"]) if (!cols.includes(c)) db.run(`ALTER TABLE send_log ADD COLUMN ${c} TEXT`); };
const emailNorm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const dnc = (email: string) => !!db.query<any>("SELECT id FROM dnc_entries WHERE lower(email)=? LIMIT 1").get(emailNorm(email));
const leadFor = (id: number) => db.query<any>("SELECT * FROM imported_leads WHERE id=?").get(id) || db.query<any>("SELECT * FROM leads WHERE id=?").get(id);

export const Route = createFileRoute("/api/email/send")({ server: { handlers: {
  POST: async ({ request }) => {
    if (!getUserFromRequest(request)) return unauthorized();
    try { const body = await request.json() as any;
      if (body.leadId !== undefined || body.lead) { const lead = body.lead || leadFor(Number(body.leadId)); if (!lead) return json({ error: "Lead not found" }, 404); const draft = await draftLeadEmail(lead); return json({ ...draft, from: fromAddress(), to: lead.email || "" }); }
      const ids: number[] = Array.isArray(body.leadIds) ? body.leadIds.map(Number) : body.leadId !== undefined ? [Number(body.leadId)] : body.allWithEmail ? db.query<any>("SELECT id FROM imported_leads WHERE email IS NOT NULL AND email != '' AND dnc_matched=0 AND agent_attached=0 AND listed_active=0 AND listed_pending=0 AND closed_recently=0 AND source NOT IN ('active','pending','closed') ORDER BY score DESC").all().map(x => x.id) : [];
      if (!ids.length) return json({ error: "Provide leadIds, leadId, or allWithEmail" }, 400);
      ensure(); const result = { attempted: 0, sent: 0, skipped: 0, failed: 0 };
      for (const id of ids) { const lead = leadFor(id); const email = emailNorm(lead?.email); if (!lead || !email || lead.dnc_matched === 1 || lead.agent_attached === 1 || lead.listed_active === 1 || lead.listed_pending === 1 || lead.closed_recently === 1 || ["active","pending","closed"].includes(lead.source) || dnc(email)) { result.skipped++; continue; } result.attempted++; const draft = await draftLeadEmail(lead);
        try { const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY || ""}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: fromAddress(), to: [email], subject: draft.subject, html: draft.html }) }); const data = await response.json().catch(() => ({})) as any; const status = response.ok ? "sent" : "failed"; db.run("INSERT INTO send_log(lead_id,recipient_email,subject,status,message_id,error,sent_at) VALUES(?,?,?,?,?,?,?)", id, email, draft.subject, status, data?.id || null, response.ok ? null : JSON.stringify(data), new Date().toISOString()); if (response.ok) result.sent++; else result.failed++; }
        catch (e) { result.failed++; db.run("INSERT INTO send_log(lead_id,recipient_email,subject,status,error,sent_at) VALUES(?,?,?,?,?,?)", id, email, draft.subject, "failed", e instanceof Error ? e.message : String(e), new Date().toISOString()); }
      } return json(result);
    } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
  }
} } });
