// Clean enrichment-run status snapshot (read-only). Writes a JSON line to stdout.
import { db } from "../src/db";
const q = (s: string, ...a: unknown[]) => Number(db.query<any>(s).get(...a)?.n || 0);
const run = db.query<any>("SELECT id,status,mode,processed,found,dnc_suppressed,cursor,startedAt FROM (SELECT *,created_at startedAt FROM enrich_runs) ORDER BY id DESC LIMIT 1").get();
const cp = db.query<any>("SELECT value FROM app_flags WHERE key='enrich_batch_cp'").get()?.value || "(none)";
const out: any = {
  run, cp,
  enrichedAt: q("SELECT COUNT(*) n FROM imported_leads WHERE enriched_at IS NOT NULL"),
  contacts: q("SELECT COUNT(*) n FROM enriched_contacts"),
  distinctLeads: q("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts"),
  withPhoneC: q("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND phone IS NOT NULL AND phone!=''"),
  withEmailC: q("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND email IS NOT NULL AND email!=''"),
  withSocialsC: q("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE dnc_matched=0 AND socials IS NOT NULL AND socials!='[]' AND socials!=''"),
  withContext: q("SELECT COUNT(DISTINCT lead_id) n FROM enriched_contacts WHERE context IS NOT NULL AND context!=''"),
  dncFindings: q("SELECT COUNT(*) n FROM enriched_contacts WHERE dnc_matched=1"),
  emailOnRow: q("SELECT COUNT(*) n FROM imported_leads WHERE email IS NOT NULL AND email!=''"),
};
// Recent rows created this run (last ~15 min)
out.recentContacts = db.query<any>(`SELECT id,lead_id,phone,email,source_url,dnc_matched,created_at FROM enriched_contacts WHERE created_at >= datetime('now','-15 minutes') ORDER BY id DESC LIMIT 12`).all();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
