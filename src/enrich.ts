import { execFile } from "node:child_process";
import { join } from "node:path";
import { db } from "~/db";
import { digits, emailNorm } from "~/import-scoring";

export const ENRICH_DEPTH = { maxQueryAngles: 18, pagesPerQuery: 2, maxCandidatePages: 10, maxPhones: 8, maxEmails: 8, maxSocials: 8, requestDelayMs: 700 } as const;
export type EnrichLead = { id: number; contact_name?: string | null; town?: string | null; state?: string | null; zip?: string | null; property_address?: string | null; mailing_address?: string | null; raw?: string | null };
export type Social = { platform: string; url: string };
export type Finding = { phone?: string; email?: string; socials: Social[]; source_url: string; query: string; dnc_matched: number; provider?: string };
type TextPage = { url: string; text: string; title?: string };
type SearchResult = { pages: TextPage[] };
const BLOCKED = /(?:example\.com|sentry\.io|wixpress|schema\.org|localhost|yourdomain)/i;
const JUNK_HOSTS = new Set(["google.com", "www.google.com", "bing.com", "www.bing.com"]);
const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const phoneRe = /(?:\+?1[\s.\-()]*)?(?:\(?\d{3}\)?[\s.\-]*)\d{3}[\s.\-]*\d{4}/g;

// ── Extractor hardening (2026-08-11 outreach stage 1) ────────────────────────
// Strict email shape: local part ≥2 chars, dotted domain, sane TLD. Then reject
// asset/image-looking addresses (court_summary@2x.05bf0b67.png, @2x logos) and
// placeholder/junk domains (sentry.io, wixstatic, asset CDNs, tracker pixels).
const EMAIL_STRICT = /^[a-z0-9._%+-]{2,}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const ASSET_TLDS = /\.(?:png|jpe?g|webp|gif|svg|ico|bmp|avif|css|js|mjs|woff2?|ttf|eot|map|json|xml|txt|pdf)$/i;
const EMAIL_JUNK_HOSTS = new Set([
  "sentry.io", "schemastore.org", "wixstatic.com", "wixpress.com",
  "example.com", "localhost", "yourdomain.com", "gstatic.com", "googleusercontent.com",
]);
const EMAIL_JUNK_PATTERN = /(?:cloudinary|imgix|cloudfront|googleusercontent|githubusercontent|yimg|akamaized|fastly|gravatar|doubleclick|googlesyndication|unpkg|jsdelivr|cdn\.|schemastore|sentry\.io|wixstatic|wixpress)/i;
export function isValidEmail(value: string): boolean {
  const v = String(value || "").trim().toLowerCase();
  if (!EMAIL_STRICT.test(v)) return false;
  const at = v.lastIndexOf("@");
  const local = v.slice(0, at), domain = v.slice(at + 1);
  if (local.length < 2 || !domain.includes(".")) return false;
  if (ASSET_TLDS.test(domain)) return false;
  if (/@2x/i.test(v) || /(?:^|\.)2x(?:\.|$)/i.test(domain)) return false;
  if (EMAIL_JUNK_HOSTS.has(domain)) return false;
  for (const junk of EMAIL_JUNK_HOSTS) if (domain.endsWith("." + junk)) return false;
  if (EMAIL_JUNK_PATTERN.test(domain)) return false;
  return true;
}
// Phones: exactly 10 US digits (11 starting with 1 → drop the 1). Reject
// toll-free/non-geographic (800/888/877/866/855/844/900), fake area codes
// (0xx/1xx — the (100)/(011) patterns seen in data), repeat area codes
// (000/111/222-style), and NANP-invalid exchanges starting 0/1.
export function normalizePhone(value: string): string | null {
  const d = digits(value);
  let v = d;
  if (v.length === 11 && v.startsWith("1")) v = v.slice(1);
  if (v.length !== 10) return null;
  const ac = v.slice(0, 3), ex = v.slice(3, 6);
  if (/^[01]\d\d$/.test(ac)) return null;
  if (/^(\d)\1\1$/.test(ac)) return null;
  if (/^(?:800|888|877|866|855|844|900)/.test(v)) return null;
  if (/^[01]/.test(ex)) return null;
  return v;
}
// Person-match gate (the key quality check): the source page corpus must
// mention the lead's last name OR the lead's town (case-insensitive) or the
// finding is dropped. Kills celebrity-bio / union-contact-page false positives.
function mentionsPerson(text: string, lead?: EnrichLead): boolean {
  if (!lead) return true;
  const hay = String(text || "").toLowerCase();
  const parts = String(lead.contact_name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const firstName = parts[0] || "";
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  const fullName = parts.join(" ");
  const town = String(lead.town || "").trim().toLowerCase();
  // STRONG person signal only. The old `lastName OR town` matched common English
  // words (White/Black/Green) or any town-specific page, then attached every phone
  // on that page to the lead — wrong-person numbers (e.g. a Wikipedia page's
  // numbers attributed to a Fairfield County homeowner). Now require the last name
  // AND at least one co-occurring anchor (first name, the full name, or the town).
  if (lastName.length >= 4 && hay.includes(lastName)) {
    if (firstName.length >= 3 && firstName !== lastName && hay.includes(firstName)) return true;
    if (fullName.length >= 8 && hay.includes(fullName)) return true;
    if (town.length >= 3 && hay.includes(town)) return true;
    // Single-token names (e.g. "O'Hare") can't co-occur with a first name; keep
    // them if the name is uncommon enough that presence is a real signal.
    if (firstName === lastName && lastName.length >= 5) return true;
  }
  return false;
}
const socialRe = /https?:\/\/(?:www\.)?(facebook\.com|instagram\.com|linkedin\.com|tiktok\.com\/[^\s<>"']+|youtube\.com\/[^\s<>"']+|(?:x|twitter)\.com\/[^\s<>"']+)/ig;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Personal-context capture (2026-08-14) ────────────────────────────────────
// Short factual snippets literally on the source page about the person
// (profession, interests, pets, affiliations). Rules: the sentence must mention
// the lead's last name (or full name) AND contain a context keyword; the
// snippet is kept verbatim from page text (whitespace-collapsed, clipped to
// ~160 chars). Nothing is ever inferred, guessed, or synthesized — if a page
// has no qualifying sentence, nothing is stored. Runs over already-fetched page
// text, so it costs zero extra network calls.
const CONTEXT_KEYWORDS = /(?:profession|occupation|career|works (?:as|at)|attorney|lawyer|doctor|physician|surgeon|professor|teacher|nurse|realtor|broker|agent|founder|ceo|president|owner|director|manager|partner|engineer|architect|consultant|entrepreneur|author|artist|musician|photographer|coach|sailing|sailor|golf|tennis|hiking|biking|cycling|running|marathon|yoga|painting|photography|music|guitar|piano|violin|dog|cat|pets|golden retriever|labrador|volunteer|board member|trustee|church|synagogue|retired|retiree|grandchildren|graduated|university|college|club)/i;
const CONTEXT_MAX_SNIPPETS = 3;
const CONTEXT_MAX_LEN = 160;
export function extractContext(text: string, lead?: EnrichLead): string[] {
  if (!lead || !mentionsPerson(text, lead)) return [];
  const parts = String(lead.contact_name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  const firstName = parts[0] || "";
  const fullName = parts.join(" ");
  const town = String(lead.town || "").trim().toLowerCase();
  const hay = String(text || "").replace(/\s+/g, " ").trim();
  if (!hay) return [];
  // Paragraph-level verification: a paragraph is "about the lead" when it
  // contains the last name AND (the first name OR the lead's town OR the full
  // name). This keeps pronoun-continuation sentences ("She owns a golden
  // retriever…") while rejecting same-last-name strangers (a "Knetzger in
  // California" paragraph never mentions the lead's town/first name).
  const aboutLead = (para: string) => {
    const p = para.toLowerCase();
    const hasLastName = lastName.length >= 4 && p.includes(lastName);
    if (!hasLastName) return false;
    if (firstName.length >= 3 && p.includes(firstName)) return true;
    if (town.length >= 3 && p.includes(town)) return true;
    return fullName.length >= 8 && p.includes(fullName);
  };
  const out: string[] = [];
  // Trafilatura markdown separates paragraphs with blank lines; a page with no
  // blank lines is treated as one paragraph. Each paragraph must independently
  // pass aboutLead(), so pronoun-continuation sentences are captured only when
  // the lead is named in the same paragraph.
  for (const para of hay.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0)) {
    if (!aboutLead(para)) continue;
    for (const s of para.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0)) {
      if (out.length >= CONTEXT_MAX_SNIPPETS) break;
      if (!CONTEXT_KEYWORDS.test(s.toLowerCase())) continue;
      const clean = s.replace(/\s+/g, " ").trim();
      out.push(clean.length > CONTEXT_MAX_LEN ? clean.slice(0, CONTEXT_MAX_LEN - 1) + "…" : clean);
    }
    if (out.length >= CONTEXT_MAX_SNIPPETS) break;
  }
  return [...new Set(out)].slice(0, CONTEXT_MAX_SNIPPETS);
}
// DDG health gate: after a DuckDuckGo failure/timeout we mark it down for
// DDG_DOWN_MS; while down, the search step goes straight to searchBing and
// skips searchDuck entirely (saves ~6s × query angles per lead while DDG is
// unreachable). A successful searchDuck clears the flag. searchDuck's internals
// are untouched — only the calls are gated.
let ddgDownUntil = 0;
const DDG_DOWN_MS = 300_000;
function ddgDown() { return Date.now() < ddgDownUntil; }
function markDdgDown() { ddgDownUntil = Date.now() + DDG_DOWN_MS; }
function markDdgUp() { ddgDownUntil = 0; }

function rawCoOwners(raw?: string | null): string[] { try { const obj = JSON.parse(raw || "{}"); const vals: string[] = []; for (const [key, value] of Object.entries(obj)) if (/(owner\s*2|co[- ]?owner|assoc(?:iated)?|other\s+owner)/i.test(key)) { const v = String(value || "").trim(); if (v && !/^\d+$/.test(v)) vals.push(v); } return [...new Set(vals)].filter(v => v.length > 2).slice(0, 4); } catch { return []; } }
export function buildQueries(lead: EnrichLead): string[] {
  const name = String(lead.contact_name || "").trim(); if (!name) return [];
  const state = String(lead.state || "CT").trim() || "CT", town = String(lead.town || "").trim(), address = String(lead.property_address || "").trim(), mailing = String(lead.mailing_address || "").trim();
  const people = [name, ...rawCoOwners(lead.raw)]; const out: string[] = [];
  for (const person of people) { const q = `"${person}"`; for (const angle of [`${q} ${address}`, `${q} ${address} ${town}`, `${q} ${town} ${state}`, `${q} ${lead.zip || ""}`, `${q}`, mailing ? `${q} ${mailing}` : ""]) if (angle.trim()) out.push(`${angle.trim()} phone email social`); }
  return [...new Set(out)].slice(0, ENRICH_DEPTH.maxQueryAngles);
}
function cleanUrl(value: string): string | null { try { const u = new URL(value); return BLOCKED.test(u.hostname) ? null : u.href; } catch { return null; } }
function validScrapeUrl(value: string): boolean { try { const u = new URL(value); return u.protocol.startsWith("http") && !JUNK_HOSTS.has(u.hostname.toLowerCase()) && !/^\/(?:search|feed)/i.test(u.pathname); } catch { return false; } }
export function extract(pages: TextPage[], query: string, lead?: EnrichLead): Omit<Finding, "dnc_matched">[] {
  const findings: Omit<Finding, "dnc_matched">[] = [], seen = new Set<string>();
  for (const page of pages) { const source = cleanUrl(page.url) || "", text = page.text || ""; if (!source) continue;
    // Person-match gate: the page corpus must mention the lead's last name or
    // town, otherwise every finding from this page is dropped (celebrity bio /
    // union contact page / other wrong-person pages never mention the homeowner).
    if (!mentionsPerson(text, lead)) continue;
    for (const value of [...new Set((text.match(emailRe) || []).map(emailNorm).filter(isValidEmail))]) { if (!seen.has(`email|${value}`)) { seen.add(`email|${value}`); findings.push({ email: value, socials: [], source_url: source, query }); } }
    for (const value of [...new Set((text.match(phoneRe) || []).map(normalizePhone).filter((v): v is string => !!v))]) { if (!seen.has(`phone|${value}`)) { seen.add(`phone|${value}`); findings.push({ phone: `(${value.slice(0,3)}) ${value.slice(3,6)}-${value.slice(6)}`, socials: [], source_url: source, query }); } }
    for (const match of text.matchAll(socialRe)) { const url = cleanUrl(match[0].replace(/[),.;]+$/, "")); if (!url || seen.has(`social|${url}`)) continue; seen.add(`social|${url}`); const host = new URL(url).hostname.replace(/^www\./, ""); findings.push({ socials: [{ platform: host.split(".")[0] === "twitter" ? "x" : host.split(".")[0], url }], source_url: source, query }); }
  } return findings;
}
async function searchDuck(query: string, page: number): Promise<SearchResult> { const c = new AbortController(), timer = setTimeout(() => c.abort(), 6000); try { const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${page * 30}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadForge public research; +https://www.markpires.com)" }, signal: c.signal }); if (!r.ok) throw new Error(`DuckDuckGo HTTP ${r.status}`); const html = await r.text(); const urls = [...html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)/gi)].map(m => m[1] || ""); const snippets = [...html.matchAll(/<a[^>]+class=["'][^"']*result__snippet[^"']*[^>]*>([\s\S]*?)<\/a>/gi)].map(m => (m[1] || "").replace(/<[^>]+>/g, " ")); return { pages: urls.map((url, i) => ({ url, text: `${url} ${snippets[i] || ""}` })) }; } finally { clearTimeout(timer); } }
// Free fallback search via Bing's organic HTML when DuckDuckGo is unreachable.
// Parses ONLY li.b_algo blocks (organic results — skips ads/promoted and b_ans
// answer boxes). Bing wraps organic hrefs in /ck/a redirects whose real URL is
// the base64 `u` param (prefixed with "a1", sometimes %XX-encoded) — decode it
// and strip tracking params so results carry clean, direct URLs. Same
// {url,title?,text} page shape as searchDuck/searchFirecrawl.
const BING_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
function cleanBingUrl(value: string): string | null {
  try {
    const href = String(value).replace(/&amp;/gi, "&");
    const u = new URL(href);
    if (u.hostname.endsWith("bing.com") && u.pathname.startsWith("/ck/")) {
      const m = href.match(/[?&]u=([^&]+)/i);
      if (!m) return null;
      let enc = m[1];
      try { enc = decodeURIComponent(enc); } catch { /* keep raw */ }
      const variants = [/^a1/i.test(enc) && enc.length > 2 ? enc.slice(2) : "", enc];
      for (const v of variants) {
        if (!v) continue;
        const decoded = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
        if (/^https?:\/\//i.test(decoded)) return cleanUrl(decoded);
      }
      return null;
    }
    return cleanUrl(u.href);
  } catch { return null; }
}
async function searchBing(query: string): Promise<SearchResult> {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": BING_UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, signal: c.signal });
    if (!r.ok) throw new Error(`Bing HTTP ${r.status}`);
    const html = await r.text();
    const pages: TextPage[] = [];
    for (const block of html.matchAll(/<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
      if (pages.length >= 10) break;
      const li = block[1] || "";
      const href = li.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      const url = cleanBingUrl(href);
      if (!url) continue;
      const title = (li.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const snippet = (li.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      pages.push({ url, title, text: `${url} ${title} ${snippet}`.trim() });
    }
    return { pages };
  } finally { clearTimeout(timer); }
}
let lastFirecrawlAt = 0; const FIRECRAWL_MIN_INTERVAL_MS = 6500; async function paceFirecrawl() { const since = Date.now() - lastFirecrawlAt; if (since < FIRECRAWL_MIN_INTERVAL_MS) await wait(FIRECRAWL_MIN_INTERVAL_MS - since); lastFirecrawlAt = Date.now(); }
async function searchFirecrawl(query: string, page: number): Promise<SearchResult> { await paceFirecrawl(); const base = (process.env.FIRECRAWL_URL || "https://api.firecrawl.dev").replace(/\/$/, ""), headers: Record<string,string> = { "Content-Type": "application/json" }; if (process.env.FIRECRAWL_API_KEY) headers.Authorization = `Bearer ${process.env.FIRECRAWL_API_KEY}`; const c = new AbortController(), timer = setTimeout(() => c.abort(), 20000); try { const r = await fetch(`${base}/v1/search`, { method: "POST", headers, body: JSON.stringify({ query, limit: 10 }), signal: c.signal }); const body = await r.text(); let data: any; try { data = JSON.parse(body); } catch { throw new Error(`Firecrawl invalid response HTTP ${r.status}`); } if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}`); const results = data.data || data.results || []; return { pages: results.map((x:any) => ({ url:x.url || "", title:x.title || "", text:`${x.url || ""} ${x.title || ""} ${x.description || ""} ${x.markdown || x.content || ""}` })) }; } finally { clearTimeout(timer); } }
export async function scrapeFirecrawl(url: string): Promise<string> { if (!validScrapeUrl(url)) return ""; await paceFirecrawl(); const base = (process.env.FIRECRAWL_URL || "https://api.firecrawl.dev").replace(/\/$/, ""), headers: Record<string,string> = { "Content-Type":"application/json" }; if (process.env.FIRECRAWL_API_KEY) headers.Authorization = `Bearer ${process.env.FIRECRAWL_API_KEY}`; try { const r = await fetch(`${base}/v1/scrape`, { method:"POST", headers, body:JSON.stringify({url,formats:["markdown"],onlyMainContent:false}) }); const d:any = await r.json(); return r.ok ? String(d?.data?.markdown || d?.markdown || "") : ""; } catch { return ""; } }
// Free local scrape via the .venv-traf Python venv (Trafilatura). Spawns
// scripts/scrape_url.py per URL; bounded by a 25s execFile kill and a 10MB
// stdout cap. Returns "" on any error/timeout/empty extraction — callers treat
// empty as "no usable text" (mirrors scrapeFirecrawl's failure contract).
const TRAF_PY = join(process.cwd(), ".venv-traf", "bin", "python");
const TRAF_SCRIPT = join(process.cwd(), "scripts", "scrape_url.py");
export async function scrapeTrafilatura(url: string): Promise<string> {
  if (!validScrapeUrl(url)) return "";
  try {
    const stdout = await new Promise<string>((resolve, reject) => execFile(TRAF_PY, [TRAF_SCRIPT, url], { timeout: 25000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out || "")))));
    return stdout.trim();
  } catch { return ""; }
}
export function providerName() { return process.env.SEARCH_PROVIDER === "firecrawl" && (process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_URL) ? "firecrawl" : "duckduckgo"; }
export function isConfigured() { return true; }
function dnc(phone?: string, email?: string) { return db.query<any>("SELECT phone,email FROM dnc_entries").all().some(r => (phone && r.phone && digits(r.phone) === digits(phone)) || (email && r.email && emailNorm(r.email) === emailNorm(email))); }
export async function enrichOne(lead: EnrichLead) { const provider = providerName(), findings: Finding[] = [], providers = new Set<string>(), errors: string[] = [], seen = new Set<string>(), counts = { phone:0,email:0,social:0 }, queries = buildQueries(lead); let candidates = 0;
  for (const query of queries) { const maxPages = provider === "firecrawl" ? 1 : ENRICH_DEPTH.pagesPerQuery; for (let page=0; page<maxPages; page++) { let result: SearchResult; let used=provider;
      if (provider === "firecrawl") { try { result = await searchFirecrawl(query,page); } catch { try { result=await searchDuck(query,page); used="duckduckgo"; } catch { errors.push(`${query}: providers unavailable`); continue; } } }
      else { if (!ddgDown()) { try { result = await searchDuck(query,page); if (!result.pages.length) throw new Error("DuckDuckGo returned no results"); markDdgUp(); } catch (e) { markDdgDown(); try { result = await searchBing(query); if (!result.pages.length) throw new Error("Bing returned no results"); used = "bing"; } catch (e2) { errors.push(`${query}: duckduckgo & bing unavailable (${String(e)}; ${String(e2)})`); continue; } } } else { try { result = await searchBing(query); if (!result.pages.length) throw new Error("Bing returned no results"); used = "bing"; } catch (e2) { errors.push(`${query}: duckduckgo down (skipped) & bing unavailable (${String(e2)})`); continue; } } }
      providers.add(used); const corpus=[...result.pages]; const remain=ENRICH_DEPTH.maxCandidatePages-candidates; for (const p of result.pages.filter(p=>validScrapeUrl(p.url)).slice(0, Math.max(0,remain))) { const markdown=used === "firecrawl" ? await scrapeFirecrawl(p.url) : await scrapeTrafilatura(p.url); candidates++; if(markdown) corpus.push({url:p.url,text:markdown,title:p.title}); if(candidates>=ENRICH_DEPTH.maxCandidatePages) break; await wait(ENRICH_DEPTH.requestDelayMs); }
      for (const raw of extract(corpus, query, lead)) { const kind=raw.phone?"phone":raw.email?"email":"social", value=raw.phone?digits(raw.phone):raw.email?emailNorm(raw.email):raw.socials[0]?.url || "", key=`${kind}|${value}|${raw.source_url}`; if(seen.has(key) || counts[kind] >= (kind === "phone" ? ENRICH_DEPTH.maxPhones : kind === "email" ? ENRICH_DEPTH.maxEmails : ENRICH_DEPTH.maxSocials)) continue; seen.add(key); const matched=dnc(raw.phone,raw.email)?1:0, f={...raw,dnc_matched:matched,provider:used}; findings.push(f); counts[kind]++; db.run("INSERT INTO enriched_contacts(lead_id,phone,email,socials,source_url,query,dnc_matched,created_at) VALUES(?,?,?,?,?,?,?,?)",lead.id,raw.phone||null,raw.email||null,JSON.stringify(raw.socials),raw.source_url,query,matched,new Date().toISOString()); }
      // Personal-context capture: verbatim snippets from pages already fetched
      // above (zero extra network). One row per gated page that has context,
      // deduped by (lead_id, context_source_url) so repeat query angles can't
      // double-insert. dnc_matched=0 (context is not contact info).
      for (const page of corpus) {
        if (page.text.length < 300) continue; // search-result snippets are too thin to be context
        const snippets = extractContext(page.text, lead);
        if (!snippets.length) continue;
        const dupCtx = db.query<any>("SELECT id FROM enriched_contacts WHERE lead_id=? AND context_source_url=? AND context IS NOT NULL LIMIT 1").get(lead.id, page.url);
        if (dupCtx) continue;
        db.run("INSERT INTO enriched_contacts(lead_id,phone,email,socials,source_url,query,dnc_matched,created_at,context,context_source_url) VALUES(?,?,?,?,?,?,?,?,?,?)", lead.id, null, null, "[]", page.url, query, 0, new Date().toISOString(), snippets.join(" | "), page.url);
      }
      if(candidates>=ENRICH_DEPTH.maxCandidatePages) break; await wait(ENRICH_DEPTH.requestDelayMs);
    } if(candidates>=ENRICH_DEPTH.maxCandidatePages) break; }
  return { findings, queries:queries.length, providers:[...providers], errors };
}
export function usableFindings(leadId:number) { return db.query<any>("SELECT * FROM enriched_contacts WHERE lead_id=? AND dnc_matched=0 ORDER BY id ASC").all(leadId); }
