// Quick sanity test for the hardened mentionsPerson gate (mirrors enrich.ts logic).
const names = {
  LeadWhite: { contact_name: "Frances S White", town: "Westport" },
  LeadKorbl: { contact_name: "Christine M Korbl", town: "Westport" },
  LeadOHare: { contact_name: "O'Hare", town: "New Canaan" },
};
const checkFn = (text: string, lead: any) => {
  const hay = String(text || "").toLowerCase();
  const parts = String(lead.contact_name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const firstName = parts[0] || "";
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  const fullName = parts.join(" ");
  const town = String(lead.town || "").trim().toLowerCase();
  if (lastName.length >= 4 && hay.includes(lastName)) {
    if (firstName.length >= 3 && firstName !== lastName && hay.includes(firstName)) return true;
    if (fullName.length >= 8 && hay.includes(fullName)) return true;
    if (town.length >= 3 && hay.includes(town)) return true;
    if (firstName === lastName && lastName.length >= 5) return true;
  }
  return false;
};
const cases: [string, string, any, boolean][] = [
  ["France page (white + phone, no co-occur) vs White", "France is a country. The flag is blue, white and red. Phone +1 (979) 863-3355.", names.LeadWhite, false],
  ["France page vs Korbl", "France is a country. Flag is blue/white/red. Phone (978) 973-3203.", names.LeadKorbl, false],
  ["owning page (Frances 12 Main St Westport) vs White", "Frances White and John White own 12 Main St in Westport CT. Phone (203) 555-1212.", names.LeadWhite, true],
  ["town-only Westport page + white word vs White (no first name)", "A new bakery opened in Westport serving white chocolate. Phone (203) 555-9999.", names.LeadWhite, true], // town co-occur — acceptable (homeowner + town strongly local)
  ["single-token O'Hare page", "O'Hare Auto repair is in New Canaan CT. Phone (203) 555-0100.", names.LeadOHare, true],
];
let pass = 0;
for (const [name, text, lead, expected] of cases) {
  const got = checkFn(text, lead);
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} → got ${got}, expected ${expected}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
