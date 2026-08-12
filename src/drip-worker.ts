// Background drip-email worker (outreach stage 2). POST /api/drip/start enqueues
// eligible leads into drip_queue (one row per campaign step, scheduled at
// now + delay_days) and returns the runId immediately; a module-level singleton
// worker then processes due rows in the background, exactly like src/enrich-worker
// (clients poll GET /api/drip/status; POST /api/drip/stop is cooperative; POST
// /api/drip/tick forces a pass over due rows right now for verification).
//
// SAFETY: dry_run defaults to TRUE everywhere. A dry_run run renders the email,
// writes a send_log row with status 'dry_run' and NEVER calls Resend. Real sends
// happen only when dry_run=false is explicitly passed by the caller (owner sign-off
// required before any real send). DNC suppression is absolute and re-checked at
// send time — by email AND by digit-normalized phone — every single send.
import { db } from "~/db";
import { draftLeadEmail, fromAddress, unsubscribeUrl } from "~/email";
import { digits, emailNorm } from "~/import-scoring";
import { lookupMarketBlog, marketBlogTemplate } from "~/content";

export type DripRunRow = {
  id: number; campaign_id: number | null; status: string; mode: string | null;
  dry_run: number; limit: number | null; enqueued: number; processed: number; sent: number;
  skipped: number; suppressed: number; failed: number; error: string | null;
  stop_requested: number; created_at: string; updated_at: string; finished_at: string | null;
};

const now = () => new Date().toISOString();
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

// ── DNC index ─────────────────────────────────────────────────────────────────
// dnc_entries stores the phone DNC list with the number inside the `raw` JSON
// column (e.g. {"203":"203","0000000":"0019403"} — concatenating the values
// reconstructs the full 11-digit number). Build an in-memory index of normalized
// phones + emails once per server life; matches use digits()/emailNorm() exactly
// like the existing enrichment/import DNC checks.
type DncIndex = { phones: Set<string>; emails: Set<string> };
function buildDncIndex(): DncIndex {
  const phones = new Set<string>(), emails = new Set<string>();
  for (const d of db.query<any>("SELECT phone, email, raw FROM dnc_entries").all()) {
    if (d.phone) { const v = digits(d.phone); if (v) phones.add(v); }
    if (d.email) emails.add(emailNorm(d.email));
    if (d.raw) {
      try {
        const raw = JSON.parse(d.raw);
        if (raw && typeof raw === "object") {
          const values = Object.values(raw).filter((v): v is string => typeof v === "string");
          for (const v of values) {
            const e = emailNorm(v);
            if (e.includes("@") && e.includes(".")) emails.add(e);
            const p = digits(v);
            if (p.length >= 7) phones.add(p);
          }
          // Legacy phone rows: {"203":"203","0000000":"0019403"} — joined values
          // reconstruct the full number.
          const concat = digits(values.join(""));
          if (concat.length >= 7) phones.add(concat);
        } else if (typeof raw === "string") {
          const e = emailNorm(raw);
          if (e.includes("@")) emails.add(e);
          const p = digits(raw);
          if (p.length >= 7) phones.add(p);
        }
      } catch { /* not JSON — ignore */ }
    }
  }
  return { phones, emails };
}
let dncIndex: DncIndex | null = null;
const dnc = () => (dncIndex ??= buildDncIndex());
export function inDnc(email?: string | null, phone?: string | null): boolean {
  if (email && String(email).trim() && dnc().emails.has(emailNorm(email))) return true;
  if (phone && String(phone).trim()) { const p = digits(phone); if (p && dnc().phones.has(p)) return true; }
  return false;
}

// ── Template rendering ────────────────────────────────────────────────────────
// A step with an EMPTY html_template uses the standard intro drafter
// (draftLeadEmail from src/email.ts — the same personalization/subject as
// /api/email/draft). Non-empty templates get token replacement; every rendered
// email carries the same unsubscribe link construction as email/draft.ts.
function renderStep(step: any, lead: any): Promise<{ subject: string; html: string }> {
  if (!String(step.html_template || "").trim()) return draftLeadEmail(lead);
  const first = String(lead.contact_name || "").split(/\s+/)[0] || "there";
  const town = String(lead.town || "your area");
  const values: Record<string, string> = {
    "{first_name}": esc(first),
    "{name}": esc(String(lead.contact_name || "")),
    "{town}": esc(town),
    "{property_address}": esc(String(lead.property_address || "")),
    "{email}": esc(String(lead.email || "")),
    "{unsubscribe}": unsubscribeUrl(String(lead.email || "")),
  };
  const repl = (s: string) => s.replace(/\{first_name\}|\{name\}|\{town\}|\{property_address\}|\{email\}|\{unsubscribe\}/g, m => values[m] ?? m);
  return Promise.resolve({ subject: repl(String(step.subject_template || "")), html: repl(String(step.html_template || "")) });
}

// ── Per-row send ──────────────────────────────────────────────────────────────
// Re-checks lead validity + DNC (email AND phone) EVERY send, even though the
// enqueue already checked — the queue can sit for days before a row is due.
// A per-send failure returns {outcome:'failed'} and never throws up to the loop.
async function sendDripRow(row: any, run: DripRunRow): Promise<{ outcome: "sent" | "skipped" | "suppressed" | "failed"; logId?: number; error?: string }> {
  const lead = db.query<any>("SELECT * FROM imported_leads WHERE id=?").get(row.lead_id);
  if (!lead || !lead.email || !String(lead.email).trim() || lead.email_verified !== 1) return { outcome: "skipped" };
  if (inDnc(lead.email, lead.phone)) return { outcome: "suppressed" };
  const step = db.query<any>("SELECT * FROM drip_steps WHERE campaign_id=? AND step_order=?").get(row.campaign_id, row.step_order);
  if (!step) return { outcome: "failed", error: "campaign step missing" };
  if (step.status !== "active") return { outcome: "skipped" }; // drafts skip gracefully — no render, no send
  // Step 2 = market blog: inject the real published market-blog post into the
  // template before rendering. Lookup miss → skip the row — placeholder text can
  // NEVER be sent, and the seeded step-2 template is placeholder copy (stays
  // 'draft' until the owner flips it active). renderStep still performs the
  // {town}/{unsubscribe} token replacement on the injected HTML.
  let stepForRender: any = step;
  if (row.step_order === 2) {
    const post = lookupMarketBlog(lead);
    if (!post) return { outcome: "skipped", error: "no published market-blog post" };
    stepForRender = { ...step, html_template: marketBlogTemplate(post, lead) };
  }
  const totalSteps = Number(db.query<any>("SELECT COUNT(*) n FROM drip_steps WHERE campaign_id=?").get(row.campaign_id)?.n || 1);
  const draft = await renderStep(stepForRender, lead);
  const subject = `[Drip ${row.step_order}/${totalSteps}] ${draft.subject}`;
  const email = String(lead.email).trim();
  if (run.dry_run === 1) {
    // DRY RUN: render + log only. Resend is NEVER called on this path.
    const r = db.run("INSERT INTO send_log(lead_id,recipient_email,subject,status,sent_at) VALUES(?,?,?,?,?)", row.lead_id, email, subject, "dry_run", now());
    return { outcome: "sent", logId: Number(r.lastInsertRowid) };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY || ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: [email], subject, html: draft.html }),
    });
    const data = await response.json().catch(() => ({})) as any;
    const ok = response.ok;
    const r = db.run("INSERT INTO send_log(lead_id,recipient_email,subject,status,message_id,error,sent_at) VALUES(?,?,?,?,?,?,?)", row.lead_id, email, subject, ok ? "sent" : "failed", ok ? (data?.id ?? null) : null, ok ? null : JSON.stringify(data), now());
    return ok ? { outcome: "sent", logId: Number(r.lastInsertRowid) } : { outcome: "failed", error: JSON.stringify(data) };
  } catch (e) {
    db.run("INSERT INTO send_log(lead_id,recipient_email,subject,status,error,sent_at) VALUES(?,?,?,?,?,?)", row.lead_id, email, subject, "failed", e instanceof Error ? e.message : String(e), now());
    return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

// Any 'running' row from a previous server life is dead — mark it interrupted on
// module init so status never reports a stale active run.
db.run("UPDATE drip_runs SET status='interrupted', updated_at=?, finished_at=? WHERE status='running'", now(), now());

let workerActive = false;
function activeRun(): DripRunRow | null { return db.query<DripRunRow>("SELECT * FROM drip_runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() ?? null; }
function latestRun(): DripRunRow | null { return db.query<DripRunRow>("SELECT * FROM drip_runs ORDER BY id DESC LIMIT 1").get() ?? null; }

export function campaignIdFor(nameOrId: string | number): number | null {
  if (/^\d+$/.test(String(nameOrId))) { const r = db.query<any>("SELECT id FROM drip_campaigns WHERE id=?").get(Number(nameOrId)); if (r) return r.id; }
  const r = db.query<any>("SELECT id FROM drip_campaigns WHERE name=?").get(String(nameOrId));
  return r ? r.id : null;
}

// Enqueue eligible leads (email set + verified, not in DNC, not already queued
// for this campaign+step) ordered by score DESC. Every step of the campaign gets
// a row per lead, scheduled at now + delay_days. Returns rows inserted.
const MAX_ENQUEUE_LEADS = 5000;
export function enqueueLeads(campaignId: number, limit: number | null): number {
  const steps = db.query<any>("SELECT * FROM drip_steps WHERE campaign_id=? ORDER BY step_order").all(campaignId);
  if (!steps.length) return 0;
  const rows = db.query<any>("SELECT id, email, phone FROM imported_leads WHERE email IS NOT NULL AND email != '' AND email_verified=1 ORDER BY score DESC, id DESC LIMIT ?").all(MAX_ENQUEUE_LEADS);
  const eligible = rows.filter(r => !inDnc(r.email, r.phone)).slice(0, limit ?? rows.length);
  let inserted = 0;
  for (const step of steps) {
    const queued = new Set<number>(db.query<any>("SELECT lead_id FROM drip_queue WHERE campaign_id=? AND step_order=? AND status != 'skipped'").all(campaignId, step.step_order).map(q => q.lead_id));
    const at = Date.now() + Number(step.delay_days || 0) * 86400000;
    const tuples = eligible.filter(l => !queued.has(l.id)).map(l => [l.id, campaignId, step.step_order, new Date(at).toISOString(), "pending"] as const);
    for (let i = 0; i < tuples.length; i += 500) {
      const chunk = tuples.slice(i, i + 500);
      db.run(`INSERT INTO drip_queue(lead_id,campaign_id,step_order,scheduled_at,status) VALUES ${chunk.map(() => "(?,?,?,?,?)").join(",")}`, ...chunk.flat());
      inserted += chunk.length;
    }
  }
  return inserted;
}

export function startDripRun(opts: { campaign?: string | number; limit?: number | null; dryRun?: boolean }): { runId: number; alreadyRunning: boolean; enqueued: number; campaignId: number | null } {
  const existing = activeRun();
  if (existing) return { runId: existing.id, alreadyRunning: true, enqueued: 0, campaignId: existing.campaign_id };
  const campaignId = campaignIdFor(opts.campaign ?? "seller-nurture");
  if (!campaignId) throw new Error("Campaign not found");
  const dryRun = opts.dryRun !== false; // dry_run is the DEFAULT — never send unless explicitly disabled
  const limit = opts.limit != null && Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.floor(Number(opts.limit))) : null;
  const enqueued = enqueueLeads(campaignId, limit);
  const r = db.run("INSERT INTO drip_runs(campaign_id,status,mode,dry_run,\"limit\",enqueued,processed,sent,skipped,suppressed,failed,error,stop_requested,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,?,0,0,0,0,0,NULL,0,?,?,NULL)", campaignId, "running", "drip", dryRun ? 1 : 0, limit, enqueued, now(), now());
  const runId = Number(r.lastInsertRowid);
  if (!workerActive) { workerActive = true; runWorker().catch(() => { workerActive = false; }); }
  return { runId, alreadyRunning: false, enqueued, campaignId };
}

export function tickDripRun(opts: { dryRun?: boolean } = {}): { runId: number; alreadyRunning: boolean } {
  const existing = activeRun();
  if (existing) return { runId: existing.id, alreadyRunning: true };
  const dryRun = opts.dryRun !== false;
  const r = db.run("INSERT INTO drip_runs(campaign_id,status,mode,dry_run,enqueued,processed,sent,skipped,suppressed,failed,error,stop_requested,created_at,updated_at,finished_at) VALUES(NULL,?,?,?,0,0,0,0,0,0,NULL,0,?,?,NULL)", "running", "tick", dryRun ? 1 : 0, now(), now());
  const runId = Number(r.lastInsertRowid);
  if (!workerActive) { workerActive = true; runWorker().catch(() => { workerActive = false; }); }
  return { runId, alreadyRunning: false };
}

async function runWorker(): Promise<void> {
  try {
    let run = activeRun();
    while (run) {
      if (run.stop_requested) {
        db.run("UPDATE drip_runs SET status='stopped', finished_at=?, updated_at=? WHERE id=?", now(), now(), run.id);
        break;
      }
      const due = db.query<any>("SELECT * FROM drip_queue WHERE status='pending' AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT 100").all(now());
      if (!due.length) {
        db.run("UPDATE drip_runs SET status='done', finished_at=?, updated_at=? WHERE id=?", now(), now(), run.id);
        break;
      }
      for (const row of due) {
        try {
          const res = await sendDripRow(row, run);
          const qStatus = res.outcome === "sent" ? "sent" : res.outcome;
          db.run("UPDATE drip_queue SET status=?, sent_at=?, send_log_id=? WHERE id=?", qStatus, res.outcome === "sent" ? now() : null, res.logId ?? null, row.id);
          db.run("UPDATE drip_runs SET processed=processed+1, sent=sent+?, skipped=skipped+?, suppressed=suppressed+?, failed=failed+?, error=?, updated_at=? WHERE id=?", res.outcome === "sent" ? 1 : 0, res.outcome === "skipped" ? 1 : 0, res.outcome === "suppressed" ? 1 : 0, res.outcome === "failed" ? 1 : 0, res.error ?? run.error, now(), run.id);
        } catch (e) {
          // A per-send failure must never kill the loop.
          db.run("UPDATE drip_queue SET status='failed' WHERE id=?", row.id);
          db.run("UPDATE drip_runs SET processed=processed+1, failed=failed+1, error=?, updated_at=? WHERE id=?", e instanceof Error ? e.message : String(e), now(), run.id);
        }
      }
      run = activeRun();
    }
  } catch (e) {
    const run = activeRun();
    if (run) db.run("UPDATE drip_runs SET status='error', error=?, finished_at=?, updated_at=? WHERE id=?", e instanceof Error ? e.message : String(e), now(), now(), run.id);
  } finally {
    workerActive = false;
  }
}

export function dripStatus() {
  const run = latestRun();
  let campaignId: number | null = run?.campaign_id ?? null;
  if (!campaignId) { const s = db.query<any>("SELECT id FROM drip_campaigns WHERE name='seller-nurture'").get(); campaignId = s?.id ?? null; }
  const camArgs = campaignId != null ? [campaignId] : [];
  const counts: Record<string, number> = { pending: 0, sent: 0, skipped: 0, failed: 0, suppressed: 0 };
  for (const c of db.query<any>(`SELECT status, COUNT(*) n FROM drip_queue${campaignId != null ? " WHERE campaign_id=?" : ""} GROUP BY status`).all(...camArgs)) counts[c.status] = Number(c.n);
  const nextRow = campaignId != null
    ? db.query<any>("SELECT MIN(scheduled_at) m FROM drip_queue WHERE campaign_id=? AND status='pending'").get(campaignId)
    : db.query<any>("SELECT MIN(scheduled_at) m FROM drip_queue WHERE status='pending'").get();
  const steps = campaignId != null ? db.query<any>("SELECT step_order, delay_days, status FROM drip_steps WHERE campaign_id=? ORDER BY step_order").all(campaignId) : [];
  return {
    runId: run?.id ?? null,
    status: run?.status ?? "idle",
    mode: run?.mode ?? null,
    dryRun: run ? run.dry_run === 1 : null,
    limit: run?.limit ?? null,
    enqueued: run?.enqueued ?? 0,
    processed: run?.processed ?? 0,
    sent: run?.sent ?? 0,
    skipped: run?.skipped ?? 0,
    suppressed: run?.suppressed ?? 0,
    failed: run?.failed ?? 0,
    error: run?.error ?? null,
    startedAt: run?.created_at ?? null,
    updatedAt: run?.updated_at ?? null,
    finishedAt: run?.finished_at ?? null,
    campaignId,
    queueCounts: counts,
    nextScheduledAt: nextRow?.m ?? null,
    steps,
  };
}

export function stopDripRun() {
  const run = activeRun();
  if (!run) return { ok: true, stopped: false, runId: null };
  db.run("UPDATE drip_runs SET stop_requested=1, updated_at=? WHERE id=?", now(), run.id);
  return { ok: true, stopped: true, runId: run.id };
}
