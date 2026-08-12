// Resume: poll an already-submitted ComfyUI prompt until it completes, then download
// the first output image to /home/team/shared/comfy-proof.png.
// Usage: bun scripts/comfy-proof-resume.ts <prompt_id>
import { writeFileSync } from "node:fs";
import { comfyHistory, comfyView } from "../src/comfy";

const promptId = process.argv[2];
if (!promptId) {
  console.error("usage: bun scripts/comfy-proof-resume.ts <prompt_id>");
  process.exit(1);
}
const ts = () => new Date().toISOString().slice(11, 23);

async function main() {
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await comfyHistory(promptId);
    if (h.status !== last) {
      console.log(`[${ts()}] status=${h.status}${h.error ? ` error=${h.error}` : ""}`);
      last = h.status;
    }
    if (h.status === "completed") {
      const files = Object.values(h.outputs).flatMap((o) => [...(o.images || []), ...(o.video || [])]);
      console.log(`[${ts()}] outputs:`, JSON.stringify(files));
      const img = files[0];
      if (!img) throw new Error("completed but no output files");
      const view = await comfyView({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
      if (!view.ok) throw new Error(`view failed: ${JSON.stringify(view)}`);
      writeFileSync("/home/team/shared/comfy-proof.png", view.bytes);
      console.log(`[${ts()}] /view ${view.status} ${view.contentType} ${view.bytes.length} bytes -> /home/team/shared/comfy-proof.png`);
      console.log(`[${ts()}] DONE`);
      return;
    }
    if (h.status === "failed") {
      console.log(`[${ts()}] FAILED: ${h.error}`);
      process.exit(1);
      return;
    }
  }
  console.log(`[${ts()}] TIMEOUT`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`[${ts()}] FATAL:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
