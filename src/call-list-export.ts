// Shared call-list row builder — used by BOTH /api/call-list (CSV) and
// /api/call-list/pdf so the two exports can never drift (see team skill
// pdfkit-bun-call-sheet: "COPY the query verbatim" — now literally one query).
// Enriches each row with:
//   email         — promoted imported email, else first non-DNC enriched email
//   email_source  — "import" (came with the source list) | "web" (enriched)
//   socials       — deduped [{platform,url}] from enriched_contacts
//   context       — personal-context snippets (verbatim page text)
// DNC suppression is re-applied HERE at export time against the live dnc_entries
// table (phone + email, normalized) — never trust a stale imported_leads.dnc_matched
// flag computed before the DNC list was loaded.
import { db } from "~/db";
import { digits, emailNorm } from "~/import-scoring";
import { isValidEmail } from "~/enrich";

export type CallListRow = Record<string, any>;

const BASE_QUERY = `SELECT l.*, e.phone AS enriched_phone, e.source_url AS enriched_source FROM imported_leads l LEFT JOIN enriched_contacts e ON e.id=(SELECT id FROM enriched_contacts WHERE lead_id=l.id AND phone IS NOT NULL AND phone!='' AND dnc_matched=0 ORDER BY id ASC LIMIT 1) WHERE l.dnc_matched=0 AND l.agent_attached=0 AND l.listed_active=0 AND l.listed_pending=0 AND l.closed_recently=0 AND l.source NOT IN ('active','pending','closed') AND (COALESCE(NULLIF(l.phone,''),e.phone) IS NOT NULL) AND COALESCE(NULLIF(l.phone,''),e.phone)!='' ORDER BY l.score DESC,l.id DESC`;

// Export-time social-profile guard (honest-data rule): only keep profile URLs
// that parse cleanly on a real social host with an actual path. This drops
// malformed legacy junk like "https://www.youtube.com/user/spokeo)[Spokeo" and
// bare-host links ("https://www.linkedin.com/") that are NOT a person's profile.
const SOCIAL_HOSTS = new Set(["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com"]);
function isRealSocialProfile(u: string): boolean {
  try {
    const url = new URL(String(u || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!SOCIAL_HOSTS.has(host)) return false;
    const path = url.pathname;
    if (path === "/" || path === "") return false; // bare host — not a profile
    if (/[()[\]<>]/.test(path)) return false; // malformed trailing junk
    if ((host === "twitter.com" || host === "x.com") && /^\/intent\//i.test(path)) return false; // share link, not a profile
    if (host === "youtube.com" && !/^\/(?:@|user\/|c\/|channel\/)/i.test(path)) return false; // videos/playlists aren't profiles
    if (host === "tiktok.com" && !/^\/@/i.test(path)) return false; // must be a real @handle page
    return true;
  } catch { return false; }
}

export function callListRows(): CallListRow[] {
  const leads = db.query<any>(BASE_QUERY).all();
  // One pass over enriched_contacts, grouped by lead: socials (deduped by URL,
  // profile-shaped only), context snippets, and a strict-valid email fallback.
  const byLead = new Map<number, { socials: { platform: string; url: string }[]; context: string[]; email: string | null; emailSrc: string | null }>();
  const enrRows = db.query<any>("SELECT lead_id, socials, context, email, source_url FROM enriched_contacts WHERE dnc_matched=0").all();
  for (const e of enrRows) {
    let g = byLead.get(e.lead_id);
    if (!g) { g = { socials: [], context: [], email: null, emailSrc: null }; byLead.set(e.lead_id, g); }
    if (e.socials) {
      try {
        const arr = JSON.parse(String(e.socials));
        for (const s of Array.isArray(arr) ? arr : []) {
          if (s && s.url && isRealSocialProfile(s.url) && !g.socials.some(x => x.url === s.url)) g.socials.push({ platform: String(s.platform || "social"), url: String(s.url) });
        }
      } catch { /* malformed json — ignore */ }
    }
    if (e.context && String(e.context).trim()) g.context.push(String(e.context).trim());
    if (!g.email && e.email && isValidEmail(e.email)) { g.email = String(e.email); g.emailSrc = e.source_url || null; }
  }
  const dncRows = db.query<any>("SELECT phone, email FROM dnc_entries").all();
  const isDnc = (phone: string, email: string) =>
    dncRows.some(d => (d.phone && phone && digits(d.phone) === digits(phone)) || (d.email && email && emailNorm(d.email) === emailNorm(email)));
  const rows: CallListRow[] = [];
  for (const l of leads) {
    const g = byLead.get(l.id) || { socials: [], context: [], email: null, emailSrc: null };
    const phone = l.phone || l.enriched_phone || "";
    const email = l.email || g.email || "";
    // Export-time DNC suppression: check BOTH the final phone and final email
    // against the live DNC list. Matches never leave the system.
    if (isDnc(phone, email)) continue;
    rows.push({
      ...l,
      enriched_phone: l.enriched_phone || null,
      enriched_source: l.enriched_source || null,
      phone,
      phone_source: l.phone ? "import" : "web",
      email,
      email_source: l.email ? (l.email_source_url ? "web" : "import") : g.email ? "web" : "",
      email_source_url: l.email_source_url || g.emailSrc || null,
      socials: g.socials,
      context: g.context,
    });
  }
  return rows;
}

export function socialsLabel(socials: { platform: string; url: string }[]): string {
  return socials.map(s => `${s.platform}: ${s.url}`).join(", ");
}
export function contextLabel(context: string[]): string {
  return context.join(" | ");
}
