import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { renderCallSheetPDF } from "~/call-sheet-pdf";
import { getUserFromRequest, unauthorized } from "~/auth";

// Same query as /api/call-list (CSV) — must stay in sync.
const QUERY = `SELECT l.*, e.phone AS enriched_phone, e.source_url AS enriched_source FROM imported_leads l LEFT JOIN enriched_contacts e ON e.id=(SELECT id FROM enriched_contacts WHERE lead_id=l.id AND phone IS NOT NULL AND phone!='' AND dnc_matched=0 ORDER BY id ASC LIMIT 1) WHERE l.dnc_matched=0 AND l.agent_attached=0 AND l.listed_active=0 AND l.listed_pending=0 AND l.closed_recently=0 AND l.source NOT IN ('active','pending','closed') AND (COALESCE(NULLIF(l.phone,''),e.phone) IS NOT NULL) AND COALESCE(NULLIF(l.phone,''),e.phone)!='' ORDER BY l.score DESC,l.id DESC`;

export const Route = createFileRoute("/api/call-list/pdf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const sample = Number(u.searchParams.get("sample") || 0);
          let sql = QUERY;
          if (sample > 0) sql += ` LIMIT ${Math.min(Math.max(1, Math.floor(sample)), 50)}`;
          const leads = db.query<any>(sql).all();
          const buf = await renderCallSheetPDF(
            leads,
            sample > 0 ? { title: "LeadForge Call Sheet — SAMPLE" } : {},
          );
          return new Response(new Uint8Array(buf), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": "attachment; filename=leadforge-call-sheet.pdf",
            },
          });
        } catch (e) {
          return new Response(
            `PDF generation failed: ${e instanceof Error ? e.message : "unknown error"}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        }
      },
    },
  },
});
