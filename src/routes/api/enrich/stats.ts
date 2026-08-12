import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// Enrichment stats (owner 2026-08-14): one dashboard card + pipeline baseline.
// All numbers are computed live from the local SQLite leads.db (.data/leads.db)
// — no Neon/DATABASE_URL path. Definitions:
//   reviewedCount   — leads with enriched_at stamped OR at least one row in
//                     enriched_contacts (reviewed = the sleuth touched them).
//   withPhone       — distinct leads with a non-DNC enriched phone finding.
//   withImportedPhone — distinct leads whose imported row already carried a phone.
//   withEmail       — distinct leads with a non-DNC enriched email finding
//                     (found by the extractor, regardless of promotion).
//   promotedEmails  — imported_leads.email populated (the sendable baseline).
//   withSocials     — distinct leads with ≥1 social profile URL finding.
//   withContext     — distinct leads with personal-context snippets captured.
//   dncSuppressed   — findings/leads suppressed by the DNC list (enriched
//                     contacts flagged + imported leads flagged).
const count = (sql: string, ...args: unknown[]) => Number(db.query<any>(sql).get(...args)?.n || 0);

function socialsHaveUrl(v: unknown): boolean {
  try {
    const arr = JSON.parse(String(v || "[]"));
    return Array.isArray(arr) && arr.length > 0 && arr.some((s: any) => s && s.url);
  } catch { return false; }
}

export const Route = createFileRoute("/api/enrich/stats")({ server: { handlers: { GET: ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  const totalLeads = count("SELECT COUNT(*) n FROM imported_leads");
  const reviewedCount = count(`SELECT COUNT(*) n FROM imported_leads l WHERE l.enriched_at IS NOT NULL OR EXISTS (SELECT 1 FROM enriched_contacts e WHERE e.lead_id=l.id)`);
  const enrichedStamped = count("SELECT COUNT(*) n FROM imported_leads WHERE enriched_at IS NOT NULL");
  const withPhone = count("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND phone IS NOT NULL AND phone!=''");
  const withImportedPhone = count("SELECT COUNT(*) n FROM imported_leads WHERE phone IS NOT NULL AND phone!=''");
  const withEmail = count("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND email IS NOT NULL AND email!=''");
  const promotedEmails = count("SELECT COUNT(*) n FROM imported_leads WHERE email IS NOT NULL AND email!=''");
  const withSocials = count("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND socials IS NOT NULL AND socials!='' AND socials!='[]'");
  const withContext = count("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE context IS NOT NULL AND context!=''");
  const dncSuppressed = count("SELECT COUNT(*) n FROM enriched_contacts WHERE dnc_matched=1") + count("SELECT COUNT(*) n FROM imported_leads WHERE dnc_matched=1");
  const scored70plus = count("SELECT COUNT(*) n FROM imported_leads WHERE score>=70");
  const totalFindings = count("SELECT COUNT(*) n FROM enriched_contacts");
  // Per-source breakdown: totals from imported_leads, finding counts joined in.
  const perSourceTotals = db.query<any>("SELECT source, COUNT(*) total FROM imported_leads GROUP BY source ORDER BY total DESC").all();
  const perSourceEnriched = db.query<any>(`SELECT l.source,
      COUNT(DISTINCT e.lead_id) reviewed,
      COUNT(DISTINCT CASE WHEN e.dnc_matched=0 AND e.phone IS NOT NULL AND e.phone!='' THEN e.lead_id END) withPhone,
      COUNT(DISTINCT CASE WHEN e.dnc_matched=0 AND e.email IS NOT NULL AND e.email!='' THEN e.lead_id END) withEmail,
      COUNT(DISTINCT CASE WHEN e.dnc_matched=0 AND e.socials IS NOT NULL AND e.socials!='' AND e.socials!='[]' THEN e.lead_id END) withSocials
    FROM enriched_contacts e JOIN imported_leads l ON l.id=e.lead_id GROUP BY l.source`).all();
  const enrBySource = new Map<string, any>(perSourceEnriched.map((r: any) => [r.source, r]));
  const perSource = perSourceTotals.map((s: any) => {
    const e = enrBySource.get(s.source) || {};
    return { source: s.source, total: s.total, reviewed: e.reviewed ?? 0, withPhone: e.withPhone ?? 0, withEmail: e.withEmail ?? 0, withSocials: e.withSocials ?? 0 };
  });
  return json({
    totalLeads, reviewedCount, enrichedStamped,
    withPhone, withImportedPhone, withEmail, promotedEmails,
    withSocials, withContext, dncSuppressed, scored70plus, totalFindings,
    perSource, generatedAt: new Date().toISOString(),
  });
} } } });
