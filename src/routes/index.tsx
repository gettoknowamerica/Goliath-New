import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MediaLibrary, MediaUploadZone, UploadsStrip, mediaItemUrl, useMediaUploader } from "~/media-upload";
import type { LibraryFilter, MediaItem, UploadTask, ViewerMedia } from "~/media-upload";

export const Route = createFileRoute("/")({ component: Dashboard });

type EnrichedContact = { phone?: string | null; email?: string | null; socials?: { platform?: string; url?: string }[]; source_url?: string | null };
type Lead = {
  id: string | number; source?: string; contact_name?: string; email?: string; phone?: string;
  property_address?: string; town?: string; state?: string; zip?: string; score?: number;
  score_breakdown?: Record<string, number>; dnc_matched?: boolean; opted_out?: boolean; opt_out?: boolean;
  enriched?: EnrichedContact; enriched_at?: string | null; agent_attached?: number | boolean; listed_active?: number | boolean;
  listed_pending?: number | boolean; closed_recently?: number | boolean; market_status?: string | null; is_market?: boolean;
};
type EmailLog = { id: string | number; lead_id?: string | number; recipient_email?: string; subject?: string; status?: string; message_id?: string; error?: string; sent_at?: string };
type EmailDraft = { subject: string; html: string; from?: string; to?: string };
type BusinessType = { id: string; label: string; description: string };
type ComfyEntry = { prompt_id: string; title: string; filename: string; subfolder: string; type: string; kind: "image" | "video"; created: string };
type ComfyStatus = { configured: boolean; health?: { ok?: boolean; comfyui_version?: string; device?: string; vram_free?: number } | null; queue?: { queue_running?: unknown[]; queue_pending?: unknown[] } | null };
type DripStep = { step_order: number; delay_days: number; status: string };
type DripStatus = { runId?: number; status?: string; dryRun?: boolean; limit?: number; queueCounts?: { pending: number; sent: number; skipped: number; failed: number; suppressed: number }; nextScheduledAt?: string | null; steps?: DripStep[] };
type Note = { id: number; note_date: string; content: string; created_at?: string; updated_at?: string };
type Prompt = { id: number; aspect: string; prompt: string; status: string; created_at: string; updated_at: string };
type EmailLead = { id: number; name: string; email: string; email_verified: number; email_source_url?: string | null; town?: string; score?: number };
type TownCount = { town: string; count: number };
// Lean content-post row as served by GET /api/content (list omits body_markdown /
// faq_schema_json; the full GET /api/content/:id includes them — both fit this type).
type ContentPost = {
  id: number; title: string; slug: string; status: string; town_focus?: string | null;
  meta_title?: string | null; meta_description?: string | null; focus_keyword?: string | null;
  source_question?: string | null; cta_url?: string | null; created_at: string; updated_at?: string;
  published_at?: string | null; body_markdown?: string; faq_schema_json?: string | null;
};

// ── markdownToHtml (vendored verbatim from ~/content) ─────────────────────────
// ~/content imports ~/db (bun:sqlite + node:fs), which can never enter the client
// bundle — importing it from this route breaks the client build. This is the
// identical escape-first renderer: no markdown dependency, and a post body can
// never inject raw HTML. Keep in sync with src/content.ts if that ever changes.
function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
  const urlEscape = (s: string) => esc(s).replace(/&amp;/g, "&");
  const link = (text: string, href: string) => {
    const safe = urlEscape(href);
    // Only http(s)/mailto/tel links survive; anything else renders as plain text.
    return /^(https?:\/\/|mailto:|tel:)/i.test(safe) ? `<a href="${safe}">${esc(text)}</a>` : esc(text);
  };
  const inline = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")           // strong BEFORE single-star emphasis
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")                     // *text* -> <em>
      .replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, "$1<em>$2</em>$3") // _text_ -> <em> (not inside words)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, h: string) => link(t, h))
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const body = esc(md).replace(/\r\n?/g, "\n");
  const lines = body.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let inCode = false;
  let codeBuf: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    // Fenced code blocks: a ``` fence renders as <pre><code>...</code></pre> instead
    // of raw visible text. Content was already HTML-escaped above, so a fence can
    // never inject raw HTML. Defense-in-depth for any body that ships a ``` block.
    if (/^\s*`{3}/.test(line)) {
      flushPara(); closeList();
      if (!inCode) { inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flushPara(); closeList();
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) { flushPara(); closeList(); out.push("<hr>"); continue; }
    const bq = line.match(/^\s*&gt;\s?(.*)$/); // ">" escaped to "&gt;"
    if (bq) {
      flushPara(); closeList();
      const q = inline(bq[1]);
      if (q) out.push(`<blockquote><p>${q}</p></blockquote>`); // skip empty (lone ">")
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { flushPara(); if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { flushPara(); if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    closeList();
    para.push(line);
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`); // unclosed fence - still render
  flushPara(); closeList();
  return out.join("\n");
}

const sources = [
  { id: "absentee", label: "Absentee owners", icon: "⌂", hint: "Owners living outside their property" },
  { id: "expired", label: "Expired listings", icon: "↻", hint: "Listings ready for a fresh strategy" },
  { id: "dnc", label: "DNC list", icon: "⊘", hint: "Suppress contacts from outreach" },
  { id: "agents", label: "Agent list", icon: "◈", hint: "Agents attached to properties — suppresses matching leads" },
  { id: "active", label: "Active listings", icon: "★", hint: "On market — suppresses matching owners" },
  { id: "pending", label: "Pending listings", icon: "◔", hint: "Under contract — suppresses matching owners" },
  { id: "closed", label: "Closed sales", icon: "✓", hint: "Recently sold — suppresses matching owners" },
] as const;

// Mission Control aspects — compact cards on the left; clicking one fills the
// center workbench with that aspect's work and the right inspector with its status.
type AspectId = "notes" | "contacts" | "scorsese" | "jessica" | "shakespeare";
const ASPECTS: { id: AspectId; label: string; icon: string; promptAspect: string; tagline: string }[] = [
  { id: "notes", label: "Daily Notes", icon: "▤", promptAspect: "notes", tagline: "Today's log — saved per day, kept forever." },
  { id: "contacts", label: "Contacts", icon: "◈", promptAspect: "general", tagline: "Imported leads, DNC, verified emails, never-relisted." },
  { id: "scorsese", label: "Scorsese", icon: "◉", promptAspect: "scorsese", tagline: "AI video work — ComfyUI renders from the GPU box." },
  { id: "jessica", label: "Jessica", icon: "✉", promptAspect: "jessica", tagline: "Email outreach — drip campaign, queue, approvals." },
  { id: "shakespeare", label: "Shakespeare", icon: "✎", promptAspect: "shakespeare", tagline: "Content & blogs — voice-trained writer (pipeline pending)." },
];

// Staged Shakespeare corpus — the first content drop (real files, awaiting owner review).
const STAGED_PIECES = [
  { id: 1, title: "What Fairfield County homeowners actually ask before selling (2026)", kind: "Blog · SEO/AEO/GEO", status: "Staged · owner review", excerpt: "Eight real questions homeowners ask before listing — answered straight, with a soft path to a free market snapshot.", date: "2026-08-12" },
  { id: 2, title: "How much is my Westport home worth?", kind: "Blog · SEO/AEO/GEO", status: "Staged · owner review", excerpt: "What a market snapshot / CMA actually is, the six value drivers, and the honest way to get your number.", date: "2026-08-12" },
  { id: 3, title: "What first-time buyers in Fairfield County need to know before making an offer", kind: "Blog · SEO/AEO/GEO · Discover CT", status: "Staged · owner review", excerpt: "True-budget math — taxes included — plus closing costs, town trade-offs, and competing without overpaying.", date: "2026-08-12" },
  { id: 4, title: "Straight answers to the questions people type about Connecticut real estate", kind: "Blog · GEO (LLM-quotable)", status: "Staged · owner review", excerpt: "Eight self-contained answers written to be quoted by AI answer engines — commuter towns, CT taxes, mansion tax, CHFA.", date: "2026-08-12" },
  { id: 5, title: "Drip step 2 — What's happening in {town} real estate right now", kind: "Email · Drip nurture", status: "Staged · owner review", excerpt: "Market-brief email: three things to watch, one labeled example, soft CTA to a free market snapshot. Day 3.", date: "2026-08-12" },
  { id: 6, title: "Drip step 3 — A quick story from {town}", kind: "Email · Drip nurture", status: "Staged · owner review", excerpt: "Connector-story template with story-bank slots — waits on owner-approved stories before it can send.", date: "2026-08-12" },
];

const PROMPT_STATUSES = ["new", "accepted", "in_progress", "done", "declined"];
const promptStatusChip: Record<string, string> = {
  new: "bg-amber-400/15 text-amber-300 border-amber-400/30",
  accepted: "bg-sky-400/15 text-sky-300 border-sky-400/30",
  in_progress: "bg-violet-400/15 text-violet-300 border-violet-400/30",
  done: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
  declined: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

// Score color bands (owner-specified): >=90 red · 80–89 yellow · 70–79 amber · <=69 green.
function scoreChip(score: number) {
  if (score >= 90) return "bg-red-500 text-red-950 border border-red-300/50 shadow-[0_0_14px_rgba(239,68,68,0.35)]";
  if (score >= 80) return "bg-yellow-400 text-yellow-950 border border-yellow-200/60 shadow-[0_0_12px_rgba(250,204,21,0.3)]";
  if (score >= 70) return "bg-amber-500 text-amber-950 border border-amber-300/50 shadow-[0_0_10px_rgba(245,158,11,0.25)]";
  return "bg-green-500 text-green-950 border border-green-300/50 shadow-[0_0_10px_rgba(34,197,94,0.25)]";
}

const fmtVram = (bytes?: number) => (bytes == null ? "—" : `${(bytes / 1e9).toFixed(1)} GB`);

// Rows rendered in the leads table before "Load more" — the full imported set
// can be 17.8k rows, which makes the page (and browser automation) crawl.
const TABLE_PAGE = 500;

function Dashboard() {
  // ---- preserved: leads / generator / email ----
  const [leads, setLeads] = useState<Lead[]>([]);
  const [types, setTypes] = useState<BusinessType[]>([]);
  const [source, setSource] = useState("all");
  const [minScore, setMinScore] = useState("0");
  const [showDnc, setShowDnc] = useState(false);
  const [expanded, setExpanded] = useState<string | number | null>(null);
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [selectedType, setSelectedType] = useState("real-estate");
  const [count, setCount] = useState(10);
  const [samples, setSamples] = useState<Lead[]>([]);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<{ lead: Lead; email: EmailDraft } | null>(null);
  const [emailBusy, setEmailBusy] = useState<string | number | "all" | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [enrichLimit, setEnrichLimit] = useState<number | "all">(25);
  const [enriching, setEnriching] = useState(false);
  const [enrichStop, setEnrichStop] = useState(false);
  const [enrichStatus, setEnrichStatus] = useState<{ processed: number; found: number; dncSuppressed: number; remaining?: number; provider?: string; status?: string } | null>(null);
  const [enrichError, setEnrichError] = useState("");
  const [enrichStats, setEnrichStats] = useState<{ totalLeads: number; reviewedCount: number; withPhone: number; withEmail: number; promotedEmails: number; withSocials: number; withContext: number; dncSuppressed: number; scored70plus: number; perSource?: { source: string; total: number; withPhone: number; withEmail: number; withSocials: number }[] } | null>(null);

  // ---- Mission Control monitor state ----
  const [activeAspect, setActiveAspect] = useState<AspectId | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [comfy, setComfy] = useState<{ configured: boolean; entries: ComfyEntry[]; count: number; error?: string } | null>(null);
  const [comfyStat, setComfyStat] = useState<ComfyStatus | null>(null);
  const [drip, setDrip] = useState<DripStatus | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [viewer, setViewer] = useState<ViewerMedia | null>(null);
  const [never, setNever] = useState<{ count: number; byTown: TownCount[]; totalFailedListings?: number; unverified?: number } | null>(null);
  const [importedTotal, setImportedTotal] = useState(0);
  const [dncTotal, setDncTotal] = useState(0);
  const [emailQueue, setEmailQueue] = useState<EmailLead[]>([]); // verified=0 (needs review)
  const [approvedEmails, setApprovedEmails] = useState<EmailLead[]>([]); // verified=1
  const [verifiedBusy, setVerifiedBusy] = useState<number | null>(null);
  const [dripBusy, setDripBusy] = useState<string | null>(null);
  const [visibleRows, setVisibleRows] = useState(TABLE_PAGE);

  // ---- media library + chunked uploader (Scorsese) ----
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [uploadAspect, setUploadAspect] = useState("scorsese");
  const loadMedia = async () => { try { const r = await fetch("/api/media?aspect=scorsese&limit=200"); const d = await r.json(); setMediaItems(d.items ?? []); } catch { /* offline */ } };
  const { tasks: uploadTasks, enqueue: enqueueUploads, cancelTask, retryTask, clearTask, clearFinished } = useMediaUploader(loadMedia);

  // ---- Shakespeare: content library from the content_posts DB ----
  const [content, setContent] = useState<ContentPost[]>([]);
  const loadContent = async () => { try { const r = await fetch("/api/content?limit=100"); const d = await r.json(); setContent(d.posts ?? []); } catch { /* offline */ } };

  const loadLogs = async () => { try { const r = await fetch("/api/email-log"); const d = await r.json(); setLogs(d.logs ?? []); } catch { setLogs([]); } };
  const loadComfy = async () => { try { const r = await fetch("/api/media/comfy"); const d = await r.json(); setComfy({ configured: !!d.configured, entries: d.entries ?? [], count: d.count ?? 0, error: d.error }); } catch { /* offline */ } };
  const loadComfyStat = async () => { try { const r = await fetch("/api/comfy/status"); const d = await r.json(); setComfyStat(d); } catch { /* offline */ } };
  const loadDrip = async () => { try { const r = await fetch("/api/drip/status"); const d = await r.json(); setDrip(d); } catch { /* offline */ } };
  const loadNotes = async () => { try { const r = await fetch("/api/notes?limit=20"); const d = await r.json(); setNotes(d.notes ?? []); } catch { /* offline */ } };
  const loadNever = async () => { try { const r = await fetch("/api/never-relisted"); const d = await r.json(); setNever(d); } catch { /* offline */ } };
  const loadEmailLists = async () => {
    try {
      const [r0, r1] = await Promise.all([
        fetch("/api/leads/emails?verified=0&limit=200"),
        fetch("/api/leads/emails?verified=1&limit=200"),
      ]);
      const [d0, d1] = await Promise.all([r0.json(), r1.json()]);
      setEmailQueue(d0.leads ?? []);
      setApprovedEmails(d1.leads ?? []);
    } catch { /* offline */ }
  };
  const loadPrompts = async (aspect: AspectId | null) => {
    if (!aspect) { setPrompts([]); return; }
    const pa = ASPECTS.find(a => a.id === aspect)?.promptAspect ?? "general";
    try { const r = await fetch(`/api/prompts?aspect=${pa}&limit=50`); const d = await r.json(); setPrompts(d.prompts ?? []); } catch { setPrompts([]); }
  };
  const refresh = async () => {
    const params = new URLSearchParams({ dnc: showDnc ? "all" : "0" });
    if (source !== "all") params.set("source", source);
    if (minScore !== "0") params.set("minScore", minScore);
    try { const r = await fetch(`/api/imported-leads?${params}`); const d = await r.json(); setLeads(d.leads ?? []); } catch { /* API may be offline */ }
  };

  // ---- mount: initial loads ----
  useEffect(() => {
    fetch("/api/auth/me").then(r => { if (r.ok) return r.json(); window.location.replace("/login"); return null; }).then(d => { if (d) setSessionEmail(d.email); }).catch(() => {});
    fetch("/api/business-types").then(r => r.json()).then(d => setTypes(d.businessTypes ?? [])).catch(() => {});
    loadLogs(); loadComfy(); loadComfyStat(); loadDrip(); loadNotes(); loadNever(); loadEmailLists(); loadMedia();
    fetch("/api/enrich/stats").then(r => r.ok ? r.json() : null).then(d => d && setEnrichStats(d)).catch(() => {});
    fetch("/api/imported-leads?minScore=0&dnc=0").then(r => r.json()).then(d => setImportedTotal((d.leads ?? []).length)).catch(() => {});
    fetch("/api/imported-leads?minScore=0&dnc=1").then(r => r.json()).then(d => setDncTotal((d.leads ?? []).length)).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [source, minScore, showDnc]);
  useEffect(() => { loadPrompts(activeAspect); }, [activeAspect]);
  useEffect(() => { setVisibleRows(TABLE_PAGE); }, [source, minScore, showDnc]);
  // light background refresh of the GPU + drip state every 20s so the monitor stays live
  useEffect(() => {
    const t = setInterval(() => { loadComfy(); loadComfyStat(); loadDrip(); loadMedia(); }, 20000);
    return () => clearInterval(t);
  }, []);

  function logOut() {
    setLoggingOut(true);
    fetch("/api/auth/logout", { method: "POST", redirect: "manual" })
      .then(() => { window.location.replace("/login"); })
      .catch(() => { window.location.replace("/login"); });
  }

  // ---- preserved: email draft/send ----
  async function draftEmail(lead: Lead) {
    setNotice(null); setEmailBusy(lead.id);
    try { const r = await fetch("/api/email/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: lead.id }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not create draft"); setDraft({ lead, email: d }); }
    catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not create draft" }); } finally { setEmailBusy(null); }
  }
  async function sendEmail(body: Record<string, unknown>, label: string, busy: string | number) {
    setEmailBusy(busy); setNotice(null);
    try { const r = await fetch("/api/email/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Email request failed"); const summary = `${label}: ${d.sent ?? 0} sent · ${d.skipped ?? 0} skipped · ${d.failed ?? 0} failed${d.error ? ` — ${d.error}` : ""}`; setNotice({ kind: (d.failed ? "error" : "success"), text: summary }); await loadLogs(); }
    catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Email request failed" }); await loadLogs(); } finally { setEmailBusy(null); }
  }

  const filtered = useMemo(() => [...leads].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)), [leads]);
  const enrichedLeadCount = useMemo(() => leads.some(l => l.enriched_at !== undefined) ? leads.filter(l => !!l.enriched_at).length : null, [leads]);

  // ---- preserved: upload / generate / enrich / clear ----
  async function upload(file: File, kind: string) {
    setUploading(kind); setUploadError("");
    const form = new FormData(); form.append("file", file); form.append("source", kind);
    try { const r = await fetch("/api/import", { method: "POST", body: form }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Upload failed"); setUploads(x => ({ ...x, [kind]: `${d.imported ?? 0} imported · ${d.skipped ?? 0} skipped · ${d.dncMatched ?? 0} DNC-matched` })); await refresh(); }
    catch (e) { setUploadError(e instanceof Error ? e.message : "Upload failed"); }
    finally { setUploading(null); }
  }
  async function generate() {
    setGenerating(true); try { const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ businessType: selectedType, count }) }); const d = await r.json(); setSamples(d.leads ?? []); } catch { setSamples([]); } finally { setGenerating(false); }
  }
  async function enrichContacts() {
    setEnriching(true); setEnrichStop(false); setEnrichError(""); setEnrichStatus(null);
    try {
      const body: Record<string, unknown> = { all: true };
      if (enrichLimit !== "all") body.limit = enrichLimit;
      const r = await fetch("/api/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const contentType = r.headers.get("content-type") || "";
      if (!r.ok || !contentType.toLowerCase().includes("application/json")) throw new Error("Sleuth service temporarily unavailable — provider upstream issue. Please retry in a minute.");
      const d = await r.json();
      if (!d.runId) throw new Error(d.error || "Could not start the contact sleuth run.");
      let failedPolls = 0;
      for (;;) {
        await new Promise(res => setTimeout(res, 3000));
        let sd: any = null;
        try { const sr = await fetch("/api/enrich/status"); if (sr.ok) { sd = await sr.json(); failedPolls = 0; } } catch { /* transient network blip */ }
        if (sd) {
          setEnrichStatus({ processed: sd.processed ?? 0, found: sd.found ?? 0, dncSuppressed: sd.dncSuppressed ?? 0, remaining: sd.remaining, provider: sd.provider, status: sd.status });
          if (["done", "stopped", "error"].includes(sd.status)) break;
        } else if (++failedPolls >= 5) { setEnrichError("Lost contact with the sleuth worker — it keeps running in the background. Refresh the page to see results."); break; }
      }
      await refresh();
      fetch("/api/enrich/stats").then(r => r.ok ? r.json() : null).then(d => d && setEnrichStats(d)).catch(() => {});
    } catch (e) { setEnrichError(e instanceof Error ? e.message : "Contact sleuth is unavailable right now."); }
    finally { setEnriching(false); setEnrichStop(false); }
  }
  function stopEnrichment() { setEnrichStop(true); fetch("/api/enrich/stop", { method: "POST" }).catch(() => {}); }
  async function clearImported() {
    if (!window.confirm("Erase ALL imported leads, including absentee, expired, and market lists (agent, active, pending, closed), and their enriched findings? Your DNC list and email history are kept. This cannot be undone.")) return;
    try {
      const r = await fetch("/api/clear-import", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not clear imported leads");
      setUploads({});
      setNotice({ kind: "success", text: `Cleared ${d.deleted ?? 0} imported lead${d.deleted === 1 ? "" : "s"}. Ready for a fresh upload.` });
      await refresh();
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not clear imported leads" }); }
  }

  // ---- Mission Control actions ----
  async function saveTodayNote() {
    const content = noteText.trim();
    if (!content) { setNotice({ kind: "info", text: "Write something first — the note is saved per day." }); return; }
    setNoteSaving(true);
    try {
      const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save note");
      setNotice({ kind: "success", text: "Daily note saved." });
      await loadNotes();
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not save note" }); }
    finally { setNoteSaving(false); }
  }
  async function deleteNote(id: number) {
    if (!window.confirm("Delete this daily note? This cannot be undone.")) return;
    try { const r = await fetch(`/api/notes/${id}`, { method: "DELETE" }); if (!r.ok) throw new Error("delete failed"); setNotice({ kind: "success", text: "Note deleted." }); await loadNotes(); }
    catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not delete note" }); }
  }
  async function sendPrompt() {
    const aspect = activeAspect;
    if (!aspect) return;
    const pa = ASPECTS.find(a => a.id === aspect)?.promptAspect ?? "general";
    const text = promptDraft.trim();
    if (!text) { setNotice({ kind: "info", text: "Type a prompt first." }); return; }
    setPromptSending(true);
    try {
      const r = await fetch("/api/prompts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aspect: pa, prompt: text }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not submit prompt");
      setPromptDraft("");
      setNotice({ kind: "success", text: `Prompt sent to ${ASPECTS.find(a => a.id === aspect)?.label} inbox.` });
      await loadPrompts(aspect);
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not submit prompt" }); }
    finally { setPromptSending(false); }
  }
  async function cyclePromptStatus(p: Prompt) {
    const i = PROMPT_STATUSES.indexOf(p.status);
    const next = PROMPT_STATUSES[(i + 1) % PROMPT_STATUSES.length];
    try { const r = await fetch(`/api/prompts/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }) }); if (r.ok) await loadPrompts(activeAspect); } catch { /* ignore */ }
  }
  async function setEmailVerified(lead: EmailLead, verified: 0 | 1) {
    setVerifiedBusy(lead.id);
    try {
      const r = await fetch(`/api/leads/${lead.id}/email-verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verified }) });
      if (!r.ok) throw new Error("verify failed");
      setNotice({ kind: "success", text: verified ? `Approved ${lead.email}` : `Rejected ${lead.email}` });
      await loadEmailLists();
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not update verification" }); }
    finally { setVerifiedBusy(null); }
  }
  async function dripAction(action: "start" | "tick" | "stop") {
    setDripBusy(action);
    try {
      const r = await fetch(`/api/drip/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: action === "stop" ? undefined : JSON.stringify({ dry_run: true, ...(action === "start" ? { limit: 5 } : {}) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "drip action failed");
      setNotice({ kind: "success", text: `Jessica ${action} — dry run.` });
      await loadDrip();
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "drip action failed" }); }
    finally { setDripBusy(null); }
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayNote = notes.find(n => n.note_date === today);
  const activeLabel = activeAspect ? (ASPECTS.find(a => a.id === activeAspect)?.label ?? "") : "";
  const gpuOnline = !!(comfyStat?.configured && comfyStat?.health?.ok);
  const queueCounts = drip?.queueCounts ?? { pending: 0, sent: 0, skipped: 0, failed: 0, suppressed: 0 };
  const comfyViewUrl = (e: ComfyEntry) => `/api/media/comfy/view?filename=${encodeURIComponent(e.filename)}&subfolder=${encodeURIComponent(e.subfolder || "")}&type=${encodeURIComponent(e.type || "output")}`;

  function openAspect(id: AspectId) {
    setActiveAspect(id);
    setViewer(null);
    if (id === "scorsese") { loadComfy(); loadMedia(); }
    if (id === "jessica") { loadDrip(); loadEmailLists(); }
    if (id === "notes") loadNotes();
    if (id === "shakespeare") loadContent();
  }

  const openLeadSection = () => { document.getElementById("leads-section")?.scrollIntoView({ behavior: "smooth" }); };

  const aspectStat: Record<AspectId, string> = {
    notes: todayNote ? `today saved · ${notes.length} on file` : `today unsaved · ${notes.length} on file`,
    contacts: `${importedTotal.toLocaleString()} imported · ${dncTotal.toLocaleString()} DNC`,
    scorsese: `${comfy?.count ?? 0} renders · ${mediaItems.length} up · ${gpuOnline ? "GPU on" : "GPU off"}`,
    jessica: `${queueCounts.pending} pending · ${emailQueue.length} to approve`,
    shakespeare: `${content.filter(c => c.status === "published").length} published · ${content.length} total`,
  };

  return <div className="carbon-bg min-h-screen text-slate-200">
    {/* ============ STICKY HEADER ============ */}
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#0b0e14]/85 backdrop-blur"><div className="mx-auto flex max-w-[1720px] items-center justify-between px-5 py-3.5 lg:px-8">
      <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 text-lg font-black text-amber-950 shadow-[0_0_18px_rgba(245,158,11,0.35)]">L</div><div><div className="flex items-center gap-2"><span className="text-lg font-bold tracking-tight text-white">LeadForge</span><span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-amber-300">Mission Control</span></div><div className="hidden text-xs text-slate-400 sm:block">Every aspect of the operation, one screen.</div></div></div>
      <div className="flex items-center gap-3">{gpuOnline ? <span className="hidden rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 sm:inline-flex" title={`${comfyStat?.health?.device ?? ""} · ${fmtVram(comfyStat?.health?.vram_free)} free`}>● GPU online</span> : <span className="hidden rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 sm:inline-flex">● System ready</span>}{drip?.dryRun && <span className="hidden rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-300 sm:inline-flex">DRY-RUN EMAILS</span>}{sessionEmail && <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 sm:inline-flex" title="Signed in">Signed in as {sessionEmail}</span>}<button onClick={logOut} disabled={loggingOut} title="End this session" className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-50">{loggingOut ? "Logging out…" : "Log out"}</button><div className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-gradient-to-br from-slate-600 to-slate-800 text-sm font-bold text-slate-100">MP</div></div>
    </div></header>

    <main className="mx-auto max-w-[1720px] px-5 py-6 lg:px-8">
      {/* ============ HERO ============ */}
      <div className="mb-6 flex flex-col justify-between gap-3 md:flex-row md:items-end">
        <div><p className="silver-label mb-1 text-sm font-semibold uppercase tracking-widest">Mission Control</p><h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">The whole operation, at a glance.</h1><p className="mt-1 text-sm text-slate-400">Work in the center — aspects left, status &amp; prompts right.</p></div>
        <div className="flex flex-col items-end gap-1"><div className="flex flex-wrap items-center gap-2"><a href="/api/call-list" download className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 px-5 py-3 text-sm font-black text-amber-950 shadow-[0_0_24px_rgba(245,158,11,0.3)] transition hover:from-amber-200 hover:to-amber-400">↓ Call list <span className="rounded bg-amber-950/20 px-1.5 py-0.5 text-[10px]">CSV</span></a><a href="/api/call-list/pdf" download className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 px-5 py-3 text-sm font-black text-amber-950 shadow-[0_0_24px_rgba(245,158,11,0.3)] transition hover:from-amber-200 hover:to-amber-400">↓ Call sheet <span className="rounded bg-amber-950/20 px-1.5 py-0.5 text-[10px]">PDF</span></a></div><span className="text-[11px] text-slate-500">Web-found numbers included · DNC excluded · PDF is a printable per-contact sheet.</span></div>
      </div>

      {/* ============ THREE COLUMNS: aspects | work | info ============ */}
      <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)_320px] xl:grid-cols-[280px_minmax(0,1fr)_340px]">

        {/* ---- LEFT: compact aspect cards + DB totals ---- */}
        <aside className="min-w-0 lg:sticky lg:top-[76px] lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="mb-2 flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Aspects</p><span className="text-[10px] text-slate-600">select to open</span></div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5 lg:grid-cols-1">
            {ASPECTS.map(a => <CompactAspect key={a.id} id={a.id} label={a.label} icon={a.icon} stat={aspectStat[a.id]} active={activeAspect === a.id} onClick={() => openAspect(a.id)} />)}
          </div>
          {/* DB totals — the old stat strip, folded into the left rail */}
          <div className="mt-3 rounded-xl border border-white/[0.08] bg-[#0e1219]/70 p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Database totals</p>
            <div className="space-y-1.5">
              <InfoRow label="Imported leads" value={importedTotal.toLocaleString()} accent="text-amber-300" />
              <InfoRow label="DNC excluded" value={dncTotal.toLocaleString()} accent="text-rose-300" />
              <InfoRow label="Verified emails" value={approvedEmails.length.toLocaleString()} accent="text-emerald-300" />
              <InfoRow label="Never relisted" value={never ? never.count.toLocaleString() : "—"} accent="text-sky-300" />
              <InfoRow label="GPU renders" value={comfy ? comfy.count.toLocaleString() : "—"} accent="text-violet-300" />
            </div>
          </div>
          <p className="mt-2 px-1 text-[10px] leading-3.5 text-slate-600">{gpuOnline ? "GPU box reachable — renders stream through the app." : "GPU box offline — Scorsese shows the last known history."}</p>
        </aside>

        {/* ---- CENTER: the work, largest area ---- */}
        <div className="min-w-0">
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0e1219]/90 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <div><p className="silver-label text-[10px] font-bold uppercase tracking-[.18em]">Workbench</p><h2 className="text-xl font-bold tracking-tight text-white">{activeAspect ? activeLabel : "Select an aspect"}</h2></div>
              <div className="flex items-center gap-2">{activeAspect && <button onClick={() => { setActiveAspect(null); setViewer(null); }} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300">Close ✕</button>}</div>
            </div>
            <div className="p-4 sm:p-5">
              {!activeAspect && <div className="flex flex-col items-center justify-center py-20 text-center"><div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/20 bg-amber-400/[0.07] text-2xl text-amber-300/90">▣</div><p className="text-base font-bold text-white">Pick an aspect on the left</p><p className="mt-1 max-w-sm text-sm text-slate-400">Its work — renders, approvals, notes, content — fills this window. Status, actions and the prompt inbox sit on the right.</p><div className="mt-6 flex flex-wrap justify-center gap-2">{ASPECTS.map(a => <button key={a.id} onClick={() => openAspect(a.id)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200">{a.icon} {a.label}</button>)}</div></div>}

              {activeAspect === "scorsese" && <ScorseseReview comfy={comfy} mediaItems={mediaItems} viewer={viewer} setViewer={setViewer} comfyViewUrl={comfyViewUrl} uploadTasks={uploadTasks} uploadAspect={uploadAspect} setUploadAspect={setUploadAspect} onEnqueue={enqueueUploads} onCancel={cancelTask} onRetry={retryTask} onClearTask={clearTask} onClearFinished={clearFinished} onRefresh={loadComfy} onLibraryRefresh={loadMedia} />}
              {activeAspect === "jessica" && <JessicaReview drip={drip} queueCounts={queueCounts} emailQueue={emailQueue} approvedEmails={approvedEmails} verifiedBusy={verifiedBusy} setEmailVerified={setEmailVerified} />}
              {activeAspect === "contacts" && <ContactsReview never={never} importedTotal={importedTotal} dncTotal={dncTotal} approvedCount={approvedEmails.length} emailQueueCount={emailQueue.length} onOpenTable={openLeadSection} />}
              {activeAspect === "notes" && <NotesReview notes={notes} todayNote={todayNote} noteText={noteText} setNoteText={setNoteText} onSave={saveTodayNote} onDelete={deleteNote} noteSaving={noteSaving} />}
              {activeAspect === "shakespeare" && <ShakespeareReview content={content} onRefresh={loadContent} />}
            </div>
          </div>
        </div>

        {/* ---- RIGHT: per-aspect info + actions + prompt window ---- */}
        <aside className="min-w-0 lg:sticky lg:top-[76px] lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0e1219]/90 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
            <div className="border-b border-white/[0.06] px-4 py-3"><p className="silver-label text-[10px] font-bold uppercase tracking-[.18em]">Inspector</p><h3 className="mt-0.5 text-base font-bold tracking-tight text-white">{activeAspect ? activeLabel : "Nothing selected"}</h3></div>
            <div className="space-y-4 p-4">
              {/* ---- per-aspect status / stats ---- */}
              {!activeAspect && <p className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-4 text-center text-xs text-slate-500">Select an aspect to see its status, controls and prompt inbox here.</p>}

              {activeAspect === "scorsese" && <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">{comfy?.configured ? <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">GPU connected</span> : <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-300">GPU offline</span>}{comfyStat?.health?.ok && <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">health ok</span>}</div>
                <div className="space-y-1.5">
                  <InfoRow label="Render count" value={comfy ? comfy.count.toLocaleString() : "—"} accent="text-violet-300" />
                  <InfoRow label="Library items" value={String(mediaItems.length)} accent="text-amber-300" />
                  <InfoRow label="Device" value={comfyStat?.health?.device ?? "—"} accent="text-slate-200" />
                  <InfoRow label="VRAM free" value={fmtVram(comfyStat?.health?.vram_free)} accent="text-slate-200" />
                  <InfoRow label="ComfyUI" value={comfyStat?.health?.comfyui_version ?? "—"} accent="text-slate-200" />
                  <InfoRow label="Queue pending" value={String(comfyStat?.queue?.queue_pending?.length ?? 0)} accent="text-slate-200" />
                </div>
                <div className="border-t border-white/[0.06] pt-2">
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Uploads in progress</p>
                  <UploadsStrip tasks={uploadTasks} onCancel={cancelTask} onRetry={retryTask} />
                </div>
                <button onClick={() => { loadComfy(); loadMedia(); }} className="w-full rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-300 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-200">⟳ Refresh library</button>
              </div>}

              {activeAspect === "jessica" && <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">{drip?.dryRun && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black uppercase text-amber-300">Dry run</span>}<span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold text-slate-300">Status: {drip?.status ?? "…"}</span></div>
                <div className="grid grid-cols-5 gap-1.5 text-center">{(["pending", "sent", "skipped", "failed", "suppressed"] as const).map(k => <div key={k} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-1 py-2"><div className={`text-sm font-black ${k === "failed" ? "text-rose-300" : k === "sent" ? "text-emerald-300" : "text-amber-200"}`}>{queueCounts[k]}</div><div className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{k}</div></div>)}</div>
                <div className="space-y-1.5">
                  <InfoRow label="Next scheduled" value={drip?.nextScheduledAt ? new Date(drip.nextScheduledAt).toLocaleString() : "—"} accent="text-slate-200" />
                  <InfoRow label="Awaiting review" value={String(emailQueue.length)} accent="text-amber-300" />
                  <InfoRow label="Approved" value={String(approvedEmails.length)} accent="text-emerald-300" />
                </div>
                {(drip?.steps ?? []).length > 0 && <div className="space-y-1"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Drip steps</p>{drip!.steps!.map(s => <div key={s.step_order} className="flex items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[11px]"><span className="text-slate-300">Step {s.step_order} · D+{s.delay_days}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${s.status === "active" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.06] text-slate-400"}`}>{s.status}</span></div>)}</div>}
                <div className="grid grid-cols-3 gap-1.5"><button disabled={dripBusy !== null} onClick={() => dripAction("start")} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-2 py-2 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{dripBusy === "start" ? "Starting…" : "Run drip (dry)"}</button><button disabled={dripBusy !== null} onClick={() => dripAction("tick")} className="rounded-lg border border-white/10 px-2 py-2 text-xs font-bold text-slate-300 hover:border-amber-400/40 hover:text-amber-200 disabled:opacity-40">{dripBusy === "tick" ? "…" : "Tick now"}</button><button disabled={dripBusy !== null} onClick={() => dripAction("stop")} className="rounded-lg border border-rose-500/30 px-2 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">{dripBusy === "stop" ? "…" : "Stop"}</button></div>
                <p className="text-[10px] leading-4 text-slate-500">Sends are dry-run until the owner flips dry_run=false — Resend is never called from this UI. Approve / reject happens in the center queue.</p>
              </div>}

              {activeAspect === "contacts" && <div className="space-y-3">
                <div className="space-y-1.5">
                  <InfoRow label="Imported leads" value={importedTotal.toLocaleString()} accent="text-amber-300" />
                  <InfoRow label="DNC excluded" value={dncTotal.toLocaleString()} accent="text-rose-300" />
                  <InfoRow label="Verified emails" value={String(approvedEmails.length)} accent="text-emerald-300" />
                  <InfoRow label="Awaiting review" value={String(emailQueue.length)} accent="text-amber-300" />
                  <InfoRow label="Never relisted" value={never ? never.count.toLocaleString() : "—"} accent="text-sky-300" />
                </div>
                <div className="space-y-1"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Top never-relisted towns</p>{(never?.byTown ?? []).slice(0, 5).map(t => <div key={t.town} className="flex items-center gap-2"><span className="w-20 shrink-0 truncate text-[11px] text-slate-400">{t.town}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-amber-400/60 to-amber-300" style={{ width: `${Math.max(4, Math.round((t.count / ((never?.byTown[0]?.count) || 1)) * 100))}%` }} /></div><span className="w-9 shrink-0 text-right text-[10px] font-bold text-slate-300">{t.count.toLocaleString()}</span></div>)}{(never?.byTown ?? []).length === 0 && <p className="text-[11px] text-slate-500">No never-relisted data yet.</p>}</div>
                <button onClick={openLeadSection} className="w-full rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-2 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400">↓ Open the full leads table</button>
              </div>}

              {activeAspect === "notes" && <div className="space-y-3">
                <div className="space-y-1.5">
                  <InfoRow label="Today's note" value={todayNote ? "saved ✓" : "not saved yet"} accent={todayNote ? "text-emerald-300" : "text-amber-300"} />
                  <InfoRow label="Notes on file" value={String(notes.length)} accent="text-slate-200" />
                  <InfoRow label="Today" value={today} accent="text-slate-200" />
                </div>
                <div className="grid grid-cols-2 gap-1.5"><button onClick={saveTodayNote} disabled={noteSaving} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-2 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{noteSaving ? "Saving…" : "Save note"}</button>{todayNote && <button onClick={() => deleteNote(todayNote.id)} className="rounded-lg border border-rose-500/30 px-3 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/10">Delete today</button>}</div>
                <div className="space-y-1"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Recent notes</p>{notes.slice(0, 5).map(n => <div key={n.id} className="flex items-start justify-between gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5"><div className="min-w-0"><div className="text-[10px] font-bold uppercase text-amber-300/80">{n.note_date}</div><p className="truncate text-[11px] text-slate-300">{n.content}</p></div></div>)}{notes.length === 0 && <p className="text-[11px] text-slate-500">No notes yet.</p>}</div>
              </div>}

              {activeAspect === "shakespeare" && <div className="space-y-3">
                <div className="space-y-1.5">
                  <InfoRow label="Draft" value={String(content.filter(c => c.status === "draft").length)} accent="text-amber-300" />
                  <InfoRow label="Ready" value={String(content.filter(c => c.status === "ready").length)} accent="text-sky-300" />
                  <InfoRow label="Published" value={String(content.filter(c => c.status === "published").length)} accent="text-emerald-300" />
                </div>
                <button onClick={loadContent} className="w-full rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-300 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-200">⟳ Refresh</button>
                <div className="rounded-lg border border-white/[0.07] bg-[#0b0e14] px-3 py-2.5 text-[11px] leading-4 text-slate-500"><b className="text-slate-300">Staged docs:</b> <span className="text-amber-300/80">markpires-stories.md</span> (story bank) · <span className="text-amber-300/80">shakespeare-personalization.md</span> (10-question sheet). Once the owner answers, Shakespeare writes in his voice forever. Nothing is fabricated until it's live.</div>
              </div>}

              {/* ---- prompt window: per aspect ---- */}
              {activeAspect && <div className="border-t border-white/[0.06] pt-3">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Prompt window — {activeLabel}</p>
                <textarea value={promptDraft} onChange={e => setPromptDraft(e.target.value)} rows={3} placeholder={`Request edits, UGC or generated content for ${activeLabel}…`} className="w-full resize-y rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
                <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-slate-500">To the {ASPECTS.find(a => a.id === activeAspect)?.promptAspect} inbox.</span><button onClick={sendPrompt} disabled={promptSending} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-4 py-2 text-xs font-black text-amber-950 transition hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{promptSending ? "Sending…" : "Send →"}</button></div>
                <div className="mt-3 space-y-2">{prompts.length === 0 ? <p className="text-[11px] text-slate-500">No prompts yet for this aspect.</p> : prompts.slice(0, 6).map(p => <div key={p.id} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2"><div className="flex items-start justify-between gap-2"><p className="text-xs leading-4 text-slate-300">{p.prompt}</p><button onClick={() => cyclePromptStatus(p)} title="Click to cycle status" className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize ${promptStatusChip[p.status] || "bg-white/[0.07] text-slate-300"}`}>{p.status}</button></div><div className="mt-1 text-[10px] text-slate-600">{p.status === "new" ? "just submitted" : new Date(p.created_at).toLocaleString()}</div></div>)}</div>
              </div>}
            </div>
          </div>
        </aside>
      </div>

      {/* ============ LEADS TABLE (preserved, now capped at 500 + Load more) ============ */}
      <section id="leads-section" className="mt-10 scroll-mt-20">
        <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><SectionTitle eyebrow="Leads / Contacts" title="Prioritized prospects" detail="Focus your time where it matters most." /><div className="flex flex-wrap items-center gap-2"><span className="text-sm text-slate-400">{filtered.length > TABLE_PAGE ? `${visibleRows.toLocaleString()} of ${filtered.length.toLocaleString()} shown` : `${filtered.length} lead${filtered.length === 1 ? "" : "s"} shown`}</span><button onClick={() => window.confirm("Send outreach to every eligible lead with an email address? DNC and opted-out contacts will be skipped.") && sendEmail({ allWithEmail: true }, "All eligible", "all")} disabled={emailBusy !== null || filtered.length === 0} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-2 text-xs font-black text-amber-950 transition hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{emailBusy === "all" ? "Sending…" : "Email all with email"}</button></div></div>
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.08] bg-[#10141c] p-3"><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Source</label><select value={source} onChange={e => setSource(e.target.value)} className="rounded-lg border border-white/10 bg-[#0e1219] px-3 py-2 text-sm font-medium text-slate-200 outline-none focus:border-amber-400/50"><option value="all">All sources</option><option value="absentee">Absentee owners</option><option value="expired">Expired listings</option></select><label className="ml-1 text-xs font-bold uppercase tracking-wide text-slate-500">Min score</label><select value={minScore} onChange={e => setMinScore(e.target.value)} className="rounded-lg border border-white/10 bg-[#0e1219] px-3 py-2 text-sm font-medium text-slate-200 outline-none focus:border-amber-400/50"><option value="0">Any score</option><option value="50">50+</option><option value="70">70+</option><option value="85">85+</option></select><label className="ml-auto flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-300"><input type="checkbox" checked={showDnc} onChange={e => setShowDnc(e.target.checked)} className="h-4 w-4 accent-amber-400" /> Show DNC matches</label>{!showDnc && <span className="text-xs text-emerald-300">✓ DNC excluded</span>}</div>
        <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0e1219]/80 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">{filtered.length === 0 ? <EmptyState /> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left"><thead className="border-b border-white/[0.06] bg-white/[0.03] text-[11px] font-bold uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">Score</th><th className="px-3 py-3">Contact</th><th className="px-3 py-3">Location</th><th className="px-3 py-3">Property</th><th className="px-3 py-3">Source</th><th className="px-3 py-3"></th></tr></thead><tbody className="divide-y divide-white/[0.05]">{filtered.slice(0, visibleRows).map(lead => <LeadRow key={lead.id} lead={lead} open={expanded === lead.id} onToggle={() => setExpanded(expanded === lead.id ? null : lead.id)} onDraft={draftEmail} onSend={(l) => sendEmail({ leadId: l.id }, l.email ? `To ${l.email}` : "Lead", l.id)} busy={emailBusy} />)}</tbody></table></div>}</div>
        {filtered.length > visibleRows && <div className="mt-3 flex justify-center"><button onClick={() => setVisibleRows(v => v + TABLE_PAGE)} className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-5 py-2.5 text-sm font-bold text-amber-300 transition hover:bg-amber-400/15">↓ Load more <span className="text-[11px] font-semibold text-amber-300/70">({(filtered.length - visibleRows).toLocaleString()} remaining)</span></button></div>}
      </section>

      {/* ============ EXPLORE ENGINE (preserved) ============ */}
      <section className="mt-10"><SectionTitle eyebrow="Explore the engine" title="See LeadForge in action" detail="Generate sample records to explore the workflow. Sample contacts are clearly marked and are not real prospects." /><div className="mt-5 rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/[0.06] via-[#10141b]/80 to-[#0d1117]/80 p-5 sm:p-6"><div className="flex flex-col gap-4 lg:flex-row lg:items-center"><div className="flex-1"><div className="mb-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-gradient-to-b from-amber-300 to-amber-500 px-2.5 py-1 text-xs font-black text-amber-950">Featured</span><span className="text-sm font-semibold text-amber-200/90">Fairfield County, CT · Seller leads</span></div><select value={selectedType} onChange={e => setSelectedType(e.target.value)} className="w-full max-w-md rounded-xl border border-white/10 bg-[#0e1219] px-4 py-3 text-sm font-semibold text-slate-200 outline-none focus:border-amber-400/50">{(types.length ? types : [{ id: "real-estate", label: "Real Estate", description: "" }]).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div><div className="flex items-center gap-2">{[5,10,15,25].map(n => <button key={n} onClick={() => setCount(n)} className={`rounded-lg px-3 py-2 text-sm font-black transition ${count === n ? "bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950" : "bg-white/[0.05] text-amber-200 hover:bg-white/10"}`}>{n}</button>)}<button onClick={generate} disabled={generating} className="ml-2 rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 px-5 py-3 text-sm font-black text-amber-950 shadow-[0_0_20px_rgba(245,158,11,0.3)] transition hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{generating ? "Generating…" : "Generate leads →"}</button></div></div>{samples.length > 0 && <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{samples.map(l => <div key={l.id} className="rounded-xl border border-white/[0.08] bg-[#12161f] p-4"><div className="mb-2 flex justify-between"><span className="rounded bg-amber-400/15 px-2 py-1 text-[10px] font-black uppercase text-amber-300">Sample data</span><span className="text-xs font-bold text-amber-300">{l.location}</span></div><div className="font-bold text-white">{l.contact_name || l.company}</div><div className="mt-1 text-xs text-slate-400">{l.email || "Demo contact"} · {l.phone || "No phone"}</div></div>)}</div>}</div></section>

      {/* ============ BOTTOM: DATA & CRM INPUTS (preserved, compact) ============ */}
      <section className="mt-10">
        <SectionTitle eyebrow="Data &amp; CRM inputs" title="Imports, sleuth &amp; call lists" detail="Consolidated at the bottom to keep the monitor clean. CSV uploads score automatically." />
        <div className="mt-5 grid gap-4 lg:grid-cols-7">
          {sources.map(s => <UploadCard key={s.id} source={s} result={uploads[s.id]} busy={uploading === s.id} onUpload={upload} />)}
        </div>
        <p className="mt-3 text-xs text-slate-500">ⓘ DNC contacts are automatically excluded from all calls and emails. <span className="ml-2 text-rose-400">{uploadError}</span></p>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><a href="/api/call-list" download className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-400/10">↓ Call list CSV</a><a href="/api/call-list/pdf" download className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-400/10">↓ Call sheet PDF</a><button onClick={clearImported} className="rounded-lg border border-rose-500/30 bg-transparent px-3 py-1.5 text-xs font-bold text-rose-300 transition hover:bg-rose-500/10">✕ Clear all imported leads</button><span className="text-[11px] text-slate-500">erases imported rows — DNC list &amp; email history kept</span></div>

        {enrichStats && <div className="mt-5 rounded-2xl border border-white/[0.08] bg-[#0e1219]/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Enrichment stats</h4><span className="text-[10px] font-semibold text-slate-500">{enrichStats.totalLeads.toLocaleString()} leads on file · {enrichStats.perSource?.length ?? 0} sources</span></div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{[
          ["Reviewed", enrichStats.reviewedCount],
          ["With phone", enrichStats.withPhone],
          ["Email found", enrichStats.withEmail],
          ["Emails on lead", enrichStats.promotedEmails],
          ["With socials", enrichStats.withSocials],
          ["With context", enrichStats.withContext],
          ["DNC suppressed", enrichStats.dncSuppressed],
          ["Scored 70+", enrichStats.scored70plus],
        ].map(([label, v]) => <div key={String(label)} className="rounded-xl border border-white/[0.06] bg-[#12161f] px-3 py-2"><div className="text-lg font-black text-amber-300">{Number(v).toLocaleString()}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div></div>)}</div>
        {enrichStats.perSource && enrichStats.perSource.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-[11px]"><thead><tr className="text-[10px] font-bold uppercase tracking-wider text-slate-500"><th className="py-1 pr-3">Source</th><th className="py-1 pr-3">Total</th><th className="py-1 pr-3">Phone</th><th className="py-1 pr-3">Email</th><th className="py-1 pr-3">Socials</th></tr></thead><tbody className="divide-y divide-white/[0.04]">{enrichStats.perSource.map((r: any) => <tr key={r.source}><td className="py-1 pr-3 font-bold capitalize text-slate-300">{r.source}</td><td className="py-1 pr-3 text-slate-400">{Number(r.total).toLocaleString()}</td><td className="py-1 pr-3 text-slate-400">{r.withPhone}</td><td className="py-1 pr-3 text-slate-400">{r.withEmail}</td><td className="py-1 pr-3 text-slate-400">{r.withSocials}</td></tr>)}</tbody></table></div>}
      </div>}
      <div className="mt-5 rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/[0.07] via-[#10141b]/80 to-[#0d1117]/80 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400/10 text-amber-300">⌕</span><h3 className="font-bold text-white">Contact sleuth</h3></div><p className="mt-2 max-w-2xl text-xs leading-5 text-slate-400">Searches public web sources for phones, emails &amp; socials — every finding is DNC-checked before it appears. Public info only.</p></div><div className="flex flex-wrap items-center gap-2"><label className="text-xs font-bold text-slate-400">Batch</label><select value={enrichLimit} onChange={e => setEnrichLimit(e.target.value === "all" ? "all" : Number(e.target.value))} disabled={enriching} className="rounded-lg border border-white/10 bg-[#0e1219] px-3 py-2 text-sm font-semibold text-slate-200 outline-none focus:border-amber-400/50"><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option><option value="all">All</option></select><button onClick={enriching ? stopEnrichment : enrichContacts} className={`rounded-xl px-4 py-2.5 text-sm font-black transition ${enriching ? "bg-rose-600 text-white hover:bg-rose-500" : "bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950 shadow-[0_0_18px_rgba(245,158,11,0.28)] hover:from-amber-200 hover:to-amber-400"}`}><span className={enriching ? "inline-block animate-spin" : ""}>{enriching ? "↻" : "⌕"}</span> {enriching ? "Stop after this batch" : "Enrich contacts"}</button></div></div>{enrichedLeadCount !== null && <p className="mt-3 text-xs font-semibold text-slate-400">{enrichedLeadCount} of {leads.length} leads enriched</p>}{enriching && <p className="mt-3 text-xs font-semibold text-amber-300">Searching public sources… {enrichStatus ? `${enrichStatus.processed} processed · ${enrichStatus.remaining ?? "—"} remaining · ${enrichStatus.found} found so far` : "starting first batch…"}{enrichStop && " · stopping after this batch"}</p>}{enrichError && <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300">{enrichError}</p>}{enrichStatus && !enriching && <p className="mt-3 text-xs font-semibold text-emerald-300">Enriched {enrichStatus.processed} contacts — {enrichStatus.found} phone/email found, {enrichStatus.dncSuppressed} DNC-suppressed{enrichStatus.provider ? ` · provider: ${enrichStatus.provider}` : ""}.</p>}</div>

        <div className="mt-5"><EmailLogSection logs={logs} onRefresh={loadLogs} /></div>
      </section>

      {notice && <div className={`fixed bottom-5 right-5 z-40 max-w-md rounded-xl border px-4 py-3 text-sm font-semibold shadow-2xl ${notice.kind === "error" ? "border-rose-500/30 bg-[#2a1216] text-rose-200" : notice.kind === "success" ? "border-emerald-500/30 bg-[#0d2318] text-emerald-200" : "border-amber-400/30 bg-[#241a08] text-amber-200"}`}>{notice.text}<button onClick={() => setNotice(null)} className="ml-3 text-xs underline">Dismiss</button></div>}
      {draft && <EmailModal draft={draft} onClose={() => setDraft(null)} />}
      <p className="mt-8 text-center text-xs text-slate-500">Mission Control · LeadForge — outreach email: draft + send from the leads table · AI chat (Kokoro) reserved for the bottom-left slot next.</p>
    </main></div>;
}

/* ============ shared pieces ============ */

function SectionTitle({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) { return <div><p className="silver-label text-xs font-bold uppercase tracking-[.18em]">{eyebrow}</p><h2 className="mt-1 text-xl font-bold tracking-tight text-white">{title}</h2><p className="mt-1 text-sm text-slate-400">{detail}</p></div>; }

function InfoRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return <div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-semibold text-slate-500">{label}</span><span className={`shrink-0 text-xs font-black ${accent}`}>{value}</span></div>;
}

function CompactAspect({ id, label, icon, stat, active, onClick }: { id: AspectId; label: string; icon: string; stat: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} aria-pressed={active} className={`group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${active ? "border-amber-400/60 bg-gradient-to-b from-[#1a1508] to-[#10141c] shadow-[0_0_16px_rgba(245,158,11,0.15)]" : "border-white/[0.08] bg-[#10141c]/70 hover:border-amber-400/40 hover:bg-[#141a25]"}`}>
    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base ${active ? "bg-amber-400/15 text-amber-300" : "bg-white/[0.06] text-amber-300"}`}>{icon}</span>
    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-white">{label}</span><span className="block truncate text-[10px] text-slate-400">{stat}</span></span>
    <span className={`ml-auto text-[10px] font-black ${active ? "text-amber-300" : "text-amber-400/50 group-hover:text-amber-300"}`}>{active ? "●" : "→"}</span>
  </button>;
}

function ScorseseReview({ comfy, mediaItems, viewer, setViewer, comfyViewUrl, uploadTasks, uploadAspect, setUploadAspect, onEnqueue, onCancel, onRetry, onClearTask, onClearFinished, onRefresh, onLibraryRefresh }: {
  comfy: { configured: boolean; entries: ComfyEntry[]; count: number; error?: string } | null;
  mediaItems: MediaItem[];
  viewer: ViewerMedia | null;
  setViewer: (e: ViewerMedia | null) => void;
  comfyViewUrl: (e: ComfyEntry) => string;
  uploadTasks: UploadTask[];
  uploadAspect: string;
  setUploadAspect: (a: string) => void;
  onEnqueue: (files: File[], aspect: string) => void;
  onCancel: (key: string) => void;
  onRetry: (key: string) => void;
  onClearTask: (key: string) => void;
  onClearFinished: () => void;
  onRefresh: () => void;
  onLibraryRefresh: () => void;
}) {
  // merged library: ComfyUI renders + uploaded/remote media items, newest-first by source order
  const entries = useMemo<ViewerMedia[]>(() => {
    const renders = (comfy?.entries ?? []).map<ViewerMedia>((e) => ({ key: `r-${e.prompt_id}-${e.filename}`, title: e.title, kind: e.kind, url: comfyViewUrl(e), source: "render" }));
    const ups = mediaItems.map<ViewerMedia>((m) => ({ key: `m-${m.id}`, title: m.title || m.filename, kind: m.kind, url: mediaItemUrl(m), source: m.source === "remote" ? "remote" : "upload", id: m.id, filename: m.filename }));
    return [...renders, ...ups];
  }, [comfy, mediaItems, comfyViewUrl]);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<number | null>(null);

  async function playEntry(e: ViewerMedia) {
    setViewerError(null);
    if (e.source === "remote") {
      // Pre-check the F: drive proxy so a 503 ("remote storage not configured")
      // shows a friendly note instead of a broken player.
      try {
        const res = await fetch(e.url);
        if (!res.ok) {
          setViewerError(res.status === 503 ? "Remote storage not configured — the F: drive receiver isn't set up yet. Local uploads still play fine." : `Remote storage unreachable (HTTP ${res.status}).`);
          return;
        }
        res.body?.cancel();
      } catch { setViewerError("Remote storage unreachable right now."); return; }
    }
    setViewer(e);
  }

  async function deleteEntry(e: ViewerMedia) {
    if (e.id == null || e.source === "render") return;
    const remoteNote = e.source === "remote" ? " The file on the F: drive is left in place — only the library row is removed." : " The local file is removed too.";
    if (!window.confirm(`Delete "${e.title}" from the library?${remoteNote}`)) return;
    setBusyDelete(e.id);
    try { await fetch(`/api/media/${e.id}`, { method: "DELETE" }); } catch { /* reconcile below */ }
    setBusyDelete(null);
    onLibraryRefresh();
  }

  return <div>
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]">{comfy?.configured ? <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 font-bold text-emerald-300">GPU connected</span> : <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 font-bold text-rose-300">GPU offline</span>}<span className="text-slate-500">{comfy?.count ?? 0} renders · {mediaItems.length} uploads · {entries.length} items</span>{comfy?.error && <span className="text-rose-400">{comfy.error}</span>}<button onClick={() => { onRefresh(); onLibraryRefresh(); }} className="ml-auto rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-bold text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200">⟳ Refresh library</button></div>

    {/* upload zone — drag-drop raw footage + assets, chunked, with progress */}
    <MediaUploadZone tasks={uploadTasks} aspect={uploadAspect} setAspect={setUploadAspect} onEnqueue={onEnqueue} onCancel={onCancel} onRetry={onRetry} onClearTask={onClearTask} onClearFinished={onClearFinished} />

    {/* big player */}
    <div className="mb-4 overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_10px_50px_rgba(0,0,0,0.55)]">
      {viewer ? <><div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0b0e14] px-4 py-2.5"><span className="truncate text-xs font-semibold text-slate-300">{viewer.title}</span><span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-black uppercase text-amber-300">{viewer.kind}{viewer.source === "remote" ? " · F:" : ""}</span><button onClick={() => setViewer(null)} className="shrink-0 text-xs text-slate-500 hover:text-white" title="Close player">✕</button></div>{viewer.kind === "video" ? <video controls src={viewer.url} className="max-h-[58vh] w-full bg-black" />
        : viewer.kind === "image" ? <img src={viewer.url} alt={viewer.title} className="max-h-[58vh] w-full bg-black object-contain" />
        : viewer.kind === "audio" ? <div className="grid min-h-[30vh] place-items-center bg-black/60"><div className="w-full max-w-xl px-6 text-center"><div className="mb-3 text-3xl text-amber-300/70">♪</div><audio controls src={viewer.url} className="w-full" /></div></div>
        : <div className="grid min-h-[30vh] place-items-center bg-black/60"><a href={viewer.url} target="_blank" rel="noreferrer" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-bold text-amber-300 transition hover:bg-amber-400/20">Open document ↗</a></div>}
        {viewerError && <div className="border-t border-rose-500/25 bg-rose-500/10 px-4 py-2.5 text-xs font-semibold text-rose-300">{viewerError}</div>}
      </> : <div className="grid min-h-[38vh] place-items-center bg-black/60"><div className="px-4 text-center"><div className="mb-3 text-4xl text-amber-300/60">◉</div><p className="text-sm font-bold text-slate-200">Select an item below to review it full-size</p><p className="mt-1 text-xs text-slate-500">{entries.length} items in the library — uploads and renders stream through the app, never the GPU tunnel.</p></div></div>}
    </div>

    {/* merged library — uploads + remote + renders */}
    <MediaLibrary entries={entries} filter={filter} setFilter={setFilter} viewerKey={viewer?.key} onPlay={playEntry} onDelete={deleteEntry} busyDelete={busyDelete} />
    <p className="mt-3 text-[11px] text-slate-500">Renders &amp; uploads stream through the app — the GPU tunnel is never exposed to the browser. Remote items carry an <span className="font-bold text-sky-300">F:</span> badge; local files play from app storage. Video thumbnails are first-frame previews.</p>
  </div>;
}

function JessicaReview({ drip, queueCounts, emailQueue, approvedEmails, verifiedBusy, setEmailVerified }: { drip: DripStatus | null; queueCounts: { pending: number; sent: number; skipped: number; failed: number; suppressed: number }; emailQueue: EmailLead[]; approvedEmails: EmailLead[]; verifiedBusy: number | null; setEmailVerified: (l: EmailLead, v: 0 | 1) => void }) {
  return <div>
    <div className="mb-4 flex flex-wrap gap-2">{drip?.dryRun && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black uppercase text-amber-300">Dry run</span>}<span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold text-slate-300">Status: {drip?.status ?? "…"}</span>{drip?.nextScheduledAt && <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold text-slate-300">Next step {new Date(drip.nextScheduledAt).toLocaleString()}</span>}<span className="ml-auto text-[11px] text-slate-500">drip controls on the right →</span></div>
    <div className="mb-4 grid grid-cols-5 gap-2 text-center">{(["pending", "sent", "skipped", "failed", "suppressed"] as const).map(k => <div key={k} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-1 py-2.5"><div className={`text-lg font-black ${k === "failed" ? "text-rose-300" : k === "sent" ? "text-emerald-300" : "text-amber-200"}`}>{queueCounts[k]}</div><div className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{k}</div></div>)}</div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Awaiting review</span><span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-black text-amber-300">{emailQueue.length}</span></div>
        {emailQueue.length === 0 ? <p className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-6 text-center text-xs text-slate-500">Nothing waiting — run the contact sleuth (bottom of the page) to populate the queue.</p> : <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">{emailQueue.slice(0, 16).map(l => <div key={l.id} className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-bold text-slate-200">{l.name || "Unknown"}</div><div className="truncate text-[11px] text-slate-400">{l.email}{l.town ? ` · ${l.town}` : ""}</div></div><div className="flex shrink-0 items-center gap-1.5">{l.score != null && <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${scoreChip(l.score)}`}>{l.score}</span>}<button disabled={verifiedBusy === l.id} onClick={() => setEmailVerified(l, 1)} className="rounded-md border border-emerald-400/30 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-40">✓ Approve</button><button disabled={verifiedBusy === l.id} onClick={() => setEmailVerified(l, 0)} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-400 hover:bg-white/5 disabled:opacity-40">✕</button></div></div></div>)}</div>}
      </div>
      <div className="min-w-0"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Approved for outreach</span><span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-black text-emerald-300">{approvedEmails.length}</span></div>
        {approvedEmails.length === 0 ? <p className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-6 text-center text-xs text-slate-500">No approved emails yet — approve from the queue on the left.</p> : <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">{approvedEmails.slice(0, 16).map(l => <div key={l.id} className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-bold text-slate-200">{l.name || "Unknown"}</div><div className="truncate text-[11px] text-emerald-300/80">{l.email}{l.town ? ` · ${l.town}` : ""}</div></div><div className="flex shrink-0 items-center gap-1.5"><span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-black uppercase text-emerald-300">approved</span><button disabled={verifiedBusy === l.id} onClick={() => setEmailVerified(l, 0)} className="rounded-md border border-rose-500/30 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">Reject</button></div></div></div>)}</div>}
      </div>
    </div>
    <p className="mt-3 text-[11px] text-slate-500">Sends are dry-run until the owner flips dry_run=false — Resend is never called from this UI.</p>
  </div>;
}

function ContactsReview({ never, importedTotal, dncTotal, approvedCount, emailQueueCount, onOpenTable }: { never: { count: number; byTown: TownCount[] } | null; importedTotal: number; dncTotal: number; approvedCount: number; emailQueueCount: number; onOpenTable: () => void }) {
  const topTowns = (never?.byTown ?? []).slice(0, 12);
  return <div>
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"><div className="text-2xl font-black text-amber-300">{importedTotal.toLocaleString()}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Imported leads</div></div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"><div className="text-2xl font-black text-rose-300">{dncTotal.toLocaleString()}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">DNC excluded</div></div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"><div className="text-2xl font-black text-emerald-300">{approvedCount}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Verified emails</div></div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"><div className="text-2xl font-black text-sky-300">{emailQueueCount}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Awaiting review</div></div>
    </div>
    <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Never-relisted by town <span className="normal-case text-slate-600">({never?.count.toLocaleString() ?? "—"} total)</span></p>
    {topTowns.length === 0 ? <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-8 text-center text-xs text-slate-500">No never-relisted data yet.</p> : <div className="mb-4 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">{topTowns.map(t => <div key={t.town} className="flex items-center gap-2"><span className="w-24 shrink-0 truncate text-xs text-slate-400">{t.town}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-amber-400/60 to-amber-300" style={{ width: `${Math.max(4, Math.round((t.count / (topTowns[0]?.count || 1)) * 100))}%` }} /></div><span className="w-10 shrink-0 text-right text-[11px] font-bold text-slate-300">{t.count.toLocaleString()}</span></div>)}</div>}
    <button onClick={onOpenTable} className="w-full rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-2.5 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400">↓ Open the full leads table</button>
  </div>;
}

function NotesReview({ notes, todayNote, noteText, setNoteText, onSave, onDelete, noteSaving }: { notes: Note[]; todayNote?: Note; noteText: string; setNoteText: (s: string) => void; onSave: () => void; onDelete: (id: number) => void; noteSaving: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-4"><p className="mb-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Today's note — {today}</p><textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={8} placeholder={todayNote ? "Edit today's note…" : "What happened today? Wins, calls, follow-ups…"} className="w-full resize-y rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm leading-6 text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" /><div className="mt-2 flex items-center justify-between gap-2"><span className="text-[11px] text-slate-500">Saved per day · kept forever{todayNote ? ` · last updated ${todayNote.updated_at ? new Date(todayNote.updated_at).toLocaleTimeString() : ""}` : ""}</span><button onClick={onSave} disabled={noteSaving} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-4 py-2 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">{noteSaving ? "Saving…" : "Save note"}</button></div></div>
    </div>
    <div className="min-w-0">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Recent notes <span className="normal-case text-slate-600">({notes.length} on file)</span></p>
      {notes.length === 0 ? <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-8 text-center text-xs text-slate-500">No notes yet — save your first daily note.</p> : <div className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">{notes.slice(0, 20).map(n => <div key={n.id} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2"><div className="flex items-start justify-between gap-2"><div><div className="text-[10px] font-bold uppercase text-amber-300/80">{n.note_date}</div><p className="mt-0.5 text-xs leading-4 text-slate-300">{n.content}</p></div><button onClick={() => onDelete(n.id)} className="shrink-0 text-[11px] text-slate-600 hover:text-rose-300" title="Delete note">✕</button></div></div>)}</div>}
    </div>
  </div>;
}

const contentStatusChip: Record<string, string> = {
  draft: "bg-amber-400/15 text-amber-300 border-amber-400/30",
  ready: "bg-sky-400/15 text-sky-300 border-sky-400/30",
  published: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
};

function ShakespeareReview({ content, onRefresh }: { content: ContentPost[]; onRefresh: () => void }) {
  // DB-driven mode: piece library from content_posts + full reader.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [full, setFull] = useState<ContentPost | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [readError, setReadError] = useState("");
  // Staged fallback (empty DB): keep the original static rendering so the pane
  // never looks broken before the first real post is ingested.
  const [stagedPiece, setStagedPiece] = useState(STAGED_PIECES[0]);

  const dbMode = content.length > 0;
  const selectedPost = content.find(c => c.id === selectedId) ?? null;

  async function selectPost(p: ContentPost) {
    setSelectedId(p.id); setFull(null); setReadError(""); setLoadingFull(true);
    try {
      const r = await fetch(`/api/content/${p.id}`);
      if (!r.ok) throw new Error(`Could not load piece (HTTP ${r.status})`);
      const d = await r.json();
      setFull(d.post ?? null);
      if (!d.post) setReadError("Piece not found.");
    } catch (e) { setReadError(e instanceof Error ? e.message : "Could not load piece"); }
    finally { setLoadingFull(false); }
  }

  // ---- empty-DB fallback: identical rendering to the original staged library ----
  if (!dbMode) {
    return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="min-w-0">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Piece library <span className="normal-case text-slate-600">({STAGED_PIECES.length} staged)</span></p>
        <div className="space-y-1.5">{STAGED_PIECES.map(p => <button key={p.id} onClick={() => setStagedPiece(p)} className={`w-full rounded-lg border px-3 py-2 text-left transition ${stagedPiece.id === p.id ? "border-amber-400/50 bg-amber-400/[0.06]" : "border-white/[0.07] bg-white/[0.03] hover:border-amber-400/30"}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-bold text-slate-200">{p.title}</span></div><div className="mt-0.5 flex items-center justify-between gap-2"><span className="truncate text-[10px] text-slate-500">{p.kind}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${p.status.includes("owner") ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"}`}>{p.status}</span></div></button>)}</div>
      </div>
      <div className="min-w-0">
        <div className="rounded-xl border border-white/[0.07] bg-[#0b0e14] px-4 py-4"><div className="mb-1 flex items-center justify-between gap-2"><p className="text-sm font-bold text-white">{stagedPiece.title}</p><span className="shrink-0 text-[10px] text-slate-500">{stagedPiece.date}</span></div><div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-amber-300/80">{stagedPiece.kind}</div><p className="text-sm leading-6 text-slate-300">{stagedPiece.excerpt}</p><div className="mt-4 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-[11px] leading-4 text-slate-500">Full piece is staged in the content corpus for owner review — nothing is published or sent until it's approved. The writer pipeline connects here in the next workstream; his prompt window on the right already lands in the prompt inbox.</div></div>
      </div>
    </div>;
  }

  // ---- live mode: DB piece library + full reader ----
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Piece library <span className="normal-case text-slate-600">({content.length} in DB)</span></p>
        <button onClick={onRefresh} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-400 transition hover:border-amber-400/40 hover:text-amber-200" title="Refresh the library">⟳</button>
      </div>
      <div className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">{content.map(p => <button key={p.id} onClick={() => selectPost(p)} className={`w-full rounded-lg border px-3 py-2 text-left transition ${selectedPost?.id === p.id ? "border-amber-400/50 bg-amber-400/[0.06]" : "border-white/[0.07] bg-white/[0.03] hover:border-amber-400/30"}`}>
        <div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-bold text-slate-200">{p.title}</span>{p.town_focus && <span className="shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[9px] font-bold uppercase text-slate-300">{p.town_focus}</span>}</div>
        <div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-[10px] text-slate-500">{p.slug}</span><span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase ${contentStatusChip[p.status] || "bg-white/[0.07] text-slate-300"}`}>{p.status}</span></div>
      </button>)}</div>
    </div>
    <div className="min-w-0">
      <div className="rounded-xl border border-white/[0.07] bg-[#0b0e14] px-4 py-4">
        {!selectedPost && !loadingFull && <div className="grid min-h-[30vh] place-items-center py-8 text-center"><div className="px-4"><div className="mb-3 text-3xl text-amber-300/60">✎</div><p className="text-sm font-bold text-slate-200">Select a piece to read it</p><p className="mt-1 text-xs text-slate-500">{content.length} piece{content.length === 1 ? "" : "s"} in the library — rendered straight from the content DB.</p></div></div>}
        {loadingFull && <div className="grid min-h-[30vh] place-items-center py-8 text-center"><p className="text-xs text-slate-400">Loading piece…</p></div>}
        {selectedPost && !loadingFull && full && <div>
          <div className="mb-1 flex items-center justify-between gap-2"><p className="text-base font-bold text-white">{full.meta_title || full.title}</p><span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase ${contentStatusChip[full.status] || "bg-white/[0.07] text-slate-300"}`}>{full.status}</span></div>
          {full.town_focus && <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-amber-300/80">{full.town_focus}{full.published_at ? ` · published ${new Date(full.published_at).toLocaleDateString()}` : ""}</div>}
          {full.source_question && <div className="mb-3 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[11px] italic leading-4 text-slate-400"><b className="not-italic text-slate-300">Source question:</b> {full.source_question}</div>}
          <div className="content-article max-h-[52vh] overflow-y-auto pr-1 text-sm leading-6 text-slate-300" dangerouslySetInnerHTML={{ __html: markdownToHtml(full.body_markdown || "") }} />
          {full.cta_url && <a href={full.cta_url} target="_blank" rel="noreferrer" className="mt-4 inline-block rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-400/20">{full.cta_url} ↗</a>}
        </div>}
        {selectedPost && !loadingFull && !full && !readError && <p className="py-10 text-center text-xs text-slate-500">No content yet for this piece.</p>}
        {readError && <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5 text-xs font-semibold text-rose-300">{readError}</div>}
      </div>
    </div>
  </div>;
}

function UploadCard({ source, result, busy, onUpload }: { source: typeof sources[number]; result?: string; busy: boolean; onUpload: (file: File, kind: string) => void }) { const ref = useRef<HTMLInputElement>(null); return <div className={`rounded-2xl border bg-gradient-to-b from-[#141923] to-[#0f131b] p-4 shadow-[0_4px_20px_rgba(0,0,0,0.35)] transition hover:-translate-y-0.5 hover:border-amber-400/40 ${source.id === "dnc" ? "border-rose-500/25" : "border-white/[0.08]"}`}><div className="mb-3 flex items-start justify-between"><div className={`grid h-9 w-9 place-items-center rounded-lg text-lg ${source.id === "dnc" ? "bg-rose-500/10 text-rose-300" : "bg-white/[0.06] text-amber-300"}`}>{source.icon}</div>{result && <span className="text-[10px] font-bold text-emerald-300">Uploaded ✓</span>}</div><h3 className="text-sm font-bold text-white">{source.label}</h3><p className="mt-0.5 min-h-8 text-[11px] leading-4 text-slate-400">{source.hint}</p><input ref={ref} type="file" accept=".csv,text/csv,.txt,text/plain" className="hidden" onChange={e => e.target.files?.[0] && onUpload(e.target.files[0], source.id)} /><button onClick={() => ref.current?.click()} disabled={busy} className="mt-3 w-full rounded-lg border border-white/10 py-2 text-xs font-bold text-slate-300 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-200 disabled:opacity-40">{busy ? "Uploading…" : "Choose file (.csv / .txt)"}</button>{result && <p className="mt-2 text-[10px] font-semibold text-slate-400">{result}</p>}</div>; }

function EmptyState() { return <div className="flex flex-col items-center justify-center px-6 py-16 text-center"><div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/20 bg-amber-400/[0.07] text-2xl text-amber-300/90">⌁</div><h3 className="font-bold text-white">No leads yet</h3><p className="mt-1 text-sm text-slate-400">No leads yet — upload a CSV in the Data &amp; CRM inputs below.</p></div>; }

function LeadRow({ lead, open, onToggle, onDraft, onSend, busy }: { lead: Lead; open: boolean; onToggle: () => void; onDraft: (l: Lead) => void; onSend: (l: Lead) => void; busy: string | number | "all" | null }) {
  const enriched = lead.enriched ?? {}; const displayPhone = lead.phone || enriched.phone; const displayEmail = lead.email || enriched.email;
  const blocked = !!(lead.dnc_matched || lead.opted_out || lead.opt_out || !displayEmail);
  const socials = (enriched.socials ?? []).filter(s => s.url);
  return <><tr className="transition hover:bg-white/[0.04]"><td className="px-5 py-4"><span className={`inline-flex min-w-10 justify-center rounded-md px-2 py-1 text-sm font-black ${scoreChip(lead.score ?? 0)}`}>{lead.score ?? 0}</span></td><td className="px-3 py-4"><div className="font-bold text-slate-100">{lead.contact_name || "Unknown contact"}</div><div className="text-xs text-slate-400">{displayPhone ? <>{displayPhone}{!lead.phone && <span className="ml-1 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-black uppercase text-amber-300">web</span>}</> : "—"} <span className="mx-1">·</span> {displayEmail ? <>{displayEmail}{!lead.email && <span className="ml-1 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-black uppercase text-amber-300">web</span>}</> : "—"}</div>{(enriched.phone || enriched.email) && enriched.source_url && <a href={enriched.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[10px] font-semibold text-amber-300 underline">source</a>}{socials.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{socials.map((s, i) => <a key={`${s.url}-${i}`} href={s.url} target="_blank" rel="noreferrer" className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold capitalize text-slate-300 hover:bg-amber-400/20 hover:text-amber-300">{s.platform || "social"}</a>)}</div>}{blocked && <div className="mt-1 text-[11px] font-semibold text-rose-400">No email / {lead.dnc_matched ? "DNC" : lead.opted_out || lead.opt_out ? "opted out" : "send skipped"}</div>}</td><td className="px-3 py-4 text-sm">{lead.town || "—"}{lead.state && `, ${lead.state}`}</td><td className="max-w-[220px] truncate px-3 py-4 text-sm text-slate-400">{lead.property_address || "—"}</td><td className="px-3 py-4"><span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold capitalize text-slate-300">{lead.source || "imported"}</span>{lead.dnc_matched && <span className="ml-1 rounded-full bg-rose-500/15 px-2 py-1 text-[10px] font-bold text-rose-300">DNC</span>}{(() => { const status = lead.market_status || (lead.agent_attached ? "agent" : lead.listed_active ? "active" : lead.listed_pending ? "pending" : lead.closed_recently ? "closed" : null); const styles: Record<string, string> = { agent: "bg-amber-400/15 text-amber-300", active: "bg-sky-400/15 text-sky-300", pending: "bg-violet-400/15 text-violet-300", closed: "bg-white/10 text-slate-300" }; return status ? <span className={`ml-1 rounded-full px-2 py-1 text-[10px] font-bold ${styles[status] || "bg-white/[0.07] text-slate-300"}`}>{status}</span> : null; })()}</td><td className="px-3 py-4"><div className="flex items-center gap-1"><button disabled={blocked || busy !== null} onClick={() => onDraft(lead)} className="rounded-lg border border-amber-400/30 px-2 py-1 text-xs font-bold text-amber-300 hover:bg-amber-400/10 disabled:opacity-40">{busy === lead.id ? "…" : "Draft"}</button><button disabled={blocked || busy !== null} onClick={() => onSend(lead)} className="rounded-lg bg-gradient-to-b from-amber-300 to-amber-500 px-2 py-1 text-xs font-black text-amber-950 hover:from-amber-200 hover:to-amber-400 disabled:opacity-40">Send</button><button onClick={onToggle} className="rounded-lg px-2 py-1 text-lg text-slate-500 hover:bg-white/5 hover:text-amber-300" aria-label="Show score details">{open ? "⌃" : "⌄"}</button></div></td></tr>{open && <tr className="bg-white/[0.025]"><td colSpan={6} className="px-5 py-4"><div className="flex flex-wrap gap-2"><span className="mr-2 text-xs font-bold uppercase tracking-wide text-amber-300">Score breakdown</span>{Object.entries(lead.score_breakdown ?? {}).map(([key, value]) => <span key={key} className="rounded-lg border border-white/10 bg-[#151a24] px-3 py-1.5 text-xs text-slate-300">{key}: <b className="text-amber-300">+{value}</b></span>)}</div></td></tr>}</>;
}

function EmailModal({ draft, onClose }: { draft: { lead: Lead; email: EmailDraft }; onClose: () => void }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}><div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-white/10 bg-[#11151d] p-6 shadow-2xl" onClick={e => e.stopPropagation()}><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-amber-400">Email draft</p><h2 className="mt-1 text-xl font-bold text-white">{draft.email.subject}</h2><p className="mt-1 text-xs text-slate-400">To: {draft.email.to || draft.lead.email || "—"} · From: {draft.email.from || "configured sender"}</p></div><button onClick={onClose} className="text-2xl text-slate-400 hover:text-white">×</button></div><pre className="mt-5 max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.08] bg-[#0b0e14] p-4 font-sans text-sm leading-6 text-slate-300">{draft.email.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")}</pre></div></div>; }

function EmailLogSection({ logs, onRefresh }: { logs: EmailLog[]; onRefresh: () => void }) { const colors: Record<string, string> = { sent: "bg-emerald-400/15 text-emerald-300", failed: "bg-rose-500/15 text-rose-300", bounced: "bg-orange-400/15 text-orange-300", complained: "bg-rose-500/15 text-rose-300", delivered: "bg-blue-400/15 text-blue-300", opened: "bg-teal-400/15 text-teal-300", clicked: "bg-teal-400/15 text-teal-300", dry_run: "bg-amber-400/15 text-amber-300" }; return <div><div className="mb-4 flex items-end justify-between"><SectionTitle eyebrow="Jessica / outreach" title="Email activity" detail="Recent sends and delivery events from the outreach pipeline." /><button onClick={onRefresh} className="rounded-lg border border-white/10 bg-[#11151d] px-3 py-2 text-xs font-bold text-slate-300 transition hover:border-amber-400/40 hover:text-amber-200">Refresh</button></div><div className="max-h-72 overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#0e1219]/80 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">{logs.length === 0 ? <p className="p-6 text-sm text-slate-400">No email activity yet.</p> : <table className="w-full min-w-[700px] text-left text-sm"><thead className="sticky top-0 border-b border-white/[0.06] bg-[#0e1219] text-[11px] font-bold uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">Recipient</th><th className="px-3 py-3">Subject</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Time</th></tr></thead><tbody className="divide-y divide-white/[0.05]">{logs.slice(0, 50).map(l => <tr key={l.id}><td className="px-5 py-3">{l.recipient_email || "—"}</td><td className="max-w-[280px] truncate px-3 py-3">{l.subject || "—"}{l.error && <div className="text-xs text-rose-400">{l.error}</div>}</td><td className="px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${colors[l.status || ""] || "bg-white/[0.07] text-slate-300"}`}>{l.status || "unknown"}</span></td><td className="px-3 py-3 text-xs text-slate-500">{l.sent_at ? new Date(l.sent_at).toLocaleString() : "—"}</td></tr>)}</tbody></table>}</div></div>; }
