// DNC data repair (2026-08-19): the 30,504 dnc_entries rows were imported from a
// CSV whose phone/email columns weren't recognized, so `phone`/`email` are NULL
// and every number lives only in the `raw` JSON as `{"203":"203","0000000":"0019403"}`
// (CT area code "203" + a 7-digit subscriber number). Because enrichment-time
// suppression (enrich.ts dnc()) and call-list/export re-checks read
// dnc_entries.phone/email, DNC was effectively matching NOTHING. This repairs the
// phone column reconstructing "203"+<7-digit value> from the 100%-consistent shape.
// Idempotent + gated by app_flags 'dnc_phone_repaired'. Run: bun scripts/repair-dnc-phones.ts
import { db } from "../src/db";
import { digits } from "../src/import-scoring";

const flag = "dnc_phone_repaired";
if (db.query<any>("SELECT value FROM app_flags WHERE key=?").get(flag)) {
  console.log("DNC repair already applied (app_flags marker present). Skipping.");
  process.exit(0);
}
const rows = db.query<any>("SELECT id, raw, phone FROM dnc_entries WHERE (phone IS NULL OR phone='') AND raw IS NOT NULL").all();
let repaired = 0, skipped = 0, duplicates = 0;
const seen = new Set<string>();
const stmt = db.prepare("UPDATE dnc_entries SET phone=? WHERE id=?");
for (const r of rows) {
  let o: any; try { o = JSON.parse(r.raw); } catch { skipped++; continue; }
  const keys = Object.keys(o);
  if (o["203"] !== undefined && o["0000000"] !== undefined && o["203"] !== null) {
    const phone = String(o["203"]) + String(o["0000000"]);
    const norm = digits(phone);
    if (norm.length === 10) {
      if (seen.has(norm)) { duplicates++; continue; }
      seen.add(norm);
      stmt.run(phone, r.id);
      repaired++;
      continue;
    }
  }
  skipped++;
}
db.run("INSERT INTO app_flags (key, value, created_at) VALUES (?, ?, ?)", flag, String(repaired), new Date().toISOString());
console.log(`DNC phone repair done: repaired=${repaired} skipped=${skipped} duplicateRowsMatched=${duplicates}`);
console.log(`dnc_entries total=${db.query("SELECT COUNT(*) n FROM dnc_entries").get().n} withPhone=${db.query("SELECT COUNT(*) n FROM dnc_entries WHERE phone IS NOT NULL AND phone!=''").get().n}`);
process.exit(0);
