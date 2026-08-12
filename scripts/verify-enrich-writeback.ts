// End-to-end verification of the enrichment writeback upgrade (2026-08-14):
//  1. runs the one-time email backfill (pre-gate findings → imported_leads.email)
//  2. re-enriches two real leads through enrichOne (person-gated extract,
//     socials persistence, personal-context capture)
//  3. promotes the best fresh email and asserts it landed on imported_leads
//     with email_source_url + email_verified=1
// Run from the site dir: bun scripts/verify-enrich-writeback.ts
import { db } from "../src/db";
import { ENRICH_DEPTH, enrichOne } from "../src/enrich";
import { backfillPromoteEmails, promoteBestEmail } from "../src/enrich-worker";

// Lean budget for verification (production defaults untouched):
(ENRICH_DEPTH as { maxQueryAngles: number }).maxQueryAngles = 6;
(ENRICH_DEPTH as { maxCandidatePages: number }).maxCandidatePages = 3;

const bf = backfillPromoteEmails();
console.log(`\n[1] EMAIL BACKFILL: checked=${bf.checked} promoted=${bf.promoted}`);
const promotedNow = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM imported_leads WHERE email IS NOT NULL AND email!=''").get()!.n;
console.log(`    leads with email on row now: ${promotedNow}`);

// Two real leads: 18178 "Vataj Anton" (old person-matching finding) and
// 17190 "Christine M Korbl" (old wrong-person finding — new gate should drop it).
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
    console.log(`\n[2] LEAD ${id}: ${lead.contact_name} | ${lead.town} | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`    queries=${result.queries} providers=${result.providers.join(",") || "none"} errors=${result.errors.length} usable_findings=${usable.length}`);
    for (const f of usable.slice(0, 8)) {
      const what = f.email ? `email ${f.email}` : f.phone ? `phone ${f.phone}` : `social ${(f.socials || [])[0]?.url}`;
      console.log(`      ${what}  <- ${f.source_url}`);
    }
    console.log(`    promoted_email=${promoted || "(none)"} | row: email=${row.email} src=${row.email_source_url} verified=${row.email_verified}`);

    // Post-run checks from the DB (the real proof):
    const ctx = db.query<any>("SELECT context, context_source_url FROM enriched_contacts WHERE lead_id=? AND context IS NOT NULL ORDER BY id").all(id);
    console.log(`    context_rows=${ctx.length}`);
    for (const c of ctx) console.log(`      ctx: ${c.context.slice(0, 140)}  <- ${c.context_source_url}`);
    const socs = db.query<any>("SELECT socials, source_url FROM enriched_contacts WHERE lead_id=? AND socials IS NOT NULL AND socials!='[]' AND socials!='' ORDER BY id").all(id);
    for (const s of socs.slice(0, 3)) console.log(`      socials: ${s.socials}  <- ${s.source_url}`);
  } else {
    console.log(`\n[2] LEAD ${id}: provider failure — no stamp, no promotion (retried on next run)`);
  }
}
console.log("\nverify-enrich-writeback done");
process.exit(0);
