// Shared media helpers for the Mission Control hub (uploads, file serving, kind/mime).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MEDIA_DIR = join(process.cwd(), ".data", "media");
mkdirSync(MEDIA_DIR, { recursive: true });

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB cap

// Explicit allowlist: video/image/audio/doc extensions only — no executables/scripts.
const EXT_KIND: Record<string, string> = {
  mp4: "video", mov: "video", webm: "video", m4v: "video", mkv: "video", avi: "video",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", avif: "image", bmp: "image", ico: "image",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", aac: "audio", aiff: "audio", wma: "audio",
  pdf: "doc", doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", ppt: "doc", pptx: "doc", txt: "doc", md: "doc", csv: "doc", rtf: "doc",
};

const MIME: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/mp4", mkv: "video/x-matroska", avi: "video/x-msvideo",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", aiff: "audio/aiff", wma: "audio/x-ms-wma",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", rtf: "application/rtf",
};

export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/** kind for a filename ('video'|'image'|'audio'|'doc'), or null if not allowed. */
export function kindOf(filename: string): string | null {
  return EXT_KIND[extOf(filename)] ?? null;
}

/** ComfyUI-output kind per the media-review spec (gif counts as video there). */
export function comfyKindOf(filename: string): string {
  const ext = extOf(filename);
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  if (["mp4", "webm", "gif", "mov"].includes(ext)) return "video";
  if (["mp3", "wav"].includes(ext)) return "audio";
  return "doc";
}

export function mimeOf(filename: string): string {
  return MIME[extOf(filename)] ?? "application/octet-stream";
}

/** Collision-safe, human-ish filename: <ts>-<rand8>-<sanitized base>.<ext>. */
export function safeFilename(original: string): string {
  const ext = extOf(original);
  const rawBase = original.replace(/^.*[\\/]/, ""); // strip any path
  const stem = (ext ? rawBase.slice(0, -(ext.length + 1)) : rawBase).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}${ext ? "." + ext : ""}`;
}

/** Parse a JSON meta column safely. */
export function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}
