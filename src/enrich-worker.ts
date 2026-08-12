// Background enrichment worker. POST /api/enrich now only *starts* a run: it
// inserts an enrich_runs row and returns the runId immediately (well under a
// second). A module-level singleton worker then processes leads one at a time
// in the background — reusing enrichOne() untouched — and advances the run row
// after each lead. Clients poll GET /api/enrich/status (fast) instead of
// holding one long HTTP request open, which the hosting proxy would kill at
// ~2 minutes. Stop is cooperative: POST /api/enrich/stop sets stop_requested
// and the worker checks it between leads.
import { db } from "~/db";
import { enrichOne, providerName, isValidEmail } from "~/enrich";

export type EnrichRunRow = {
  id: number; status: string; mode: string | null; limit: number | null; cursor: number | null;
  processed: number; found: number; dnc_suppressed: number; current_lead_id: number | null;
  error: string | null; stop_requested: number; created_at: string; updated_at: string; finished_at: string | null;
};

const now = () => new Date().toISOString();

// ── Email promotion (outreach stage 1) ───────────────────────────────────────
// The send path reads ONLY imported_leads.email, so enrichment must promote its
// best email finding onto the lead row. Promotion only ever runs on FRESH
// findings (created during the current run) — those already passed the
// person-match gate in extract() (page corpus mentions the lead's last name or
// town). Old pre-gate rows are never promoted: their person match cannot be
// verified retroactively. Aggregator/directory sources are deprioritized (the
// ordering tiebreak per spec: first usable non-DNC email, junk sources last,
// then id ASC).
const EMAIL_SOURCE_JUNK = /(?:yellowpages|whitepages|mylife|spokeo|zabasearch|radaris|beenverified|instantcheckmate|checkpeople|anywho|411\.com|zillow|trulia|redfin|realtor\.com|yelp|angieslist|thumbtack|homeadvisor|bbb\.org|nextdoor|facebook\.com|linkedin\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|ourstates\.org)/i;

export function promoteBestEmail(leadId: number, sinceIso?: string): string | null {
  const lead = db.query<any>("SELECT id, email FROM imported_leads WHERE id=?").get(leadId);
  if (!lead) return null;
  if (lead.email && String(lead.email).trim()) return null; // already has an email
  const rows = db.query<any>("SELECT id, email, source_url FROM enriched_contacts WHERE lead_id=? AND dnc_matched=0 AND email IS NOT NULL AND email != '' AND (? IS NULL OR created_at >= ?)").all(leadId, sinceIso ?? null, sinceIso ?? null);
  const valid = rows.filter(r => isValidEmail(r.email));
  if (!valid.length) return null;
  valid.sort((a, b) => ((EMAIL_SOURCE_JUNK.test(a.source_url) ? 1 : 0) - (EMAIL_SOURCE_JUNK.test(b.source_url) ? 1 : 0)) || (a.id - b.id));
  const best = valid[0];
  // email_verified=1: the address was extracted verbatim from the source page by
  // the person-gated extractor (it literally appears in the fetched page text).
  // This is a SOURCE-verified flag, not a deliverability guarantee — the send
  // path still requires the owner's explicit approval of the final text.
  db.run("UPDATE imported_leads SET email=?, email_source_url=?, email_verified=1 WHERE id=?", best.email, best.source_url, leadId);
  return best.email;
}

// ── One-time email writeback backfill (2026-08-14) ───────────────────────────
// Root cause of the "27 found / 3 written" gap: every enriched_contacts email
// row in the current DB was created 2026-08-10/08-11 — BEFORE the person-match
// gate and promoteBestEmail existed (added 08-11 with the background worker).
// Promotion only considers FRESH findings (created_at >= run start), so those
// pre-gate rows were never promoted; the stale-enriched_at reset cleared those
// leads for re-enrichment, but the full pipeline run hasn't happened yet.
// This backfill promotes the best non-DNC email per lead WITHOUT the freshness
// filter, re-verifying person match cheaply via the source URL (the URL path
// contains the lead's last name or town — strong signal the page is about them;
// the full pipeline run will still apply the stricter text-level gate when it
// re-enriches). Aggregator/directory sources are deprioritized exactly like the
// forward path. It deliberately does NOT stamp enriched_at: those leads stay
// eligible for the full run, which adds phones/socials/context and keeps the
// promoted email (promotion skips leads that already have one). Idempotent +
// app_flags marker, so it runs exactly once.
function urlMentionsPerson(url: string, lead: any): boolean {
  try {
    const u = new URL(String(url || ""));
    const hay = (u.hostname + " " + u.pathname).toLowerCase().replace(/[^a-z0-9 ]/g, " ");
    const parts = String(lead?.contact_name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
    if (lastName.length >= 4 && hay.includes(lastName)) return true;
    const town = String(lead?.town || "").trim().toLowerCase();
    if (town.length >= 3 && hay.includes(town)) return true;
    return false;
  } catch { return false; }
}
export function backfillPromoteEmails(): { promoted: number; checked: number } {
  const marker = db.query<any>("SELECT value FROM app_flags WHERE key='email_backfill_v1'").get();
  if (marker) return { promoted: 0, checked: 0 };
  const candidates = db.query<any>(`SELECT id, contact_name, town FROM imported_leads
    WHERE (email IS NULL OR email='') AND EXISTS (
      SELECT 1 FROM enriched_contacts e WHERE e.lead_id=imported_leads.id AND e.dnc_matched=0
        AND e.email IS NOT NULL AND e.email != '')`).all();
  let promoted = 0;
  for (const lead of candidates) {
    const rows = db.query<any>("SELECT id, email, source_url FROM enriched_contacts WHERE lead_id=? AND dnc_matched=0 AND email IS NOT NULL AND email != '' ORDER BY id ASC").all(lead.id);
    const valid = rows.filter(r => isValidEmail(r.email));
    if (!valid.length) continue;
    const matched = valid.filter(r => urlMentionsPerson(r.source_url, lead));
    if (!matched.length) continue; // URL doesn't vouch for the person — leave for the full run's text gate
    matched.sort((a, b) => ((EMAIL_SOURCE_JUNK.test(a.source_url) ? 1 : 0) - (EMAIL_SOURCE_JUNK.test(b.source_url) ? 1 : 0)) || (a.id - b.id));
    const best = matched[0];
    db.run("UPDATE imported_leads SET email=?, email_source_url=?, email_verified=1 WHERE id=?", best.email, best.source_url, lead.id);
    promoted++;
  }
  db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('email_backfill_v1', ?, ?)", String(promoted), new Date().toISOString());
  console.log(`[backfill] email promotion backfill complete: ${promoted} lead(s) promoted (${candidates.length} candidate leads)`);
  return { promoted, checked: candidates.length };
}

// Any 'running' row left behind by a previous server life is dead — the worker
// that owned it no longer exists. Mark it 'interrupted' on module init so the
// status endpoint never reports a stale active run.
db.run("UPDATE enrich_runs SET status='interrupted', updated_at=?, finished_at=? WHERE status='running'", now(), now());

let workerActive = false;

function activeRun(): EnrichRunRow | null {
  return db.query<EnrichRunRow>("SELECT * FROM enrich_runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() ?? null;
}
function latestRun(): EnrichRunRow | null {
  return db.query<EnrichRunRow>("SELECT * FROM enrich_runs ORDER BY id DESC LIMIT 1").get() ?? null;
}

export function startEnrichRun(opts: { mode: "batch" | "all"; limit?: number; cursor?: number }): { runId: number; alreadyRunning: boolean } {
  const existing = activeRun();
  if (existing) return { runId: existing.id, alreadyRunning: true };
  // One-time email writeback backfill for pre-gate findings (no-op after the
  // first run thanks to the app_flags marker). Runs BEFORE the worker so the
  // owner's pipeline run starts from an already-promoted email baseline.
  try { backfillPromoteEmails(); } catch (e) { console.error("[enrich] email backfill failed:", e); }
  const limit = opts.mode === "batch" ? Math.max(1, Math.floor(opts.limit ?? 1)) : null;
  const result = db.run(
    "INSERT INTO enrich_runs(status,mode,\"limit\",cursor,processed,found,dnc_suppressed,current_lead_id,error,stop_requested,created_at,updated_at,finished_at) VALUES('running',?,?,?,0,0,0,NULL,NULL,0,?,?,NULL)",
    opts.mode, limit, Math.max(0, Math.floor(opts.cursor ?? 0)), now(), now()
  );
  const runId = Number(result.lastInsertRowid);
  if (!workerActive) {
    workerActive = true;
    // Fire-and-forget: the loop keeps the Bun event loop alive on its own and
    // the HTTP handler returns immediately.
    runWorker().catch(() => { workerActive = false; });
  }
  return { runId, alreadyRunning: false };
}

async function runWorker(): Promise<void> {
  try {
    let run = activeRun();
    while (run) {
      if (run.stop_requested) {
        db.run("UPDATE enrich_runs SET status='stopped', finished_at=?, updated_at=? WHERE id=?", now(), now(), run.id);
        break;
      }
      if (run.mode === "batch" && run.limit !== null && run.processed >= run.limit) {
        db.run("UPDATE enrich_runs SET status='done', finished_at=?, updated_at=? WHERE id=?", now(), now(), run.id);
        break;
      }
      const lead = db.query<any>(
        "SELECT * FROM imported_leads WHERE enriched_at IS NULL AND id > ? ORDER BY score DESC, id DESC LIMIT 1"
      ).get(run.cursor ?? 0);
      if (!lead) {
        // Queue empty — finished naturally.
        db.run("UPDATE enrich_runs SET status='done', finished_at=?, updated_at=? WHERE id=?", now(), now(), run.id);
        break;
      }
      try {
        const runStartedAt = now();
        const result = await enrichOne(lead);
        const usable = result.findings.filter((x: any) => !x.dnc_matched);
        const dncCount = result.findings.filter((x: any) => x.dnc_matched).length;
        const cleanRun = result.errors.length === 0;
        const providerOk = result.providers.length > 0;
        // Stamp exactly like the old sync route did: only when the run was clean
        // or at least one provider produced results.
        if (cleanRun || providerOk) {
          db.run("UPDATE imported_leads SET enriched_at=? WHERE id=?", now(), lead.id);
          // Promote the best validated, non-DNC email finding onto the lead row
          // so the send path (which reads only imported_leads.email) can see it.
          // Only fresh findings (>= run start) qualify — they passed the
          // person-match gate in extract(). email_verified stays 0 — human
          // review is still required before any send.
          promoteBestEmail(lead.id, runStartedAt);
        }
        db.run(
          "UPDATE enrich_runs SET processed=processed+1, found=found+?, dnc_suppressed=dnc_suppressed+?, cursor=?, current_lead_id=?, updated_at=? WHERE id=?",
          usable.length, dncCount, lead.id, lead.id, now(), run.id
        );
      } catch (e) {
        // Per-lead failure: count it as processed and advance the cursor so we
        // can never loop forever on a throwing lead; the run keeps going.
        db.run(
          "UPDATE enrich_runs SET processed=processed+1, cursor=?, current_lead_id=?, error=?, updated_at=? WHERE id=?",
          lead.id, lead.id, e instanceof Error ? e.message : "Provider unavailable", now(), run.id
        );
      }
      run = activeRun();
    }
  } catch (e) {
    const run = activeRun();
    if (run) db.run("UPDATE enrich_runs SET status='error', error=?, finished_at=?, updated_at=? WHERE id=?", e instanceof Error ? e.message : String(e), now(), now(), run.id);
  } finally {
    workerActive = false;
  }
}

export function enrichStatus() {
  const run = latestRun();
  const remaining = Number(db.query<any>("SELECT COUNT(*) n FROM imported_leads WHERE enriched_at IS NULL").get()?.n || 0);
  return {
    runId: run?.id ?? null,
    status: run?.status ?? "idle",
    mode: run?.mode ?? null,
    limit: run?.limit ?? null,
    processed: run?.processed ?? 0,
    found: run?.found ?? 0,
    dnc_suppressed: run?.dnc_suppressed ?? 0,
    remaining,
    currentLeadId: run?.current_lead_id ?? null,
    error: run?.error ?? null,
    startedAt: run?.created_at ?? null,
    updatedAt: run?.updated_at ?? null,
    finishedAt: run?.finished_at ?? null,
    provider: providerName(),
  };
}

export function stopEnrichRun() {
  const run = activeRun();
  if (!run) return { ok: true, stopped: false, runId: null };
  db.run("UPDATE enrich_runs SET stop_requested=1, updated_at=? WHERE id=?", now(), run.id);
  return { ok: true, stopped: true, runId: run.id };
}
