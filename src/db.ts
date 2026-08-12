import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hashPassword } from "./password";

export type Lead = {
  id: number; business_type: string; company: string; contact_name: string;
  email: string; phone: string; website: string; industry: string;
  location: string; notes: string; created_at: string;
};

const dataDir = join(process.cwd(), ".data");
mkdirSync(dataDir, { recursive: true });
export const db = new Database(join(dataDir, "leads.db"));
// Concurrent readers/writers (imports, enrichment, the live server, maintenance
// scripts) share this SQLite file. WAL lets readers run during a write and
// busy_timeout makes short lock waits succeed instead of throwing SQLITE_BUSY.
db.run("PRAGMA busy_timeout = 10000");
try { db.run("PRAGMA journal_mode = WAL"); } catch { /* non-critical; caller retries */ }
db.run(`CREATE TABLE IF NOT EXISTS leads (
 id INTEGER PRIMARY KEY, business_type TEXT NOT NULL, company TEXT NOT NULL,
 contact_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
 website TEXT NOT NULL, industry TEXT NOT NULL, location TEXT NOT NULL,
 notes TEXT NOT NULL, created_at TEXT NOT NULL
)`);

// Imported seller data mirrors leadforge_schema.sql (SQLite-native types).
db.run(`CREATE TABLE IF NOT EXISTS imported_leads (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, contact_name TEXT, email TEXT,
 phone TEXT, property_address TEXT, town TEXT, state TEXT, zip TEXT, mailing_address TEXT,
 purchase_year INTEGER, est_value INTEGER, beds INTEGER, baths REAL, sqft INTEGER,
 list_date TEXT, expiry_date TEXT, price_reduced INTEGER NOT NULL DEFAULT 0,
 active_with_agent INTEGER NOT NULL DEFAULT 0, raw TEXT, score REAL NOT NULL DEFAULT 0,
 score_breakdown TEXT, dnc_matched INTEGER NOT NULL DEFAULT 0, agent_attached INTEGER NOT NULL DEFAULT 0,
 listed_active INTEGER NOT NULL DEFAULT 0, listed_pending INTEGER NOT NULL DEFAULT 0,
 closed_recently INTEGER NOT NULL DEFAULT 0, never_relisted INTEGER NOT NULL DEFAULT 0, never_relisted_unverified INTEGER NOT NULL DEFAULT 0, market_status TEXT, enriched_at TEXT, created_at TEXT NOT NULL
 )`);

 // Add columns for databases created by older versions.
 const importedColumns = db.query<any>("PRAGMA table_info(imported_leads)").all().map(c => c.name);
 for (const [name, definition] of [["agent_attached", "INTEGER NOT NULL DEFAULT 0"], ["listed_active", "INTEGER NOT NULL DEFAULT 0"], ["listed_pending", "INTEGER NOT NULL DEFAULT 0"], ["closed_recently", "INTEGER NOT NULL DEFAULT 0"], ["never_relisted", "INTEGER NOT NULL DEFAULT 0"], ["never_relisted_unverified", "INTEGER NOT NULL DEFAULT 0"], ["market_status", "TEXT"], ["enriched_at", "TEXT"], ["email_source_url", "TEXT"], ["email_verified", "INTEGER NOT NULL DEFAULT 0"]] as const) {
  if (!importedColumns.includes(name)) db.run(`ALTER TABLE imported_leads ADD COLUMN ${name} ${definition}`);
 }
 db.run(`CREATE TABLE IF NOT EXISTS agent_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT, firm TEXT, phone TEXT, email TEXT,
 address TEXT, raw TEXT, created_at TEXT NOT NULL
 )`);
db.run(`CREATE TABLE IF NOT EXISTS dnc_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, email TEXT, name TEXT, raw TEXT, created_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS send_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, recipient_email TEXT NOT NULL,
 subject TEXT, status TEXT NOT NULL, message_id TEXT, error TEXT, sent_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS enriched_contacts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, phone TEXT, email TEXT, socials TEXT,
 source_url TEXT, query TEXT, dnc_matched INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
)`);
// Background enrichment runs: one row per POST /api/enrich start. A module-level
// worker in src/enrich-worker.ts advances the row (processed/found/dnc_suppressed,
// cursor, current_lead_id) as it enriches leads one at a time, so clients can
// poll GET /api/enrich/status instead of holding one long HTTP request open.
db.run(`CREATE TABLE IF NOT EXISTS enrich_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'running',
 mode TEXT, "limit" INTEGER, cursor INTEGER, processed INTEGER NOT NULL DEFAULT 0,
 found INTEGER NOT NULL DEFAULT 0, dnc_suppressed INTEGER NOT NULL DEFAULT 0,
 current_lead_id INTEGER, error TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS app_flags (
 key TEXT PRIMARY KEY, value TEXT, created_at TEXT NOT NULL
)`);

export function insertLead(lead: Omit<Lead, "id" | "created_at">): Lead {
  const created_at = new Date().toISOString();
  const result = db.run(`INSERT INTO leads (business_type,company,contact_name,email,phone,website,industry,location,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    lead.business_type, lead.company, lead.contact_name, lead.email, lead.phone,
    lead.website, lead.industry, lead.location, lead.notes, created_at);
  return { ...lead, id: result.lastInsertRowid, created_at };
}

export function seedDatabase() {
  const row = db.query<{ n: number }>("SELECT COUNT(*) as n FROM leads").get();
  if ((row?.n ?? 0) > 0) return;
  for (const lead of seedLeads) insertLead(lead);
}

const towns = ["Bridgeport", "Stamford", "Norwalk", "Danbury", "Greenwich", "Fairfield", "Westport", "Stratford", "Trumbull", "Shelton", "New Canaan", "Darien", "Wilton", "Ridgefield", "Monroe", "Easton", "Newtown", "Bethel", "Brookfield", "Weston"];
const streets = ["Maple", "Oak", "Birch", "Cedar", "Highland", "Park", "Riverside", "Chestnut", "Mill", "Hawthorne", "Forest", "Lakeside", "Glen", "Meadow", "Rockwell", "Washington", "Hillside", "Old Mill", "Westview", "Elm", "Main", "River"];
const names = ["Avery Mercer", "Jordan Ellis", "Morgan Hart", "Casey Rowan", "Taylor Quinn", "Riley Sloan", "Cameron Blake", "Parker Reed", "Hayden Cole", "Reese Morgan", "Drew Bennett", "Sage Porter", "Emery Wells", "Finley Brooks", "Kendall Hayes", "Bailey Monroe", "Logan Avery", "Marlowe Grant", "Skyler Dean", "Arden Pierce", "Jules Carter", "Robin Foster", "Devon Lane", "Shawn Wilder"];
const signals = ["Owner 30+ years — likely empty nesters", "Recently retired", "Inherited property, may sell", "Outgrown starter home", "Absentee owner", "Long-term owner considering downsizing", "Relocating for work", "Estate transition signal", "Potential move-up seller", "Property appears lightly occupied"];

const realEstate: Omit<Lead, "id" | "created_at">[] = towns.map((town, i) => ({
  business_type: "real-estate", company: `${names[i]} Residence`, contact_name: names[i],
  email: `seller${i + 1}@example.com`, phone: `(203) 555-${String(4100 + i).padStart(4, "0")}`,
  website: "https://example.com", industry: "Residential Real Estate", location: `${100 + i * 7} ${streets[i]} Street, ${town}, CT ${String(6800 + i).padStart(5, "0")}`,
  notes: `Estimated value ${"$"}${(425000 + i * 68000).toLocaleString()} · ${2 + i % 4} beds · ${1 + i % 3}.5 baths · ${(1450 + i * 115).toLocaleString()} sqft · built ${1955 + i % 60}. ${signals[i % signals.length]}.`
}));

const categoryInfo: Record<string, { industry: string; prefix: string; locations: string[] }> = {
  "cleaning-services": { industry: "Cleaning Services", prefix: "Shine", locations: ["Fairfield, CT", "Stamford, CT", "Norwalk, CT", "Danbury, CT", "Shelton, CT", "Westport, CT", "Bridgeport, CT", "Trumbull, CT", "Darien, CT", "Bethel, CT"] },
  "fitness-gyms": { industry: "Fitness & Gyms", prefix: "Peak", locations: ["Stamford, CT", "Norwalk, CT", "Fairfield, CT", "Greenwich, CT", "Danbury, CT", "Stratford, CT", "Westport, CT", "Shelton, CT", "Newtown, CT", "Wilton, CT"] },
  "restaurants-cafes": { industry: "Restaurants & Cafés", prefix: "Harvest", locations: ["Norwalk, CT", "Stamford, CT", "Fairfield, CT", "Bridgeport, CT", "Westport, CT", "Danbury, CT", "Greenwich, CT", "Darien, CT", "Bethel, CT", "Ridgefield, CT"] },
  "marketing-agencies": { industry: "Marketing Agencies", prefix: "Brightline", locations: ["Stamford, CT", "Greenwich, CT", "Norwalk, CT", "Fairfield, CT", "Westport, CT", "Danbury, CT", "Shelton, CT", "Bridgeport, CT", "Wilton, CT", "New Canaan, CT"] },
  landscaping: { industry: "Landscaping", prefix: "Greenway", locations: ["Fairfield, CT", "Westport, CT", "Stamford, CT", "Norwalk, CT", "Trumbull, CT", "Shelton, CT", "Wilton, CT", "Ridgefield, CT", "Newtown, CT", "Easton, CT"] },
  "hair-beauty": { industry: "Hair & Beauty Salons", prefix: "Luxe", locations: ["Stamford, CT", "Norwalk, CT", "Fairfield, CT", "Westport, CT", "Greenwich, CT", "Darien, CT", "Danbury, CT", "Stratford, CT", "Bethel, CT", "Ridgefield, CT"] },
  "it-services": { industry: "IT Services", prefix: "Northstar", locations: ["Stamford, CT", "Norwalk, CT", "Danbury, CT", "Fairfield, CT", "Greenwich, CT", "Shelton, CT", "Bridgeport, CT", "Wilton, CT", "New Canaan, CT", "Brookfield, CT"] }
};
const seedLeads: Omit<Lead, "id" | "created_at">[] = [...realEstate];
for (const [type, info] of Object.entries(categoryInfo)) for (let i = 0; i < 10; i++) {
  const n = names[(i + 4) % names.length];
  seedLeads.push({ business_type: type, company: `${info.prefix} ${info.industry.split(" ")[0]} ${i + 1}`, contact_name: n, email: `${type}${i + 1}@example.com`, phone: `(475) 555-${String(5200 + i).padStart(4, "0")}`, website: "https://example.com", industry: info.industry, location: info.locations[i], notes: `Sample prospect for ${info.industry.toLowerCase()} outreach. Demo data only.` });
}

// ── Guarded one-time migration: assemble addresses from raw street fields ─────
// Older imports stored "Street Number"/"Street Name"/etc. only inside raw JSON, so
// property_address stayed NULL (all 9,613 expired rows, plus closed/active/pending).
// Runs automatically on the next server start (idempotent): it only does work while
// any row is missing an address or any failed listing is still flagged under the old
// lenient never-relisted rule (never_relisted=1 without any address — impossible
// under the strict logic, which means stale data from a pre-backfill run).
function runGuardedMigration() {
  try {
    const missing = Number(db.query<any>(`SELECT COUNT(*) AS n FROM imported_leads
      WHERE (property_address IS NULL OR TRIM(property_address) = '') AND raw IS NOT NULL AND raw != ''`).get()?.n || 0);
    const stale = Number(db.query<any>(`SELECT COUNT(*) AS n FROM imported_leads
      WHERE source IN ('expired','cancelled','withdrawn') AND never_relisted = 1
      AND (property_address IS NULL OR TRIM(property_address) = '') AND (mailing_address IS NULL OR TRIM(mailing_address) = '')`).get()?.n || 0);
    if (missing === 0 && stale === 0) return;
    import("./import-scoring").then(({ backfillAddressesFromRaw, refreshNeverRelisted }) => {
      try {
        if (missing > 0) backfillAddressesFromRaw();
        if (stale > 0 || missing > 0) refreshNeverRelisted();
      } catch (e) { console.error("address backfill migration failed:", e); }
    });
  } catch { /* DB not ready or already migrating — next start retries */ }
}
runGuardedMigration();

// ── Guarded one-time backfill: un-stick "done-with-nothing" enrichment stamps ─────
// During a provider outage (Firecrawl) the /api/enrich route stamped enriched_at on
// leads whose runs ended in provider errors on EVERY query — 39 leads marked "done"
// with zero usable findings, which the resume system then skips forever. This clears
// enriched_at on any stamped lead that has NO usable finding (dnc_matched=0 AND
// phone/email present), leaving the 9 leads with real findings stamped. Runs once,
// guarded by the app_flags marker; the UPDATE itself is idempotent, so even an
// interrupted run (marker not yet written) is safe to re-run.
function runBadEnrichedAtBackfill() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='cleared_bad_enriched_at'").get()) return;
    const res = db.run(`UPDATE imported_leads SET enriched_at = NULL
      WHERE enriched_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM enriched_contacts e
        WHERE e.lead_id = imported_leads.id AND e.dnc_matched = 0
          AND (e.phone IS NOT NULL AND e.phone != '' OR e.email IS NOT NULL AND e.email != '')
      )`);
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('cleared_bad_enriched_at', ?, ?)", String(res.changes ?? 0), new Date().toISOString());
    if ((res.changes ?? 0) > 0) console.log(`[migration] cleared bad enriched_at stamp on ${res.changes} lead(s) with zero usable findings`);
  } catch (e) { console.error("[migration] bad enriched_at backfill failed:", e); }
}
runBadEnrichedAtBackfill();

// ── Outreach stage 2: drip-email nurture sequence ──────────────────────────────
// drip_campaigns/drip_steps define a nurture sequence; drip_queue holds per-lead
// scheduled rows (one per step); drip_runs tracks background worker runs (same
// shape as enrich_runs — clients poll GET /api/drip/status).
db.run(`CREATE TABLE IF NOT EXISTS drip_campaigns (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL
 )`);
db.run(`CREATE TABLE IF NOT EXISTS drip_steps (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, step_order INTEGER NOT NULL,
 delay_days INTEGER NOT NULL DEFAULT 0, subject_template TEXT, html_template TEXT,
 status TEXT NOT NULL DEFAULT 'draft'
 )`);
db.run(`CREATE TABLE IF NOT EXISTS drip_queue (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL,
 step_order INTEGER NOT NULL, scheduled_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', sent_at TEXT, send_log_id INTEGER
 )`);
db.run(`CREATE TABLE IF NOT EXISTS drip_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, status TEXT NOT NULL DEFAULT 'running',
 mode TEXT, dry_run INTEGER NOT NULL DEFAULT 1, "limit" INTEGER, enqueued INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
 suppressed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT,
 stop_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
 )`);
// ── Mission Control hub: daily notes, media library, prompt inbox ─────────────
// daily_notes: one row per calendar day (note_date UNIQUE) — the owner's running
// daily log. media_items: every media artifact (ComfyUI renders, uploads, manual
// entries) so the media-review window can list/play them. prompt_requests: the
// owner's prompt inbox — every prompt-window submission lands here for the team
// to action ('new' → accepted/in_progress/done/declined).
db.run(`CREATE TABLE IF NOT EXISTS daily_notes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, note_date TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 )`);
db.run(`CREATE TABLE IF NOT EXISTS media_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, aspect TEXT NOT NULL, source TEXT NOT NULL,
 kind TEXT NOT NULL, title TEXT, filename TEXT, thumb TEXT, meta TEXT, created_at TEXT NOT NULL
 )`);
db.run(`CREATE TABLE IF NOT EXISTS prompt_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, aspect TEXT NOT NULL, prompt TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 )`);

// Seed the flagship "seller-nurture" campaign (idempotent, app_flags marker).
// Step 1 (intro email) is ACTIVE and reuses the standard drafter (empty templates
// => draftLeadEmail); steps 2/3 are DRAFT placeholders — real copy lands later
// from the content engine, then their status flips to 'active'. Only active steps
// send; drafts are skipped gracefully by the worker.
function seedSellerNurtureCampaign() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='seeded_seller_nurture'").get()) return;
    const existing = db.query<any>("SELECT id FROM drip_campaigns WHERE name='seller-nurture'").get();
    let campaignId = existing?.id;
    if (!campaignId) {
      const r = db.run("INSERT INTO drip_campaigns(name,created_at) VALUES(?,?)", "seller-nurture", new Date().toISOString());
      campaignId = Number(r.lastInsertRowid);
    }
    const hasSteps = Number(db.query<any>("SELECT COUNT(*) n FROM drip_steps WHERE campaign_id=?").get(campaignId)?.n || 0);
    if (hasSteps === 0) {
      const html = (body: string) => `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#243044">${body}<p style="font-size:12px;color:#667085"><a href="{unsubscribe}">Unsubscribe</a> from future emails.</p></div>`;
      db.run("INSERT INTO drip_steps(campaign_id,step_order,delay_days,subject_template,html_template,status) VALUES(?,1,0,'','','active')", campaignId);
      db.run("INSERT INTO drip_steps(campaign_id,step_order,delay_days,subject_template,html_template,status) VALUES(?,2,3,'What\u2019s happening in {town} real estate right now',?, 'draft')", campaignId, html(`<p>Hi {first_name},</p><p>Here\u2019s a quick look at what\u2019s moving in {town} right now \u2014 [market blog placeholder: real content from the content engine lands here, with a CTA to book a call].</p><p>Best,<br>Mark Pires</p>`));
      db.run("INSERT INTO drip_steps(campaign_id,step_order,delay_days,subject_template,html_template,status) VALUES(?,3,7,'A quick story from {town}',?,'draft')", campaignId, html(`<p>Hi {first_name},</p><p>I wanted to share a quick story \u2014 [connector story placeholder: owner\u2019s story-bank piece about {town}, built around real questions people ask online].</p><p>Best,<br>Mark Pires</p>`));
    }
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('seeded_seller_nurture', ?, ?)", String(campaignId), new Date().toISOString());
    console.log("[migration] seeded seller-nurture drip campaign (id " + campaignId + ")");
  } catch (e) { console.error("[migration] seller-nurture seed failed:", e); }
}
seedSellerNurtureCampaign();

// One-time marker: records that the mission-control tables exist (created
// idempotently above). Guards any future one-time data backfill for them.
function markMissionControlTables() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='mission_control_tables'").get()) return;
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('mission_control_tables', ?, ?)", "daily_notes,media_items,prompt_requests", new Date().toISOString());
    console.log("[migration] mission-control tables ready (daily_notes, media_items, prompt_requests)");
  } catch (e) { console.error("[migration] mission-control marker failed:", e); }
}
markMissionControlTables();

// ── Guarded one-time reset: stale pre-person-match-gate enriched_at stamps ────
// ~144 leads were enriched before the person-match gate and email promotion
// existed. Their enriched_contacts findings were never person-gated, and the
// enriched_at stamp blocks re-enrichment forever. email_source_url IS NULL
// identifies pre-promotion-era enrichments (promotion sets it). This clears the
// stamp so those leads re-enrich under the current gate. Leads that already have
// a promoted email (email_source_url NOT NULL) are untouched. Idempotent + marker.
function runStaleEnrichedAtReset() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='cleared_pre_gate_enriched_at'").get()) return;
    const res = db.run(`UPDATE imported_leads SET enriched_at = NULL
      WHERE enriched_at IS NOT NULL AND email_source_url IS NULL`);
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('cleared_pre_gate_enriched_at', ?, ?)", String(res.changes ?? 0), new Date().toISOString());
    if ((res.changes ?? 0) > 0) console.log(`[migration] cleared stale pre-gate enriched_at on ${res.changes} lead(s)`);
  } catch (e) { console.error("[migration] stale enriched_at reset failed:", e); }
}
runStaleEnrichedAtReset();

// ── Chunked media uploads (raw 4K video → owner's F: drive) ──────────────────
// upload_jobs tracks multi-chunk uploads: the browser streams 8 MB chunks to the
// app, which forwards them to the media receiver on the owner's GPU box (target
// 'remote', F: drive) or writes them to .data/media (target 'local' fallback when
// no receiver is reachable). One row per upload, from upload-start until
// complete/abort/failed; rows are kept as history after completion.
db.run(`CREATE TABLE IF NOT EXISTS upload_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 upload_id TEXT NOT NULL UNIQUE,
 filename TEXT NOT NULL,
 size INTEGER NOT NULL,
 total_chunks INTEGER NOT NULL,
 received_count INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'staging',
 target TEXT NOT NULL DEFAULT 'local',
 aspect TEXT NOT NULL DEFAULT 'general',
 media_item_id INTEGER,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
 )`);
function markUploadJobsTable() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='upload_jobs_table'").get()) return;
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('upload_jobs_table', ?, ?)", "upload_jobs", new Date().toISOString());
    console.log("[migration] upload_jobs table ready (chunked uploads)");
  } catch (e) { console.error("[migration] upload_jobs marker failed:", e); }
}
markUploadJobsTable();

// ── Content engine: blogwriter posts (Shakespeare aspect) ────────────────────
// content_posts stores the blogwriter's markdown posts with SEO fields and a
// forward-only lifecycle (draft → ready → published). slug is the ingest upsert
// key AND the drip step-2 market-blog lookup key (UNIQUE). published_at is an
// ever-published marker and is NEVER cleared once set. status ∈ draft|ready|published.
db.run(`CREATE TABLE IF NOT EXISTS content_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  focus_keyword TEXT,
  meta_title TEXT,
  meta_description TEXT,
  body_markdown TEXT NOT NULL,
  faq_schema_json TEXT,
  cta_url TEXT,
  source_question TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  town_focus TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_content_posts_status ON content_posts(status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_content_posts_town_focus ON content_posts(town_focus)`);
function markContentPostsTable() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='content_posts_table'").get()) return;
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('content_posts_table', ?, ?)", "content_posts", new Date().toISOString());
    console.log("[migration] content_posts table ready (content engine)");
  } catch (e) { console.error("[migration] content_posts marker failed:", e); }
}
markContentPostsTable();

// ── Auth: users table + admin seed (owner request 2026-08-12) ─────────────────
// users: one row per account. password_hash is scrypt (never plaintext).
// must_change_password=1 forces a password change at first login (admin starts
// with the generic ADMIN_INITIAL_PASSWORD). session_version is bumped on every
// password change so all previously issued session cookies become invalid
// (session rotation). last_login_at is updated on each successful login.
export type User = {
  id: number; email: string; password_hash: string;
  must_change_password: number; session_version: number;
  created_at: string; last_login_at: string | null;
};
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
)`);
function markUsersTable() {
  try {
    if (db.query<any>("SELECT value FROM app_flags WHERE key='users_table'").get()) return;
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('users_table', ?, ?)", "users", new Date().toISOString());
    console.log("[migration] users table ready (auth)");
  } catch (e) { console.error("[migration] users marker failed:", e); }
}
markUsersTable();

// Seed the admin account (mark@markpires.com) on first boot: generic starting
// password from ADMIN_INITIAL_PASSWORD (kept ONLY in .env — never in source),
// forced change on first login. Idempotent — only creates when absent, so a
// later .env edit never overwrites the real password.
function seedAdminUser() {
  try {
    if (db.query<any>("SELECT id FROM users WHERE email='mark@markpires.com'").get()) return;
    const initial = process.env.ADMIN_INITIAL_PASSWORD;
    if (!initial || initial.length < 8) {
      console.warn("[auth] ADMIN_INITIAL_PASSWORD missing or too short in .env — admin NOT seeded; add it and restart");
      return;
    }
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO users (email, password_hash, must_change_password, session_version, created_at, last_login_at) VALUES (?,?,1,0,?,NULL)",
      "mark@markpires.com", hashPassword(initial), now,
    );
    db.run("INSERT INTO app_flags (key, value, created_at) VALUES ('admin_seeded', ?, ?)", "mark@markpires.com", now);
    console.log("[auth] admin account seeded (mark@markpires.com) with generic initial password — first login forces a change");
  } catch (e) { console.error("[auth] admin seed failed:", e); }
}
seedAdminUser();
