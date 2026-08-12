// ComfyUI integration proof — submits a minimal Wan 2.1 text-to-video workflow to
// the owner's GPU box over the Cloudflare quick tunnel, polls until done, downloads
// the rendered output to /home/team/shared/comfy-proof.png.
// Run: bun scripts/comfy-proof.ts   (from /home/team/shared/site)
import { writeFileSync } from "node:fs";
import { comfyHealth, comfyHistory, comfyQueue, comfyView, submitWorkflow } from "../src/comfy";

// Wan 2.1 T2V minimal graph — every node verified present in /object_info on the owner's box
// (no SD1.5 checkpoints installed; the box is a Wan 2.1 setup: wan2.1_t2v_1.3B + umt5 + wan VAE).
const workflow = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_t2v_1.3B_fp16.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "4": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "aerial drone shot of a luxury colonial home in Fairfield County Connecticut at golden hour, manicured lawn, autumn trees, photorealistic, cinematic lighting, high detail",
      clip: ["2", 0],
    },
  },
  "5": {
    class_type: "CLIPTextEncode",
    inputs: { text: "blurry, low quality, watermark, distorted, deformed", clip: ["2", 0] },
  },
  "6": {
    class_type: "WanImageToVideo",
    inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], width: 512, height: 512, length: 9, batch_size: 1 },
  },
  "7": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      seed: 42,
      steps: 10,
      cfg: 1.0,
      sampler_name: "euler",
      scheduler: "simple",
      positive: ["6", 0],
      negative: ["6", 1],
      latent_image: ["6", 2],
      denoise: 1.0,
    },
  },
  "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "comfy-proof" } },
};

const ts = () => new Date().toISOString().slice(11, 23);

async function main() {
  console.log(`[${ts()}] health:`, JSON.stringify(await comfyHealth()));
  console.log(`[${ts()}] queue before:`, JSON.stringify(await comfyQueue()));

  const promptId = await submitWorkflow(workflow);
  console.log(`[${ts()}] SUBMITTED prompt_id=${promptId}`);

  const deadline = Date.now() + 6 * 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await comfyHistory(promptId);
    if (h.status !== lastStatus) {
      console.log(`[${ts()}] status=${h.status}${h.error ? ` error=${h.error}` : ""}`);
      lastStatus = h.status;
    }
    if (h.status === "completed") {
      const files = Object.values(h.outputs).flatMap((o) => [...(o.images || []), ...(o.video || [])]);
      console.log(`[${ts()}] outputs:`, JSON.stringify(files));
      const img = files[0];
      if (!img) throw new Error("completed but no output files found");
      const view = await comfyView({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
      if (!view.ok) throw new Error(`view failed: ${JSON.stringify(view)}`);
      writeFileSync("/home/team/shared/comfy-proof.png", view.bytes);
      console.log(`[${ts()}] /view ${view.status} ${view.contentType} ${view.bytes.length} bytes -> /home/team/shared/comfy-proof.png`);
      console.log(`[${ts()}] DONE`);
      return;
    }
    if (h.status === "failed") {
      console.log(`[${ts()}] FAILED: ${h.error}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`[${ts()}] TIMEOUT after 6 min (last status ${lastStatus})`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[${ts()}] FATAL:`, e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
