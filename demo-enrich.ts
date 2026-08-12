// Outreach stage 1 — end-to-end demo on real leads (same code paths the
// background worker uses: enrichOne → person-gated extract → promoteBestEmail).
// Run from the site dir: bun demo-enrich.ts
import { db } from "./src/db";
import { ENRICH_DEPTH, enrichOne } from "./src/enrich";
import { promoteBestEmail } from "./src/enrich-worker";

// Lean budget for this demo only (production defaults untouched):
(ENRICH_DEPTH as { maxQueryAngles: number }).maxQueryAngles = 6;
(ENRICH_DEPTH as { maxCandidatePages: number }).maxCandidatePages = 3;

// 18178 "Vataj Anton" — old finding info@insightscounselinggroup.org looked
// person-matching (page likely mentions him). 17190 "Christine M Korbl" — old
// finding lafsenm@gmail.com was a teachers-union contact page (wrong person;
// the new person-gate should drop it).
const ids = [18178, 17190];
for (const id of ids) {
  const lead = db.query<any>("SELECT * FROM imported_leads WHERE id=?").get(id);
  if (!lead) { console.log(`lead ${id}: NOT FOUND`); continue; }
  const runStartedAt = new Date().toISOString();
  const t0 = Date.now();
  const result = await enrichOne(lead);
  const usable = result.findings.filter((f: any) => !f.dnc_matched);
  const ok = result.errors.length === 0 || result.providers.length > 0;
  if (ok) {
    db.run("UPDATE imported_leads SET enriched_at=? WHERE id=?", new Date().toISOString(), id);
    const promoted = promoteBestEmail(id, runStartedAt);
    const row = db.query<any>("SELECT email, email_source_url, email_verified FROM imported_leads WHERE id=?").get(id);
    console.log(`\nLEAD ${id}: ${lead.contact_name} | ${lead.town} | ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.log(`  queries=${result.queries} providers=${result.providers.join(",") || "none"} errors=${result.errors.length} usable_findings=${usable.length}`);
    for (const f of usable.slice(0, 6)) console.log(`    ${f.email ? "email " + f.email : f.phone ? "phone " + f.phone : "social " + f.socials[0]?.url}  <- ${f.source_url}`);
    console.log(`  promoted_email=${promoted || "(none)"} | row: email=${row.email} src=${row.email_source_url} verified=${row.email_verified}`);
  } else {
    console.log(`\nLEAD ${id}: provider failure — no stamp, no promotion (retried on next run)`);
  }
}
console.log("\ndemo done");
process.exit(0);
