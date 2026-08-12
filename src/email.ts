import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type EmailLead = Record<string, unknown> & { id?: number; email?: string | null; contact_name?: string | null; town?: string | null; property_address?: string | null; est_value?: number | null; beds?: number | null; baths?: number | null; notes?: string | null; source?: string | null };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;", "'":"&#39;"}[c] ?? c));
const siteUrl = () => (process.env.LEADFORGE_SITE_URL || process.env.SITE_URL || "https://f1f8c9cb73de03d6e35500c19c990d14.ctonew.app").replace(/\/$/, "");
function secret(): string {
  if (process.env.EMAIL_UNSUB_SECRET) return process.env.EMAIL_UNSUB_SECRET;
  const dir = join(process.cwd(), ".data"); mkdirSync(dir, { recursive: true }); const file = join(dir, "email-unsub-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const value = randomBytes(32).toString("hex"); writeFileSync(file, value, { mode: 0o600 }); return value;
}
export function unsubscribeToken(email: string) { return createHmac("sha256", secret()).update(email.trim().toLowerCase()).digest("hex"); }
export function validUnsubscribeToken(email: string, token: string) { const a = Buffer.from(unsubscribeToken(email)); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
export function unsubscribeUrl(email: string) { return `${siteUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`; }

function template(lead: EmailLead) {
  const name = String(lead.contact_name || "there").split(/\s+/)[0]; const town = String(lead.town || "your area");
  const details = [lead.property_address, lead.est_value ? `an estimated value of $${Number(lead.est_value).toLocaleString()}` : "", lead.beds ? `${lead.beds} bedrooms` : "", lead.baths ? `${lead.baths} baths` : ""].filter(Boolean).join(" · ");
  const signal = lead.notes ? String(lead.notes).replace(/\s+/g, " ").slice(0, 220) : "";
  const subject = `Quick question about your ${town} home`;
  const footer = process.env.EMAIL_FOOTER ? `<p>${esc(process.env.EMAIL_FOOTER)}</p>` : "";
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#243044"><p>Hi ${esc(name)},</p><p>I’m Mark Pires, a local Fairfield County real estate professional. I’m reaching out because I’m keeping an eye on homes in ${esc(town)} and wanted to offer a useful, no-pressure conversation about your plans.</p>${details ? `<p>I have this property noted: ${esc(details)}.</p>` : ""}${signal ? `<p>${esc(signal)}</p>` : ""}<p>If a move, valuation, or simply understanding your options is on your mind, I’d be glad to share a current perspective. Just reply to this email or call me and we can find a convenient time.</p><p>Best,<br>Mark Pires</p>${footer}<p style="font-size:12px;color:#667085"><a href="${esc(unsubscribeUrl(String(lead.email || "")))}">Unsubscribe</a> from future emails.</p></div>`;
  return { subject, html };
}
export async function draftLeadEmail(lead: EmailLead) {
  const fallback = template(lead); const base = process.env.OLLAMA_URL?.replace(/\/$/, ""); if (!base) return fallback;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ model: process.env.OLLAMA_MODEL || "llama3.2", messages: [{ role: "system", content: "Write a truthful, friendly, non-spammy real estate introduction. Return JSON with subject and html. Include no urgency or unsupported claims." }, { role: "user", content: JSON.stringify({ lead, requiredUnsubscribe: unsubscribeUrl(String(lead.email || "")), footer: process.env.EMAIL_FOOTER || "" }) }], temperature: 0.6 }) });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`); const data = await res.json() as any; const content = data?.choices?.[0]?.message?.content; const parsed = JSON.parse(String(content).replace(/^```json\s*|\s*```$/g, ""));
    if (!parsed.subject || !parsed.html || !String(parsed.html).includes("unsubscribe")) throw new Error("AI draft missing required fields");
    return { subject: String(parsed.subject), html: String(parsed.html) + `<p style="font-size:12px"><a href="${esc(unsubscribeUrl(String(lead.email || "")))}">Unsubscribe</a></p>` };
  } catch { return fallback; }
}
export function fromAddress() { return process.env.RESEND_EMAIL_FROM || "onboarding@resend.dev"; }
