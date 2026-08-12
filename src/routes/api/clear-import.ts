import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { refreshMarketFlags, refreshNeverRelisted } from "~/import-scoring";
import { getUserFromRequest, unauthorized } from "~/auth";

// Erase ALL imported leads (absentee + expired) and their enriched findings.
// The DNC list and outreach logs are preserved — only the imported prospect data is cleared,
// so the owner can start fresh with a properly-formatted upload.
export const Route = createFileRoute("/api/clear-import")({
  server: { handlers: { POST: async ({ request }) => { if (!getUserFromRequest(request)) return unauthorized();
    const n = Number((db.query("SELECT COUNT(*) n FROM imported_leads").get() as any)?.n || 0);
    db.run("DELETE FROM imported_leads");
    db.run("DELETE FROM enriched_contacts");
    refreshMarketFlags();
    refreshNeverRelisted();
    return json({ ok: true, deleted: n });
  } } }
});
