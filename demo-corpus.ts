// Outreach stage 1 — real-corpus end-to-end promotion proof (search step
// bypassed: DDG is down, Bing surfaced nothing). Uses the app's OWN scraper
// (scrapeTrafilatura), extractor (extract with the person gate), the same
// enriched_contacts INSERT enrichOne performs, and promoteBestEmail.
// Run from the site dir: bun demo-corpus.ts
import { db } from "./src/db";
import { extract, scrapeTrafilatura } from "./src/enrich";
import { promoteBestEmail } from "./src/enrich-worker";

const dncRows = db.query<any>("SELECT phone,email FROM dnc_entries").all();
const isDnc = (email?: string, phone?: string) => dncRows.some(r =>
  (r.email && email && String(r.email).trim().toLowerCase() === String(email).trim().toLowerCase()) ||
  (r.phone && phone && String(r.phone).replace(/\D/g, "") === String(phone).replace(/\D/g, "")));

const targets = [
  { id: 2408, url: "https://www.ameripriseadvisors.com/matthew.s.smith/", q: '"Matthew Smith" Westport CT' },
  { id: 2407, url: "https://checkpeople.com/name/Matthew-Andrews/in-CT", q: '"Matthew Andrews" Wilton CT' },
];
for (const t of targets) {
  const lead = db.query<any>("SELECT * FROM imported_leads WHERE id=?").get(t.id);
  if (!lead) { console.log(`lead ${t.id}: NOT FOUND`); continue; }
  console.log(`\nLEAD ${t.id}: ${lead.contact_name} | ${lead.town} | pre-email=${JSON.stringify(lead.email)}`);
  const text = await scrapeTrafilatura(t.url);
  console.log(`  corpus: ${text.length} chars from ${t.url}`);
  const findings = extract([{ url: t.url, text }], t.q, lead);
  console.log(`  extract() findings (person-gated + validated): ${findings.length}`);
  for (const f of findings.slice(0, 8)) console.log(`    ${f.email ? "email " + f.email : f.phone ? "phone " + f.phone : "social " + f.socials[0]?.url}`);
  const sinceIso = new Date().toISOString();
  for (const f of findings) {
    const dncHit = isDnc(f.email, f.phone) ? 1 : 0;
    db.run("INSERT INTO enriched_contacts(lead_id,phone,email,socials,source_url,query,dnc_matched,created_at) VALUES(?,?,?,?,?,?,?,?)",
      t.id, f.phone || null, f.email || null, JSON.stringify(f.socials), f.source_url, t.q, dncHit, new Date().toISOString());
  }
  const promoted = promoteBestEmail(t.id, sinceIso);
  const row = db.query<any>("SELECT email, email_source_url, email_verified FROM imported_leads WHERE id=?").get(t.id);
  console.log(`  promoted_email=${promoted || "(none)"}`);
  console.log(`  imported_leads: email=${row.email} | email_source_url=${row.email_source_url} | email_verified=${row.email_verified}`);
}
console.log("\ndemo done");
process.exit(0);
