// Content ingestion — blogwriter markdown → content_posts.
// Run: bun scripts/ingest-content.ts [--dir /home/team/shared/content-engine] [--apply] [--verbose]
// Default is DRY-RUN: parses every .md file and prints the plan, writes nothing.
// --apply upserts per slug (ON CONFLICT(slug) DO UPDATE content fields only —
// status is set ONLY on insert, so re-ingesting NEVER downgrades a published row,
// and published_at is set only on first publish).
//
// TOLERANT FRONT-MATTER PARSER (no deps): accepts the blogwriter's actual
// contract — slug / meta_title / meta_description / focus_keyword /
// secondary_keywords (YAML list) / target_towns (YAML list OR inline [a, b]) /
// source_question / status ("ready to publish" maps to "ready") / draft_date /
// byline — with NO title, NO cta_url, NO faq, NO ingest flag. Rules:
//   title   → first `# H1` in the body (front-matter title wins if present)
//   status  → "ready to publish" → "ready"; else draft|ready|published verbatim
//   town_focus → first entry of target_towns
//   cta_url → https://www.markpires.com/home-valuation.php when absent
//   faq_schema_json → parsed from the `faq:` block (question/answer pairs) if
//     present, else extracted from the FAQPage JSON-LD in the body — either a
//     <script type="application/ld+json"> block or a ```json fenced block
//     carrying an object with a mainEntity array (stores the mainEntity array).
// Files with no slug or with `ingest: false` are SKIPPED and reported.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { DEFAULT_CTA_URL } from "../src/content";

const STATUS_MAP: Record<string, string> = {
  "ready to publish": "ready",
  ready: "ready",
  draft: "draft",
  published: "published",
};

function clean(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1).trim();
  return s;
}

// Parse the `---` delimited front matter into a flat record. Values are strings
// or string arrays. Handles: `key: value`, `key: [a, b]`, and
// `key:` followed by `  - item` lines.
function parseFrontMatter(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const line of raw.split("\n")) {
    const keyMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const rest = keyMatch[2].trim();
      if (rest === "") { out[currentKey] = []; continue; }
      const inline = rest.match(/^\[(.*)\]$/);
      if (inline) {
        out[currentKey] = inline[1].split(",").map(clean).filter(Boolean);
      } else {
        out[currentKey] = clean(rest);
      }
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentKey) {
      const arr = out[currentKey];
      if (Array.isArray(arr)) arr.push(clean(item[1]));
      continue;
    }
    currentKey = null; // unindented non-key line ends list mode
  }
  return out;
}

// Extract FAQ mainEntity from the body: <script type="application/ld+json">
// first, then ```json fenced blocks. Returns the mainEntity array or null.
function extractFaqMainEntity(body: string): unknown[] | null {
  const scriptRe = /<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(body))) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && Array.isArray(parsed.mainEntity)) return parsed.mainEntity;
    } catch { /* try next */ }
  }
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  while ((m = fenceRe.exec(body))) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && Array.isArray(parsed.mainEntity)) return parsed.mainEntity;
    } catch { /* try next */ }
  }
  return null;
}

// Parse `faq:` list items (`- question: X` / `  answer: Y`) into
// Question/AcceptedAnswer JSON-LD objects.
function faqBlockToMainEntity(list: string[]): unknown[] | null {
  const pairs: { question?: string; answer?: string }[] = [];
  let cur: { question?: string; answer?: string } | null = null;
  for (const item of list) {
    const q = item.match(/^question:\s*(.*)$/);
    if (q) { cur = { question: clean(q[1]) }; pairs.push(cur); continue; }
    const a = item.match(/^answer:\s*(.*)$/);
    if (a && cur) cur.answer = clean(a[1]);
  }
  const out = pairs.filter(p => p.question && p.answer).map(p => ({
    "@type": "Question",
    name: p.question,
    acceptedAnswer: { "@type": "Answer", text: p.answer },
  }));
  return out.length ? out : null;
}

type Parsed = {
  file: string; skip?: string; title?: string; slug?: string; status?: string;
  townFocus?: string | null; cta?: string; faqCount?: number; bodyChars?: number;
  faqJson?: string | null; sourceQuestion?: string | null; bodyMarkdown?: string;
  focusKeyword?: string | null; metaTitle?: string | null; metaDescription?: string | null;
};

function parseFile(path: string): Parsed {
  const text = readFileSync(path, "utf8");
  const file = path.split("/").pop() || path;
  const starts = text.replace(/^\uFEFF/, "");
  if (!starts.startsWith("---")) return { file, skip: "no front matter" };
  const end = starts.indexOf("\n---", 4);
  if (end === -1) return { file, skip: "unterminated front matter" };
  const fm = parseFrontMatter(starts.slice(3, end));
  const body = starts.slice(end + 4).trim();
  const slug = fm.slug ? String(fm.slug) : "";
  if (fm.ingest === "false" || fm.ingest === false) return { file, skip: "ingest: false" };
  if (!slug) return { file, skip: "no slug" };
  const title = (fm.title ? String(fm.title) : "").trim() || (body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "");
  const status = STATUS_MAP[String(fm.status ?? "").trim().toLowerCase()] ?? (fm.status ? String(fm.status) : "draft");
  const towns = Array.isArray(fm.target_towns) ? fm.target_towns : [String(fm.target_towns ?? "")];
  const faqList = Array.isArray(fm.faq) ? fm.faq : [];
  let faqJson: string | null = null;
  if (faqList.length) {
    const me = faqBlockToMainEntity(faqList);
    if (me) faqJson = JSON.stringify(me);
  } else {
    const me = extractFaqMainEntity(body);
    if (me) faqJson = JSON.stringify(me);
  }
  return {
    file, title, slug, status,
    townFocus: towns[0] || null,
    cta: fm.cta_url ? String(fm.cta_url) : DEFAULT_CTA_URL,
    faqCount: faqJson ? JSON.parse(faqJson).length : 0,
    bodyChars: body.length,
    faqJson,
    sourceQuestion: fm.source_question ? String(fm.source_question) : null,
    bodyMarkdown: body,
    focusKeyword: fm.focus_keyword ? String(fm.focus_keyword) : null,
    metaTitle: fm.meta_title ? String(fm.meta_title) : null,
    metaDescription: fm.meta_description ? String(fm.meta_description) : null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const dir = dirFlag !== -1 && args[dirFlag + 1] ? args[dirFlag + 1] : "/home/team/shared/content-engine";
  const apply = args.includes("--apply");
  const verbose = args.includes("--verbose");
  const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
  if (!files.length) { console.log(`no .md files in ${dir}`); process.exit(1); }
  let parsed = 0, skipped = 0, errors = 0;
  console.log(apply ? "APPLY mode — upserting into content_posts" : "DRY-RUN — no writes (pass --apply to upsert)");
  console.log(`dir: ${dir}\n`);
  for (const f of files) {
    try {
      const row = parseFile(join(dir, f));
      if (row.skip) {
        skipped++;
        console.log(`${f} → SKIP (${row.skip})`);
        continue;
      }
      parsed++;
      const existing = db.query<any>("SELECT id, status FROM content_posts WHERE slug=?").get(row.slug);
      const action = apply ? (existing ? "UPDATE (content fields only, status untouched)" : "INSERT") : "would-insert";
      console.log(`${f} → title: ${row.title} | slug: ${row.slug} | status: ${row.status} | town_focus: ${row.townFocus} | cta: ${row.cta} | faq-count: ${row.faqCount} | action: ${action}`);
      if (verbose) {
        console.log(`    body-chars: ${row.bodyChars} | faq-json: ${row.faqJson ? "yes (" + row.faqCount + " items)" : "no"} | source_question: ${row.sourceQuestion ? "yes" : "no"} | existing-row-status: ${existing?.status ?? "none"}`);
      }
      if (!apply || !row.slug || !row.bodyMarkdown) continue;
      const now = new Date().toISOString();
      const isPublish = row.status === "published" && !existing?.status; // first publish only
      db.run(`INSERT INTO content_posts
        (title, slug, focus_keyword, meta_title, meta_description, body_markdown, faq_schema_json, cta_url, source_question, status, town_focus, created_at, updated_at, published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(slug) DO UPDATE SET
          title=excluded.title, focus_keyword=excluded.focus_keyword, meta_title=excluded.meta_title,
          meta_description=excluded.meta_description, body_markdown=excluded.body_markdown,
          faq_schema_json=excluded.faq_schema_json, cta_url=excluded.cta_url,
          source_question=excluded.source_question, town_focus=excluded.town_focus,
          updated_at=excluded.updated_at`,
        row.title, row.slug, row.focusKeyword ?? null, row.metaTitle ?? null, row.metaDescription ?? null,
        row.bodyMarkdown, row.faqJson, row.cta,
        row.sourceQuestion, row.status, row.townFocus, now, now, isPublish ? now : null);
    } catch (e) {
      errors++;
      console.log(`${f} → ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${parsed} parsed, ${skipped} skipped, ${errors} errors (${apply ? "APPLIED" : "dry-run"})`);
  process.exit(errors ? 1 : 0);
}

main();
