// Content engine shared module — blogwriter posts, market-blog drip injection,
// and markpires.com HTML export. No markdown dependency: markdownToHtml is an
// escape-first renderer, so a post body can never inject raw HTML.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "~/db";

export type ContentPost = {
  id: number; title: string; slug: string; focus_keyword: string | null;
  meta_title: string | null; meta_description: string | null; body_markdown: string;
  faq_schema_json: string | null; cta_url: string | null; source_question: string | null;
  status: string; town_focus: string | null; created_at: string; updated_at: string;
  published_at: string | null;
};

export const DEFAULT_CTA_URL = "https://www.markpires.com/home-valuation.php";
export const OWNER_PHONE = "203-247-2655";

export function slugify(title: string): string {
  return String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// ── markdownToHtml — escape-first renderer ────────────────────────────────────
// Pipeline: (1) HTML-escape the WHOLE body so no raw HTML can pass through;
// (2) apply a small set of markdown transforms on the escaped text; (3) wrap
// blank-line-separated blocks in <p>. Headings / hr / blockquotes / list items
// are handled line-wise first, then remaining blank-line blocks become paragraphs.
export function markdownToHtml(md: string): string {
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
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")                     // *text* → <em>
      .replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, "$1<em>$2</em>$3") // _text_ → <em> (not inside words)
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
    // Fenced code blocks: a ``` fence renders as <pre><code>…</code></pre> instead
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
  if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`); // unclosed fence — still render
  flushPara(); closeList();
  return out.join("\n");
}

// ── Market-blog lookup for drip step 2 ────────────────────────────────────────
// Town-matched published post preferred; newest general post as fallback; with no
// town, the newest published post. Never returns a draft/ready post.
export function lookupMarketBlog(lead: { town?: string | null }): ContentPost | null {
  const town = lead?.town ? String(lead.town).trim() : "";
  const rows = db.query<any>(`SELECT * FROM content_posts
    WHERE status='published' AND (? = '' OR town_focus IS NULL OR town_focus = ?)
    ORDER BY (town_focus = ?) DESC, COALESCE(published_at, created_at) DESC, id DESC LIMIT 1`)
    .all(town, town, town);
  return rows[0] ?? null;
}

// ── marketBlogTemplate — drip step-2 email body ───────────────────────────────
// Renders the post body to HTML inside the app's email wrapper (Arial/#243044),
// then appends the CTA (gold button → post.cta_url) + the {unsubscribe} token so
// renderStep's replacement works. The token is a literal placeholder until
// renderStep substitutes it.
export function marketBlogTemplate(post: ContentPost, _lead: unknown): string {
  const cta = String(post.cta_url || DEFAULT_CTA_URL);
  const bodyHtml = markdownToHtml(post.body_markdown);
  return `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#243044;font-size:15px">
<p><strong>${post.title}</strong></p>
${bodyHtml}
<p style="margin:24px 0 8px;text-align:center"><a href="${cta}" style="display:inline-block;background:#d4af37;color:#243044;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">Send To Mark — book a quick call</a></p>
<p style="font-size:12px;color:#667085"><a href="{unsubscribe}">Unsubscribe</a> from future emails.</p>
</div>`;
}

// ── exportPostHtml — full standalone HTML (markpires.com-ready) ───────────────
// <head> carries the title, meta description, canonical, Open Graph/Twitter meta
// and FAQPage JSON-LD; <article> carries a publish date, the body + CTA.
// faq_schema_json is stored as a JSON array of {question, answer} pairs (ingest
// faq: block) or a full mainEntity array — both get wrapped in the @context
// envelope; a full object passes through.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export function exportPostHtml(post: ContentPost): string {
  const title = String(post.meta_title || post.title);
  const desc = String(post.meta_description || "");
  const bodyHtml = markdownToHtml(post.body_markdown)
    // Tap-to-call (F5): every plain-text owner phone number becomes a tel: link.
    // The number is the trusted OWNER_PHONE literal above (never user input), so
    // no escaping is needed — the digits are already inside escaped HTML here.
    .replaceAll(OWNER_PHONE, `<a href="tel:${OWNER_PHONE.replaceAll("-", "")}">${OWNER_PHONE}</a>`);
  const cta = String(post.cta_url || DEFAULT_CTA_URL);
  // Canonical + og:url. Default: this ctonew.app export URL. When the post lands
  // on markpires.com, set POST_CANONICAL_BASE in site/.env to the final base
  // (e.g. https://www.markpires.com) — Mark's final URL will replace this default.
  const canonicalBase = (process.env.POST_CANONICAL_BASE || "https://f1f8c9cb73de03d6e35500c19c990d14.ctonew.app/exports/content").replace(/\/+$/, "");
  const date = String(post.published_at || post.created_at || new Date().toISOString()).slice(0, 10);
  const filename = `${date}-${post.slug}.html`;
  const canonical = `${canonicalBase}/${filename}`;
  // og:image is emitted ONLY when the owner supplies one (Scorsese hero image via
  // OG_IMAGE_URL in site/.env) — we never invent an image URL; tag is omitted otherwise.
  const ogImage = (process.env.OG_IMAGE_URL || "").trim();
  const published = String(post.published_at || post.created_at || "");
  const publishedLine = published ? `<p style="margin:0 0 24px;color:#667085;font-size:14px">Published ${formatDate(published)}</p>` : "";
  let ld = "";
  if (post.faq_schema_json) {
    try {
      const raw = JSON.parse(post.faq_schema_json);
      let mainEntity: unknown = raw;
      if (Array.isArray(raw)) {
        // {question, answer} pairs → full Question/AcceptedAnswer objects.
        if (raw.length > 0 && "question" in raw[0] && !("acceptedAnswer" in raw[0])) {
          mainEntity = raw.map((f: { question?: string; answer?: string }) => ({
            "@type": "Question",
            name: String(f.question ?? ""),
            acceptedAnswer: { "@type": "Answer", text: String(f.answer ?? "") },
          }));
        } else {
          mainEntity = raw; // already a mainEntity array
        }
        ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity })}</script>`;
      } else if (raw && typeof raw === "object" && (raw as { "@type"?: string })["@type"]) {
        ld = `<script type="application/ld+json">${JSON.stringify(raw)}</script>`; // pass-through
      }
    } catch { /* malformed JSON — omit schema rather than break the page */ }
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${desc ? `<meta name="description" content="${desc}">` : ""}
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
${desc ? `<meta property="og:description" content="${desc}">` : ""}
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
${ogImage ? `<meta property="og:image" content="${ogImage}">` : ""}
${ld}
</head>
<body>
<article>
${publishedLine}
${bodyHtml}
<p style="margin:32px 0;text-align:center"><a href="${cta}" style="display:inline-block;background:#d4af37;color:#243044;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold">Get a Free Home Valuation — Book a Quick Call</a></p>
</article>
</body>
</html>`;
}

// ── writeExportFile — dual-write HTML export ──────────────────────────────────
// Writes public/exports/content/YYYY-MM-DD-slug.html (source of truth — vite
// copies public/ into dist/client on the next build) AND mirrors to
// dist/client/exports/content/ so the LIVE server (serve.ts serves statics from
// dist/client) can serve it immediately without a rebuild. Best-effort: a write
// failure logs and never throws.
export function writeExportFile(post: ContentPost): { ok: boolean; path: string; error?: string } {
  const date = String(post.published_at || post.created_at || new Date().toISOString()).slice(0, 10);
  const filename = `${date}-${post.slug}.html`;
  const html = exportPostHtml(post);
  const dirs = [
    join(process.cwd(), "public", "exports", "content"),
    join(process.cwd(), "dist", "client", "exports", "content"),
  ];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), html, "utf8");
    } catch (e) {
      return { ok: false, path: join(dir, filename), error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, path: join(dirs[1], filename) };
}
