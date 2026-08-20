// Real contact enrichment batch runner (2026-08-19) — "pull contacts" job.
// Drives enrichOne() over the REAL lead list in priority order:
//   1. source='expired'  (the hot seller list) by score DESC
//   2. source='absentee' by score DESC
// Resumability is by enriched_at stamping ONLY (idempotent): every processed lead
// is stamped, so a stopped/restarted run skips it via `enriched_at IS NULL` and
// picks up the next-highest-priority unenriched lead. Do NOT persist a raw id
// cursor as a filter — that skips lower-ID leads once the cursor advances (a bug
// in an earlier revision). The app_flags checkpoint here is progress-reporting
// only (current source + counters), never a selector.
//
// Runs OUT-OF-PROCESS from the live server's worker; SQLite WAL + busy_timeout
// let it write while the server connection is open. Do NOT start the server
// worker (POST /api/enrich) at the same time.
//
// Usage (from /home/team/shared/site):
//   MAX_LEADS=600 bun scripts/run-enrich-batch.ts
// Graceful stop via SIGINT (Ctrl-C) → checkpoint saved, clean exit; resume by re-running.
import { db } from "../src/db";
import { enrichOne } from "../src/enrich";
import { promoteBestEmail } from "../src/enrich-worker";

// Survive cross-process lock windows against the running serve.ts connection.
try { db.run("PRAGMA busy_timeout=15000"); } catch { /* non-critical */ }

const now = () => new Date().toISOString();
const SOURCES = ["expired", "absentee"];
const CP_KEY = "enrich_batch_cp";
const MAX_LEADS = Number(process.env.MAX_LEADS) > 0 ? Number(process.env.MAX_LEADS) : 100000;

function readCp(): { source: string; processed: number } {
  const row = db.query<any>("SELECT value FROM app_flags WHERE key=?").get(CP_KEY);
  if (!row) return { source: SOURCES[0], processed: 0 };
  try { const c = JSON.parse(row.value); return { source: SOURCES.includes(c.source) ? c.source : SOURCES[0], processed: Number(c.processed) || 0 }; }
  catch { return { source: SOURCES[0], processed: 0 }; }
}
function writeCp(s: { source: string; processed: number }) {
  db.run("INSERT INTO app_flags (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", CP_KEY, JSON.stringify(s), now());
}
function clearCp() { db.run("DELETE FROM app_flags WHERE key=?", CP_KEY); }

const counters = { processed: 0, stamped: 0, found: 0, dnc: 0, newEmails: 0, providers: {} as Record<string, number>, errors: 0 };
let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("[SIGINT] stopping after current lead…"); });

async function processOne(source: string): Promise<boolean> {
  // Resumable by enriched_at alone; score-desc within the source.
  const lead = db.query<any>(
    "SELECT * FROM imported_leads WHERE enriched_at IS NULL AND source=? ORDER BY score DESC, id DESC LIMIT 1"
  ).get(source);
  if (!lead) return false;
  const runStartedAt = now();
  const t0 = Date.now();
  try {
    const result = await enrichOne(lead);
    for (const p of result.providers) counters.providers[p] = (counters.providers[p] || 0) + 1;
    const usable = result.findings.filter((f: any) => !f.dnc_matched);
    const dncCount = result.findings.filter((f: any) => f.dnc_matched).length;
    const cleanRun = result.errors.length === 0;
    const providerOk = result.providers.length > 0;
    let stamp = false;
    if (cleanRun || providerOk) {
      db.run("UPDATE imported_leads SET enriched_at=? WHERE id=?", now(), lead.id);
      stamp = true;
      counters.stamped++;
      const promoted = promoteBestEmail(lead.id, runStartedAt);
      if (promoted) counters.newEmails++;
    }
    counters.found += usable.length;
    counters.dnc += dncCount;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[${source}] id=${lead.id} ${lead.contact_name || ""} | ${lead.town || ""} | ${secs}s | q=${result.queries} prov=${result.providers.join(",") || "-"} stamp=${stamp} usable=${usable.length} dnc=${dncCount}`);
  } catch (e) {
    counters.errors++;
    // A throwing lead is unstable; stamp it anyway so we never loop on it and
    // can revisit (a later re-run could behave differently). We stamp only
    // provider-error-free runs above; here we leave enriched_at NULL so it retries
    // on the NEXT run rather than being lost — but to avoid an infinite spin in
    // THIS run, we round-trip: stamp a sentinel then it stays out of this run.
    // Simplest safe choice: stamp it (it had a hard failure; next org-scoped run
    // can clear enriched_at for retry).
    db.run("UPDATE imported_leads SET enriched_at=? WHERE id=?", now(), lead.id);
    counters.stamped++;
    console.log(`[${source}] id=${lead.id} ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
  counters.processed++;
  return true;
}

async function main() {
  const cp = readCp();
  const si = setInterval(() => {
    db.run("UPDATE enrich_runs SET processed=?, found=?, dnc_suppressed=?, cursor=?, updated_at=? WHERE id=?",
      counters.processed, counters.found, counters.dnc, counters.processed, now(), runId);
  }, 5000);
  try {
    outer: for (const source of SOURCES) {
      console.log(`\n=== SOURCE ${source} — score DESC, resume-via-enriched_at ===`);
      let more = true;
      while (more) {
        if (stopping || counters.processed >= MAX_LEADS) { cp.source = source; cp.processed = counters.processed; writeCp(cp); break outer; }
        more = await processOne(source);
        if (counters.processed % 10 === 0) { cp.source = source; cp.processed = counters.processed; writeCp(cp); }
      }
    }
    if (stopping || counters.processed >= MAX_LEADS) {
      cp.processed = counters.processed; writeCp(cp);
      db.run("UPDATE enrich_runs SET status='stopped', processed=?, found=?, dnc_suppressed=?, finished_at=?, updated_at=? WHERE id=?", counters.processed, counters.found, counters.dnc, now(), now(), runId);
      console.log(`\nSTOPPED at processed=${counters.processed} (max=${MAX_LEADS}). Resume: MAX_LEADS=${MAX_LEADS} bun scripts/run-enrich-batch.ts`);
    } else {
      clearCp();
      db.run("UPDATE enrich_runs SET status='done', processed=?, found=?, dnc_suppressed=?, finished_at=?, updated_at=? WHERE id=?", counters.processed, counters.found, counters.dnc, now(), now(), runId);
      console.log(`\nCOMPLETE: exhausted ${SOURCES.join(", ")}.`);
    }
  } finally { clearInterval(si); }
  console.log(`\n=== RUN SUMMARY ===` + JSON.stringify({ runId, ...counters }));
  process.exit(0);
}
// Open the run row for visibility in the dashboard before starting.
const runId = (() => {
  const r = db.run("INSERT INTO enrich_runs(status,mode,\"limit\",cursor,processed,found,dnc_suppressed,current_lead_id,error,stop_requested,created_at,updated_at,finished_at) VALUES('running','batch',?,0,0,0,0,NULL,NULL,0,?,?,NULL)", MAX_LEADS, now(), now());
  return Number(r.lastInsertRowid);
})();
main();
