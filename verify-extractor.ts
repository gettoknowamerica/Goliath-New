// Outreach stage 1 — extractor hardening unit checks (run: bun verify-extractor.ts)
import { extract, extractContext, isValidEmail, normalizePhone, type EnrichLead } from "./src/enrich";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); ok ? pass++ : fail++; };

// ── Emails: junk must be rejected, real addresses accepted ──────────────────
const badEmails: [string, string][] = [
  ["court_summary@2x.05bf0b67.png", "image-filename asset email (png TLD)"],
  ["nccc-logo-2022-color-01212022@2x.png", "chamber logo @2x.png asset email"],
  ["nccc-logo-2022-white-01282022@2x.png", "logo @2x.png asset email"],
  ["3@hotmail.com", "1-char local part (URL fragment artifact)"],
  ["1@gmail.com", "1-char local part"],
  ["p@statefarm.com", "1-char local part"],
  ["n@blackcodemail.com", "1-char local part"],
  ["joe@sentry.io", "junk placeholder domain sentry.io"],
  ["joe@wixstatic.com", "asset CDN wixstatic.com"],
  ["joe@schemastore.org", "junk schemastore.org"],
  ["joe@foo.cloudinary.com", "asset CDN cloudinary"],
  ["joe@images.example.com", "asset-ish CDN example.com"],
  ["joe@cdn.foo.com", "cdn. asset pattern"],
  ["logo@2x.foo.com", "@2x asset pattern in domain"],
];
for (const [email, why] of badEmails) check(`REJECT email ${email} (${why})`, !isValidEmail(email));

const goodEmails: [string, string][] = [
  ["john.smith@gmail.com", "normal gmail"],
  ["mark@pires.com", "normal personal domain"],
  ["laura@newcanaanchamber.com", "chamber staff email"],
  ["matthew.s.smith@ampf.com", "dotted personal email"],
  ["matt.angela.andrews@gmail.com", "personal gmail"],
  ["mreed108@aol.com", "aol address"],
];
for (const [email, why] of goodEmails) check(`ACCEPT email ${email} (${why})`, isValidEmail(email));

// ── Phones: fake/toll-free must be rejected, real 10-digit accepted ─────────
const badPhones: [string, string][] = [
  ["(800) 222-1222", "poison-control toll-free 800"],
  ["1-800-627-6514", "toll-free with leading 1"],
  ["(888) 555-1234", "toll-free 888"],
  ["(100) 011-0100", "fake area code 100 (1xx)"],
  ["(011) 139-9063", "fake area code 011 (0xx)"],
  ["(017) 139-9063", "area code 017 (0xx)"],
  ["(186) 022-4333", "area code 186 (1xx)"],
  ["(000) 000-0012", "all-zero repeat"],
  ["(111) 555-1234", "repeat area code 111"],
  ["(222) 555-1234", "repeat area code 222"],
  ["(787) 108-4192", "exchange 108 starts with 1"],
  ["(617) 022-4333", "exchange 022 starts with 0"],
  ["555-1234", "7 digits — too short"],
  ["12345", "5 digits — too short"],
];
for (const [phone, why] of badPhones) check(`REJECT phone ${phone} (${why})`, normalizePhone(phone) === null);

const goodPhones: [string, string][] = [
  ["(203) 555-1234", "normal Fairfield County number"],
  ["1-203-555-1234", "with leading 1 (drops the 1)"],
  ["203-253-3703", "dash format"],
  ["203.966.2004", "dot format"],
  ["203 989 6050", "space format"],
];
for (const [phone, why] of goodPhones) check(`ACCEPT phone ${phone} (${why})`, normalizePhone(phone) === "2035551234" || normalizePhone(phone)?.startsWith("203"));

// ── Person-match gate: corpus must mention lead's last name or town ─────────
const lead: EnrichLead = { id: 1, contact_name: "Michael Bennett", town: "Stamford", state: "CT" };
const celebrityPage = {
  url: "https://en.wikipedia.org/wiki/Julie_Andrews",
  text: "Dame Julie Andrews is an English actress and singer. She starred in Mary Poppins and The Sound of Music. Contact her agent: julie.andrews@hollywood.com or call (310) 555-0199.",
};
const unionPage = {
  url: "https://nmteach.org/contact",
  text: "Contact the New Mexico Teachers Union: info@nmteachersunion.org, (505) 555-0133. Our office is in Santa Fe.",
};
const namePage = {
  url: "https://www.bennettfamily.com/michael",
  text: "Michael Bennett lives in Stamford with his family. Reach him at michael.bennett@gmail.com or (203) 555-0177.",
};
const townPage = {
  url: "https://www.stamfordct.gov/officials",
  text: "Stamford residents may contact the assessor's office. Michael Bennett was listed at 12 Elm Street. Email m.bennett@stamford.gov, phone (203) 555-0188.",
};
const noLeadPages = [celebrityPage, unionPage];
const withLeadPages = [celebrityPage, unionPage, namePage, townPage];

const noLeadFindings = extract(noLeadPages, '"Michael Bennett" Stamford CT', lead);
check("GATE: celebrity bio + union contact pages yield ZERO findings", noLeadFindings.length === 0);
const droppedEmail = noLeadFindings.find(f => f.email === "julie.andrews@hollywood.com" || f.email === "info@nmteachersunion.org");
check("GATE: wrong-person emails (julie.andrews@ / union info@) are dropped", !droppedEmail);

const withLeadFindings = extract(withLeadPages, '"Michael Bennett" Stamford CT', lead);
const emails = withLeadFindings.map(f => f.email).filter(Boolean);
const phones = withLeadFindings.map(f => f.phone).filter(Boolean);
check("GATE: name-matching page yields michael.bennett@gmail.com", emails.includes("michael.bennett@gmail.com"));
check("GATE: town-matching page yields m.bennett@stamford.gov", emails.includes("m.bennett@stamford.gov"));
check("GATE: celebrity/union emails still absent even when a matching page is present", !emails.includes("julie.andrews@hollywood.com") && !emails.includes("info@nmteachersunion.org"));
check("GATE: real phones (203) 555-0177 / 555-0188 kept", phones.includes("(203) 555-0177") && phones.includes("(203) 555-0188"));
check("GATE: celebrity phone (310) 555-0199 dropped", !phones.includes("(310) 555-0199"));

// ── Personal-context capture (2026-08-14) ─────────────────────────────────
const contextLead: EnrichLead = { id: 1, contact_name: "Diane Knetzger", town: "New Canaan", state: "CT" };
const contextPage =
  "Diane Knetzger is a professional photographer in New Canaan. She owns a golden retriever and volunteers with the New Canaan Chamber of Commerce. Her studio is on Main Street. The weather in New Canaan was sunny today.";
const contextSnippets = extractContext(contextPage, contextLead);
check("CONTEXT: captures profession snippet verbatim", contextSnippets.some(c => c.includes("professional photographer")));
check("CONTEXT: captures pet snippet verbatim", contextSnippets.some(c => c.includes("golden retriever")));
check("CONTEXT: ignores non-context sentence (weather)", !contextSnippets.some(c => c.includes("weather")));
check("CONTEXT: caps at 3 snippets", contextSnippets.length <= 3);
const noContextPage = "New Canaan is a great place to live. The train station is convenient. Schools are highly rated.";
check("CONTEXT: stores nothing when page has no personal facts", extractContext(noContextPage, contextLead).length === 0);
const wrongPersonPage = "The Knetzger family moved away. A famous photographer named Knetzger lives in California and owns two cats.";
check("CONTEXT: snippet must mention the lead's name, not just a keyword", extractContext(wrongPersonPage, contextLead).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
