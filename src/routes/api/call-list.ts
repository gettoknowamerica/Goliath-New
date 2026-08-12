import { createFileRoute } from "@tanstack/react-router";
import { getUserFromRequest, unauthorized } from "~/auth";
import { callListRows, socialsLabel, contextLabel } from "~/call-list-export";

// Call-list CSV export. Rows come from the shared builder (src/call-list-export.ts)
// so CSV and PDF can never drift; DNC suppression is re-applied at export time
// against the live dnc_entries table (see builder). Columns include the new
// enrichment surface: email (+source), socials, and personal-context notes.
export const Route = createFileRoute("/api/call-list")({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        const leads = callListRows();
        const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const header = [
          "score", "source", "contact_name", "phone", "phone_source",
          "email", "email_source", "socials", "context",
          "town", "property_address", "agent_attached", "market_status",
          "never_relisted", "score_summary",
        ];
        const lines = [
          header.join(","),
          ...leads.map(l => {
            const summary =
              Object.entries(l.score_breakdown ? JSON.parse(l.score_breakdown) : {})
                .map(([k, v]) => `${k}: ${v}`).join("; ") +
              (l.enriched_source ? `; Web source: ${l.enriched_source}` : "") +
              (l.email_source_url ? `; Email source: ${l.email_source_url}` : "");
            return [
              l.score, l.source, l.contact_name, l.phone, l.phone_source,
              l.email, l.email_source,
              socialsLabel(l.socials || []),
              contextLabel(l.context || []),
              l.town, l.property_address, l.agent_attached || 0,
              l.market_status || "", l.never_relisted || 0, summary,
            ].map(esc).join(",");
          }),
        ];
        return new Response(lines.join("\r\n") + "\r\n", {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": "attachment; filename=leadforge-call-list.csv",
          },
        });
      },
    },
  },
});
