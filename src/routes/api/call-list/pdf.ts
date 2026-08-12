import { createFileRoute } from "@tanstack/react-router";
import { renderCallSheetPDF } from "~/call-sheet-pdf";
import { callListRows } from "~/call-list-export";
import { getUserFromRequest, unauthorized } from "~/auth";

// PDF call sheet — same shared row builder as /api/call-list (CSV) so the two
// exports cannot drift. DNC suppression is applied inside callListRows().
export const Route = createFileRoute("/api/call-list/pdf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const sample = Number(u.searchParams.get("sample") || 0);
          let leads = callListRows();
          if (sample > 0) leads = leads.slice(0, Math.min(Math.max(1, Math.floor(sample)), 50));
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
