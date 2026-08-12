// Re-export every published content post as standalone HTML.
// Run: bun scripts/export-content.ts [--dir public/exports/content]
// Writes public/exports/content/YYYY-MM-DD-slug.html + mirrors to
// dist/client/exports/content/ (see src/content.ts writeExportFile).
import { db } from "../src/db";
import { writeExportFile, type ContentPost } from "../src/content";

function main() {
  const posts = db.query<ContentPost>("SELECT * FROM content_posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC").all();
  if (!posts.length) { console.log("no published posts to export"); process.exit(0); }
  let ok = 0, failed = 0;
  for (const post of posts) {
    const res = writeExportFile(post);
    if (res.ok) { ok++; console.log(`exported ${post.slug} → ${res.path}`); }
    else { failed++; console.error(`FAILED ${post.slug}: ${res.error}`); }
  }
  console.log(`${ok} exported, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
