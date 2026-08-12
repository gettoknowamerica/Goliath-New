import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { parseCsv, mappedHeaders, hasHeaderRow, digits, emailNorm, refreshDncAndScores, refreshMarketFlags, num, isoDate, assembleAddress } from "~/import-scoring";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/import")({
  server: { handlers: { POST: async ({ request }) => {
    if (!getUserFromRequest(request)) return unauthorized();
    try {
      const form = await request.formData();
      const file = form.get("file");
      const requestedSource = String(form.get("source") || "");
      const source = requestedSource === "sold" ? "closed" : requestedSource;
      if (!(file instanceof File) || !["expired", "cancelled", "withdrawn", "absentee", "dnc", "agents", "active", "pending", "closed"].includes(source)) return json({ error: "file and source (expired|cancelled|withdrawn|absentee|dnc|agents|active|pending|closed|sold) are required" }, 400);
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) return json({ imported: 0, skipped: 0, dncMatched: 0, errors: ["File is empty"] }, 400);
      const headers = rows[0].map(x => x.trim()); const map = mappedHeaders(headers); let imported = 0; let skipped = 0; const errors: string[] = [];
      const finish = () => { refreshDncAndScores(); refreshMarketFlags(); const dncMatched = Number(db.query<any>("SELECT COUNT(*) n FROM imported_leads WHERE dnc_matched=1").get()?.n || 0); return json({ imported, skipped, dncMatched, errors }); };
      if (!hasHeaderRow(headers, map) && rows[0].length <= 2) {
        // Plain text uploads: DNC values, or one agent name/firm per line.
        if (source === "agents") {
          for (const line of text.split(/\r?\n/)) { const v=line.trim(); if (!v) continue;
            const exists=db.query<any>("SELECT id FROM agent_entries WHERE lower(agent_name)=lower(?) OR lower(address)=lower(?) LIMIT 1").get(v,v);
            if (!exists) { db.run("INSERT INTO agent_entries(agent_name,raw,created_at) VALUES(?,?,?)",v,JSON.stringify({line:v}),new Date().toISOString()); imported++; } else skipped++;
          }
          return finish();
        }
        // Plain .txt / single-value-per-line file (common for DNC lists): each line is a phone number or email.
        for (const line of text.split(/\r?\n/)) {
          const v = line.trim(); if (!v) continue;
          const email = emailNorm(v); const phone = digits(v);
          let phoneVal: string | null = null; let emailVal: string | null = null;
          if (email.includes("@")) emailVal = email;
          else if (phone.length >= 10 && phone.length <= 11) phoneVal = phone;
          else { skipped++; continue; }
          try {
            if (source === "dnc") {
              const existing = db.query<any>("SELECT id FROM dnc_entries WHERE (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?) LIMIT 1").get(phoneVal, emailVal);
              if (!existing) db.run("INSERT INTO dnc_entries(phone,email,name,raw,created_at) VALUES(?,?,?,?,?)", phoneVal, emailVal, null, JSON.stringify({ line: v }), new Date().toISOString());
            } else {
              const dupLine = db.query<any>("SELECT id FROM imported_leads WHERE source=? AND phone=? LIMIT 1").get(source, phoneVal);
              if (dupLine) { skipped++; continue; }
              db.run("INSERT INTO imported_leads (source,contact_name,email,phone,raw,created_at) VALUES (?,?,?,?,?,?)", source, null, emailVal, phoneVal, JSON.stringify({ line: v }), new Date().toISOString());
            }
            imported++;
          } catch (e) { errors.push(`line ${imported + skipped + 1}: ${e instanceof Error ? e.message : "invalid row"}`); }
        }
        return finish();
      }
      for (const vals of rows.slice(1)) {
        if (!vals.some(v => v.trim())) { skipped++; continue; }
        const raw = Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
        try {
          const get = (f: string) => map[f] === undefined ? undefined : vals[map[f] as number];
          let contactName = get("contact_name");
          if (!contactName && Array.isArray(map.contact_name_parts)) { const [fi, li] = map.contact_name_parts as number[]; contactName = [vals[fi], vals[li]].filter(Boolean).map(s => String(s).trim()).join(" ").trim() || undefined; }
          const phone = digits(get("phone")); const email = emailNorm(get("email"));
          if (source === "dnc") {
                        const existing = db.query<any>("SELECT id FROM dnc_entries WHERE (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?) LIMIT 1").get(phone, email);
            if (!existing) db.run("INSERT INTO dnc_entries(phone,email,name,raw,created_at) VALUES(?,?,?,?,?)", phone || null, email || null, contactName || null, JSON.stringify(raw), new Date().toISOString());
          } else if (source === "agents") {
            const address = get("property_address") || assembleAddress({ streetNumber: get("street_number"), streetName: get("street_name"), streetSuffix: get("street_suffix"), dirPrefix: get("street_dir_prefix"), dirSuffix: get("street_dir_suffix"), unit: get("unit") }) || get("mailing_address") || assembleAddress({ streetNumber: get("mailing_street_number"), streetName: get("mailing_street_name"), streetSuffix: get("mailing_street_suffix"), dirPrefix: get("mailing_street_dir_prefix"), dirSuffix: get("mailing_street_dir_suffix"), unit: get("mailing_unit") }) || null;
            const agentName=contactName || null;
            const firm=map.firm===undefined ? null : vals[map.firm as number] || null;
            const existing=db.query<any>("SELECT id FROM agent_entries WHERE (agent_name IS NOT NULL AND lower(agent_name)=lower(?)) OR (address IS NOT NULL AND lower(address)=lower(?)) LIMIT 1").get(agentName,address);
            if (!existing) db.run("INSERT INTO agent_entries(agent_name,firm,phone,email,address,raw,created_at) VALUES(?,?,?,?,?,?,?)",agentName,firm,phone||null,email||null,address,JSON.stringify(raw),new Date().toISOString()); else { skipped++; continue; }
          } else {
            const lead: any = { source, contact_name: contactName || null, email: email || null, phone: phone || null, property_address: get("property_address") || assembleAddress({ streetNumber: get("street_number"), streetName: get("street_name"), streetSuffix: get("street_suffix"), dirPrefix: get("street_dir_prefix"), dirSuffix: get("street_dir_suffix"), unit: get("unit") }), town: get("town") || null, state: get("state") || null, zip: get("zip") || null, mailing_address: get("mailing_address") || assembleAddress({ streetNumber: get("mailing_street_number"), streetName: get("mailing_street_name"), streetSuffix: get("mailing_street_suffix"), dirPrefix: get("mailing_street_dir_prefix"), dirSuffix: get("mailing_street_dir_suffix"), unit: get("mailing_unit") }) || null, purchase_year: num(get("purchase_year")), est_value: num(get("est_value")), beds: num(get("beds")), baths: num(get("baths")), sqft: num(get("sqft")), list_date: isoDate(get("list_date")), expiry_date: isoDate(get("expiry_date")), price_reduced: /^(1|yes|true|y|reduced)/i.test(get("price_reduced") || "") ? 1 : 0, active_with_agent: /(active|listed)/i.test(get("active_with_agent") || "") ? 1 : 0, raw: JSON.stringify(raw), created_at: new Date().toISOString() };
            const dupKey = lead.mailing_address || lead.property_address;
            if (dupKey) { const dup = db.query<any>("SELECT id,contact_name FROM imported_leads WHERE source=? AND (mailing_address=? OR property_address=?) LIMIT 1").get(source, dupKey, dupKey); if (dup) { if (!dup.contact_name && lead.contact_name) { db.run("DELETE FROM imported_leads WHERE id=?", dup.id); } else { skipped++; continue; } } }
            db.run("INSERT INTO imported_leads (source,contact_name,email,phone,property_address,town,state,zip,mailing_address,purchase_year,est_value,beds,baths,sqft,list_date,expiry_date,price_reduced,active_with_agent,raw,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ...Object.values(lead));
          }
          imported++;
        } catch (e) { errors.push(`row ${imported + skipped + 2}: ${e instanceof Error ? e.message : "invalid row"}`); }
      }
      return finish();
    } catch (e) { return json({ error: e instanceof Error ? e.message : "Import failed" }, 400); }
  } } }
});
