import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/never-relisted")({
  server: { handlers: { GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized();
    const count = Number((db.query<any>("SELECT COUNT(*) AS n FROM imported_leads WHERE never_relisted=1").get()?.n) || 0);
    const totalFailedListings = Number((db.query<any>("SELECT COUNT(*) AS n FROM imported_leads WHERE source IN ('expired','cancelled','withdrawn')").get()?.n) || 0);
    // Failed-listing rows that carry no usable property/mailing address: we cannot
    // tell whether they ever came back, so they are "unverified", not "never relisted".
    const unverified = Number((db.query<any>(`SELECT COUNT(*) AS n FROM imported_leads
      WHERE source IN ('expired','cancelled','withdrawn')
      AND COALESCE(NULLIF(TRIM(property_address), ''), NULLIF(TRIM(mailing_address), '')) IS NULL`).get()?.n) || 0);
    const byTown = db.query<any>("SELECT COALESCE(NULLIF(TRIM(town),''),'Unknown') AS town, COUNT(*) AS count FROM imported_leads WHERE never_relisted=1 GROUP BY COALESCE(NULLIF(TRIM(town),''),'Unknown') ORDER BY count DESC, town ASC").all();
    return json({ count, byTown, totalFailedListings, unverified });
  } } }
});
