import { db } from "~/db";

export const townDemand: Record<string, number> = { Greenwich:15, Westport:15, "New Canaan":14, Darien:14, Wilton:12, Ridgefield:12, Weston:12, Fairfield:11, Easton:10, Stamford:10, Norwalk:9, Trumbull:9, Shelton:8, Monroe:8, Redding:8, Newtown:8, Bethel:7, Brookfield:7, Sherman:6, "New Fairfield":6, Stratford:6, Bridgeport:5, Danbury:6 };
export const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
export const emailNorm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let i=0; i<text.length; i++) { const c=text[i];
    if (c === '"') { if (quoted && text[i+1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ""; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); if (row.some(x => x.trim())) rows.push(row); row=[]; cell=""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some(x => x.trim())) rows.push(row); } return rows;
}
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function mappedHeaders(headers: string[]) { const m: Record<string,string[]> = {
 contact_name:["ownername","owner","owner1","mailingname","grantee","fullname","contactname","name","propertyowner","ownerfullname"],
 first_name:["firstname","owner1firstname","ownerfirstname","first","givenname"], last_name:["lastname","owner1lastname","ownerlastname","last","surname"],
 phone:["phone","phonenumber","homephone","primaryphone","contactphone","dayphone","telephone","phone1","phone2","ownerphone","ownerphonenumber","cellphone","mobilephone","mobile","cell"],
 email:["email","emailaddress","primaryemail","email1","owneremail","owneremailaddress","emailaddress1"],
 property_address:["propertyaddress","propertyaddress1","address","siteaddress","situsaddress","situs","streetaddress","locationaddress","fulladdress","address1","propaddress","propertyaddressfull"],
 mailing_address:["mailingaddress","owneraddress","mailingstreet","mailingaddress1","mailingstreetaddress"],
 town:["town","city","propertycity","mailingcity","situscity","city1","municipality","propertytown","situsmunicipality"], state:["state","propertystate","mailingstate","st"],
 zip:["zip","zipcode","propertyzip","mailingzip","zippostal","postalcode","propertyzipcode","mailingzipcode"],
 purchase_year:["purchaseyear","yearacquired","yearbuilt","acquisitionyear","lastsoldyear","saleyear","yearofsale"],
 est_value:["estvalue","estimatedvalue","value","price","assessedvalue","appraisedvalue","marketvalue","taxvalue","listprice","listingprice","originalprice","currentprice","saleprice","lastsoldprice","taxassessment"],
 beds:["beds","bedrooms","totalbedrooms","bedroomstotal","bedroomcount","bedstotal"], baths:["baths","bathrooms","totalbathrooms","bathroomstotal","bathstotal","fullbaths"], sqft:["sqft","squarefeet","squarefootage","livingarea","sqfttotal","finishsqft","grosslivingarea"],
 list_date:["listdate","listeddate","dateoflisting","listingdate","origlistdate","originallistdate"], expiry_date:["expirydate","expirationdate","expiration","expireddate","dateexpired"],
 price_reduced:["pricereduced","reduced","pricereduction","pricechange","listpricechanged"], active_with_agent:["status","agent","active","listingstatus","mlsstatus","liststatus","statuscode"], firm:["company","firm","brokerage","broker","brokeragefirm","agency"],
 street_number:["streetnumber","streetno","streetnum","housenumber","number"], street_name:["streetname","street"],
 street_suffix:["streetsuffix","streettype","suffix"], street_dir_prefix:["streetdirprefix","dirprefix","streetdirection"], street_dir_suffix:["streetdirsuffix","dirsuffix"],
 unit:["unitnumber","unit","unitno","unitnum","apartment","apartmentnumber","apt"],
 mailing_street_number:["mailingstreetnumber","mailingstreetno","ownerstreetnumber"], mailing_street_name:["mailingstreetname","mailingstreet","ownerstreetname","ownerstreet"],
 mailing_street_suffix:["mailingstreetsuffix"], mailing_street_dir_prefix:["mailingstreetdirprefix"], mailing_street_dir_suffix:["mailingstreetdirsuffix"], mailing_unit:["mailingunitnumber","mailingunit"]
  }; const out: Record<string, number | number[]> = {}; for (const [field,names] of Object.entries(m)) { const i=headers.findIndex(h=>names.includes(key(h))); if(i>=0) out[field]=i; }
  if (out.contact_name === undefined) { const fi=headers.findIndex(h=>m.first_name.includes(key(h))); const li=headers.findIndex(h=>m.last_name.includes(key(h))); if (fi>=0 && li>=0) out.contact_name_parts=[fi,li]; }
  return out; }
export function hasHeaderRow(headers: string[], map: Record<string, number | number[]>) { return Object.keys(map).length > 0 || headers.some(h => /name|phone|email|address|city|state|zip|number|owner/i.test(h)); }
const num = (v: string | undefined) => { const n=Number(String(v??"").replace(/[$,% ]/g,"")); return Number.isFinite(n) ? n : undefined; };
const isoDate = (v: string | undefined) => { if (!v?.trim()) return undefined; const d=new Date(v); return Number.isNaN(d.getTime()) ? v.trim() : d.toISOString().slice(0,10); };

export function scoreLead(lead: any): { score:number; breakdown:Record<string,number> } {
  const b: Record<string,number> = {}; const town=String(lead.town||"").trim(); b["Town demand"] = townDemand[town] ?? 6;
  b["Has phone"] = digits(lead.phone) ? 5 : 0; b["Has email"] = emailNorm(lead.email) ? 5 : 0;
  b["Estimated value"] = Number(lead.est_value)>=600000 ? 5 : 0;
  const failedListing = ["expired", "cancelled", "withdrawn"].includes(String(lead.source));
  b["Never relisted (high intent)"] = failedListing && Number(lead.never_relisted) === 1 ? 15 : 0;
  b["Property details"] = (lead.beds != null || lead.baths != null || lead.sqft != null) ? 3 : 0;
  if (lead.source === "absentee") { const years=lead.purchase_year ? Math.max(0, new Date().getFullYear()-Number(lead.purchase_year)) : 0; b["Ownership duration"] = lead.purchase_year ? Math.min(20, years*.5) : 10; b["Single-family signal"] = b["Property details"] ? 3 : (/single.?family|residential|house/i.test(String(lead.raw||"")) ? 3 : 0); }
  else { let days:number|undefined; const date=lead.expiry_date||lead.list_date; if(date) days=Math.max(0, Math.floor((Date.now()-new Date(date).getTime())/86400000)); b["Days since expiry"] = days===undefined ? 5 : days<=30?10:days<=60?7:days<=90?4:days<=180?2:0; b["Price reduced"] = lead.price_reduced ? 8 : 0; b["Active with agent"] = lead.active_with_agent ? -10 : 0; }
  const score=Math.max(0,Math.min(100,Object.values(b).reduce((a,n)=>a+n,0)+(lead.source==="absentee"?40:45))); return {score,breakdown:b};
}
export function refreshMarketFlags() {
  const agents = db.query<any>("SELECT agent_name,address FROM agent_entries").all();
  const norm = (v: unknown) => key(String(v ?? ""));
  const addressMatch = (a: any, b: any) => { const aa=norm(a.address), bb=norm(b.address); if (!aa || !bb) return false; if (aa !== bb) return false; return !a.town || !b.town || norm(a.town) === norm(b.town); };
  const market = db.query<any>("SELECT property_address,mailing_address,town,source FROM imported_leads WHERE source IN ('active','pending','closed')").all();
  for (const l of db.query<any>("SELECT * FROM imported_leads WHERE source IN ('absentee','expired','cancelled','withdrawn')").all()) {
    const agent = agents.some(a => (norm(a.agent_name) && norm(a.agent_name) === norm(l.contact_name)) || addressMatch({address:a.address,town:l.town},{address:l.property_address,town:l.town}) || addressMatch({address:a.address,town:l.town},{address:l.mailing_address,town:l.town}));
    const active = market.some(m => m.source === 'active' && (addressMatch({address:m.property_address,town:m.town},{address:l.property_address,town:l.town}) || addressMatch({address:m.mailing_address,town:m.town},{address:l.property_address,town:l.town}) || addressMatch({address:m.property_address,town:m.town},{address:l.mailing_address,town:l.town}) || addressMatch({address:m.mailing_address,town:m.town},{address:l.mailing_address,town:l.town})));
    const pending = market.some(m => m.source === 'pending' && (addressMatch({address:m.property_address,town:m.town},{address:l.property_address,town:l.town}) || addressMatch({address:m.mailing_address,town:m.town},{address:l.mailing_address,town:l.town}))); 
    const closed = market.some(m => m.source === 'closed' && (addressMatch({address:m.property_address,town:m.town},{address:l.property_address,town:l.town}) || addressMatch({address:m.mailing_address,town:m.town},{address:l.mailing_address,town:l.town})));
    const status = agent ? 'agent' : active ? 'active' : pending ? 'pending' : closed ? 'closed' : null;
    db.run("UPDATE imported_leads SET agent_attached=?,listed_active=?,listed_pending=?,closed_recently=?,market_status=? WHERE id=?",agent?1:0,active?1:0,pending?1:0,closed?1:0,status,l.id);
  }
  refreshNeverRelisted();
}

const cleanVal = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");

/** Find the first non-empty value in `raw` whose normalized key matches a synonym, in synonym priority order. */
function findField(raw: Record<string, unknown>, synonyms: string[]): string {
  for (const syn of synonyms) {
    for (const [k, v] of Object.entries(raw)) if (key(k) === syn && cleanVal(v)) return cleanVal(v);
  }
  return "";
}

/** Join address parts in USPS order: number, dir prefix, name, suffix, dir suffix, unit. NULL when there is no number AND no street name. */
export function assembleAddress(parts: { streetNumber?: string; streetName?: string; streetSuffix?: string; dirPrefix?: string; dirSuffix?: string; unit?: string }): string | null {
  const streetNumber = cleanVal(parts.streetNumber), streetName = cleanVal(parts.streetName);
  if (!streetNumber && !streetName) return null;
  const bits = [streetNumber, cleanVal(parts.dirPrefix), streetName, cleanVal(parts.streetSuffix), cleanVal(parts.dirSuffix)].filter(Boolean);
  const unit = cleanVal(parts.unit);
  if (unit) bits.push(/^(UNIT|APT)\b|^#/.test(unit.toUpperCase()) ? unit : `Unit ${unit}`);
  return bits.join(" ").trim() || null;
}

/**
 * Assemble property_address (and mailing_address, when the raw row carries
 * mailing street fields) from exploded street columns inside a row's raw JSON —
 * e.g. MLS exports with "Street Number", "Street Name", "Street Suffix",
 * "Street Dir Prefix"/"Street Dir Suffix", "Unit Number" / "Apartment #".
 */
export function buildAddressesFromRaw(raw: Record<string, unknown>): { property_address: string | null; mailing_address: string | null } {
  const streetNumber = findField(raw, ["streetnumber", "streetno", "streetnum", "housenumber", "number"]);
  const streetName = findField(raw, ["streetname", "street"]);
  const streetSuffix = findField(raw, ["streetsuffix", "streettype", "suffix"]);
  const dirPrefix = findField(raw, ["streetdirprefix", "dirprefix", "streetdirection"]);
  const dirSuffix = findField(raw, ["streetdirsuffix", "dirsuffix"]);
  const unit = findField(raw, ["unitnumber", "unit", "unitno", "unitnum", "apartment", "apartmentnumber", "apt"]);
  const property_address = assembleAddress({ streetNumber, streetName, streetSuffix, dirPrefix, dirSuffix, unit });
  const mailing_address = assembleAddress({
    streetNumber: findField(raw, ["mailingstreetnumber", "mailingstreetno", "ownerstreetnumber"]),
    streetName: findField(raw, ["mailingstreetname", "mailingstreet", "ownerstreetname", "ownerstreet"]),
    streetSuffix: findField(raw, ["mailingstreetsuffix"]),
    dirPrefix: findField(raw, ["mailingstreetdirprefix"]),
    dirSuffix: findField(raw, ["mailingstreetdirsuffix"]),
    unit: findField(raw, ["mailingunitnumber", "mailingunit"]),
  });
  return { property_address, mailing_address };
}

/**
 * One-time, idempotent backfill: assemble property_address/mailing_address from
 * each row's raw JSON for every imported lead that is missing an address. Safe to
 * run repeatedly — rows that already have both addresses are skipped, and existing
 * values are never overwritten or nulled out.
 */
export function backfillAddressesFromRaw(): { updated: number; skipped: number } {
  const rows = db.query<any>(`SELECT id, property_address, mailing_address, raw FROM imported_leads
    WHERE (property_address IS NULL OR TRIM(property_address) = '') AND raw IS NOT NULL AND raw != ''`).all();
  const upd = db.prepare("UPDATE imported_leads SET property_address=?, mailing_address=? WHERE id=?");
  let updated = 0;
  db.run("BEGIN");
  try {
    for (const r of rows) {
      let raw: unknown;
      try { raw = JSON.parse(r.raw); } catch { continue; }
      if (typeof raw !== "object" || raw === null) continue;
      const { property_address, mailing_address } = buildAddressesFromRaw(raw as Record<string, unknown>);
      if (!property_address && !mailing_address) continue;
      upd.run(property_address ?? r.property_address ?? null, mailing_address ?? r.mailing_address ?? null, r.id);
      updated++;
    }
    db.run("COMMIT");
  } catch (e) { try { db.run("ROLLBACK"); } catch {} throw e; }
  return { updated, skipped: rows.length - updated };
}

/**
 * Strict never-relisted classification for failed listings (expired/cancelled/
 * withdrawn). A row only counts as never relisted (never_relisted=1) when it has a
 * usable property/mailing address AND no match in the market (closed/active/pending),
 * agent, or DNC reference data. Rows with NO address at all cannot be verified —
 * they are set to never_relisted=0 and flagged never_relisted_unverified=1.
 */
export function refreshNeverRelisted() {
  const norm = (v: unknown) => key(String(v ?? ""));
  // Address normalization: lowercase, strip punctuation, and canonicalize unit
  // tokens ("APT 245" / "Unit 245" / "#245" -> "u245") so the same condo unit
  // matches across exports that spell the unit differently, while different units
  // in the same building still do NOT match each other.
  const addrNorm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/\b(apt|unit|apartment)\.?\s*/g, "u").replace(/#/g, "u").replace(/[^a-z0-9]/g, "");
  const market = db.query<any>("SELECT property_address, mailing_address, town FROM imported_leads WHERE source IN ('closed','active','pending')").all();
  const agents = db.query<any>("SELECT address FROM agent_entries WHERE address IS NOT NULL AND address != ''").all();
  const dnc = db.query<any>("SELECT name,phone,email FROM dnc_entries").all();
  const addrOnly = new Set<string>(), addrTown = new Set<string>();
  for (const m of market) {
    for (const a of [m.property_address, m.mailing_address]) {
      const na = addrNorm(a); if (!na) continue;
      addrOnly.add(na); const t = norm(m.town); if (t) addrTown.add(na + "|" + t);
    }
  }
  const agentSet = new Set<string>();
  for (const a of agents) { const na = addrNorm(a.address); if (na) agentSet.add(na); }
  const dncNames = new Set<string>(), dncPhones = new Set<string>(), dncEmails = new Set<string>();
  for (const d of dnc) {
    if (d.name && emailNorm(d.name)) dncNames.add(emailNorm(d.name));
    if (d.phone && digits(d.phone)) dncPhones.add(digits(d.phone));
    if (d.email && emailNorm(d.email)) dncEmails.add(emailNorm(d.email));
  }
  const update = db.prepare("UPDATE imported_leads SET never_relisted=?, never_relisted_unverified=? WHERE id=?");
  db.run("BEGIN");
  try {
    for (const l of db.query<any>("SELECT * FROM imported_leads").all()) {
      if (!["expired", "cancelled", "withdrawn"].includes(String(l.source))) {
        if (l.never_relisted || l.never_relisted_unverified) update.run(0, 0, l.id);
        continue;
      }
      const prop = addrNorm(l.property_address), mail = addrNorm(l.mailing_address);
      if (!prop && !mail) { update.run(0, 1, l.id); continue; }
      let marketMatch = false;
      for (const a of [l.property_address, l.mailing_address]) {
        const na = addrNorm(a); if (!na) continue;
        if (addrOnly.has(na) && (!norm(l.town) || addrTown.has(na + "|" + norm(l.town)))) { marketMatch = true; break; }
      }
      const agentMatch = agentSet.has(prop) || (mail && agentSet.has(mail));
      const dncMatch = (l.contact_name && dncNames.has(emailNorm(l.contact_name))) || (digits(l.phone) && dncPhones.has(digits(l.phone))) || (l.email && dncEmails.has(emailNorm(l.email)));
      update.run(marketMatch || agentMatch || dncMatch ? 0 : 1, 0, l.id);
    }
    db.run("COMMIT");
  } catch (e) { try { db.run("ROLLBACK"); } catch {} throw e; }
}

export function refreshDncAndScores() {
  refreshMarketFlags();
  const entries=db.query<any>("SELECT phone,email FROM dnc_entries").all(); const isDnc=(l:any)=>entries.some(e=>(e.phone&&digits(e.phone)&&digits(e.phone)===digits(l.phone))||(e.email&&emailNorm(e.email)&&emailNorm(e.email)===emailNorm(l.email)));
  for (const l of db.query<any>("SELECT * FROM imported_leads").all()) { const d=isDnc(l)?1:0; const s=scoreLead({...l, never_relisted: l.never_relisted}); db.run("UPDATE imported_leads SET dnc_matched=?,score=?,score_breakdown=? WHERE id=?",d,s.score,JSON.stringify(s.breakdown),l.id); }
}
export { num, isoDate, key };
