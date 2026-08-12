// Call-sheet PDF renderer — per-contact printable cards (owner spec):
// LEFT: opaque/shaded box with house intel (address, town, beds×baths, sqft,
// est value, purchase year, days on market, price reduced, big SCORE badge).
// RIGHT: contact line (name, phones with "web" tag when from enrichment,
// emails with "web" tag when enrichment-stamped, source/market status).
import PDFDocument from "pdfkit";

export type CallSheetRow = Record<string, any>;

// US Letter geometry
const PAGE_W = 612;
const PAGE_H = 792;
const ML = 40;
const MR = 40;
const CONTENT_W = PAGE_W - ML - MR; // 532
const BOX_W = 252;
const GAP = 16;
const RIGHT_X = ML + BOX_W + GAP; // 308
const RIGHT_W = CONTENT_W - BOX_W - GAP; // 264
const TOP = 96; // content starts below the page header
const BOTTOM_M = 60;
const MAX_Y = PAGE_H - BOTTOM_M;

const DARK = "#232833";
const MUTED = "#5B6572";
const FAINT = "#8A93A0";
const BOX_FILL = "#EDEFF3";
const BOX_BORDER = "#D5DAE2";
const RULE = "#C9CFD8";

const winAnsi = (s: string) =>
  s.replace(/[^\x20-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u2022\u00B7]/g, "?");
const clip = (s: string, n = 64) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const fmtMoney = (v: unknown) => {
  const n = num(v);
  return n === null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
};
const fmtInt = (v: unknown) => {
  const n = num(v);
  return n === null ? "—" : Math.round(n).toLocaleString("en-US");
};
const bool = (v: unknown) =>
  v === 1 || v === true || v === "1" || v === "yes" || v === "Yes" ? "Yes" : "No";

function dateObj(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
// Days on market from list/expiry dates; days since expiry when only an expiry
// exists; "—" when no dates are present.
function domLabel(l: CallSheetRow): string {
  const list = dateObj(l.list_date);
  const expiry = dateObj(l.expiry_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = (a: Date, b: Date) =>
    Math.max(0, Math.round((a.getTime() - b.getTime()) / 86_400_000));
  if (list && expiry) return `${days(expiry, list)} days on market`;
  if (list) return `${days(today, list)} days on market`;
  if (expiry) return `${days(today, expiry)} days since expiry`;
  return "—";
}

export function renderCallSheetPDF(
  rows: CallSheetRow[],
  opts: { title?: string } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 36, bottom: BOTTOM_M, left: ML, right: MR },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const title = opts.title ?? "LeadForge Call Sheet";
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  let pageNo = 1;
  let y = TOP;

  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor(DARK).text(winAnsi(title), ML, 40, {
      width: CONTENT_W,
    });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text(
        winAnsi(
          `Generated ${dateStr} · ${rows.length} contact${rows.length === 1 ? "" : "s"} · sorted by score`,
        ),
        ML,
        66,
        { width: CONTENT_W },
      );
    doc.moveTo(ML, 88).lineTo(ML + CONTENT_W, 88).lineWidth(0.8).strokeColor(RULE).stroke();
    y = TOP;
  };
  const drawFooter = () => {
    // NOTE: footer text must stay above the bottom margin (maxY = PAGE_H - BOTTOM_M
    // = 732). pdfkit auto-inserts a page break when a text call would run past
    // maxY — drawing the footer below it silently creates extra near-blank pages.
    doc.moveTo(ML, PAGE_H - 52).lineTo(ML + CONTENT_W, PAGE_H - 52).lineWidth(0.5).strokeColor("#D9DEE6").stroke();
    const f = `LeadForge Call Sheet — Page ${pageNo}`;
    doc.font("Helvetica").fontSize(8).fillColor(FAINT);
    const fw = doc.widthOfString(f);
    doc.text(f, ML + (CONTENT_W - fw) / 2, PAGE_H - 74);
  };
  const ensure = (need: number) => {
    if (y + need <= MAX_Y) return;
    drawFooter();
    doc.addPage();
    pageNo++;
    drawHeader();
  };
  const measure = (text: string, size: number, width: number, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    return doc.heightOfString(text, { width });
  };
  const write = (
    text: string,
    x: number,
    yy: number,
    width: number,
    size: number,
    bold = false,
    color = DARK,
  ) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    doc.text(winAnsi(clip(text)), x, yy, { width, lineBreak: true });
  };

  drawHeader();
  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("No callable contacts.", ML, y);
  }

  const pad = 12;
  const innerW = BOX_W - pad * 2; // 228

  for (const l of rows) {
    const score = num(l.score);
    const scoreTxt = `SCORE ${score ?? 0}`;
    const addr = winAnsi(String(l.property_address ?? "").trim()) || "—";
    const town =
      winAnsi(
        [String(l.town ?? "").trim(), [String(l.state ?? "").trim(), String(l.zip ?? "").trim()].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      ) || "—";
    const beds = num(l.beds);
    const baths = num(l.baths);
    const bdBa =
      beds !== null || baths !== null ? `${beds ?? "—"} bd · ${baths ?? "—"} ba` : "—";
    const sqftTxt = num(l.sqft) !== null ? `${fmtInt(l.sqft)} sqft` : "—";
    const valueTxt = fmtMoney(l.est_value);
    const yearTxt = num(l.purchase_year) !== null ? String(num(l.purchase_year)) : "—";
    const domTxt = winAnsi(domLabel(l));
    const reducedTxt = bool(l.price_reduced);
    const name = winAnsi(String(l.contact_name ?? "").trim()) || "Unknown contact";
    const phones: { n: string; web: boolean }[] = [];
    if (l.phone) phones.push({ n: winAnsi(String(l.phone)), web: false });
    if (l.enriched_phone && String(l.enriched_phone) !== String(l.phone ?? ""))
      phones.push({ n: winAnsi(String(l.enriched_phone)), web: true });
    const emails: { a: string; web: boolean }[] = [];
    if (l.email) emails.push({ a: winAnsi(String(l.email)), web: l.email_source === "web" });
    // Social profiles + personal-context notes (enrichment upgrade 2026-08-14):
    // both come from the shared call-list row builder (src/call-list-export.ts),
    // which only surfaces non-DNC, source-backed findings.
    const socials: { p: string; u: string }[] = Array.isArray(l.socials) ? l.socials.slice(0, 3).map((s: any) => ({ p: winAnsi(String(s.platform || "social")), u: winAnsi(clip(String(s.url || ""), 56)) })) : [];
    const socialsMore = Array.isArray(l.socials) && l.socials.length > 3 ? l.socials.length - 3 : 0;
    const contexts: string[] = Array.isArray(l.context) ? l.context.slice(0, 2).map((c: string) => winAnsi(clip(String(c), 88))) : [];
    const status =
      winAnsi(
        [String(l.source ?? ""), l.market_status ? String(l.market_status) : ""]
          .filter(Boolean)
          .join(" · "),
      ) || "—";

    // --- measure both columns -------------------------------------------------
    const badgeH = 22;
    const addrH = measure(addr, 11, innerW, true);
    const townH = measure(town, 9.5, innerW);
    const intelLines = 6;
    const leftH = pad + badgeH + 8 + addrH + 3 + townH + 10 + 1 + 8 + intelLines * 14 + pad;

    const nameH = measure(name, 13, RIGHT_W, true);
    let phonesH = 0;
    for (const p of phones) phonesH += measure(p.n, 10.5, RIGHT_W) + 2;
    let emailsH = 0;
    for (const e of emails) emailsH += measure(e.a, 10.5, RIGHT_W) + 2;
    let socialsH = 0;
    for (const s of socials) socialsH += measure(`${s.p}  ${s.u}`, 8.5, RIGHT_W) + 2;
    if (socialsMore > 0) socialsH += 12;
    let contextsH = 0;
    for (const c of contexts) contextsH += measure(c, 8, RIGHT_W) + 3;
    const statusH = measure(status, 9.5, RIGHT_W);
    const rightH =
      pad + nameH + 4 + (phonesH > 0 ? phonesH : 12) + (emailsH > 0 ? emailsH : 0) +
      (socialsH > 0 ? 14 + socialsH : 0) + (contextsH > 0 ? 12 + contextsH : 0) + 16 + statusH + pad;

    const cardH = Math.max(leftH, rightH);
    ensure(cardH + 12);

    // --- LEFT: opaque shaded house-intel box ---------------------------------
    doc.roundedRect(ML, y, BOX_W, leftH, 8).fill(BOX_FILL);
    doc.roundedRect(ML, y, BOX_W, leftH, 8).lineWidth(0.8).stroke(BOX_BORDER);

    // Score badge (prominent, dark)
    const badgeW = doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .widthOfString(scoreTxt);
    const badgeX = ML + pad;
    const badgeY = y + pad;
    doc.roundedRect(badgeX, badgeY, badgeW + 14, badgeH, 5).fill(DARK);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#FFFFFF")
      .text(scoreTxt, badgeX + 7, badgeY + 4.5, { width: badgeW });

    let bx = ML + pad;
    let by = badgeY + badgeH + 8;
    write(addr, bx, by, innerW, 11, true, DARK);
    by += addrH + 3;
    write(town, bx, by, innerW, 9.5, false, MUTED);
    by += townH + 10;
    doc.moveTo(bx, by).lineTo(bx + innerW, by).lineWidth(0.6).strokeColor(BOX_BORDER).stroke();
    by += 8;
    const intel: [string, string][] = [
      ["Beds / Baths", bdBa],
      ["Sq ft", sqftTxt],
      ["Est. value", valueTxt],
      ["Purchased", yearTxt],
      ["Days", domTxt],
      ["Price reduced", reducedTxt],
    ];
    const labelW = 92;
    for (const [label, value] of intel) {
      write(label, bx, by, labelW, 9, false, FAINT);
      write(value, bx + labelW, by, innerW - labelW, 9, true, DARK);
      by += 14;
    }

    // --- RIGHT: contact line ---------------------------------------------------
    let rx = RIGHT_X;
    let ry = y + pad;
    write(name, rx, ry, RIGHT_W, 13, true, DARK);
    ry += nameH + 4;
    for (const p of phones) {
      write(`${p.n}${p.web ? "   (web)" : ""}`, rx, ry, RIGHT_W, 10.5, p.web ? false : true, p.web ? MUTED : DARK);
      ry += measure(p.n, 10.5, RIGHT_W) + 2;
    }
    if (phones.length === 0) ry += 12;
    for (const e of emails) {
      write(`${e.a}${e.web ? "   (web)" : ""}`, rx, ry, RIGHT_W, 10.5, false, DARK);
      ry += measure(e.a, 10.5, RIGHT_W) + 2;
    }
    if (socials.length > 0) {
      ry += 8;
      write("Socials", rx, ry, RIGHT_W, 8, true, FAINT);
      ry += 10;
      for (const s of socials) {
        write(`${s.p}  ${s.u}`, rx, ry, RIGHT_W, 8.5, false, MUTED);
        ry += measure(`${s.p}  ${s.u}`, 8.5, RIGHT_W) + 2;
      }
      if (socialsMore > 0) { write(`+${socialsMore} more`, rx, ry, RIGHT_W, 8, false, FAINT); ry += 12; }
    }
    if (contexts.length > 0) {
      ry += 6;
      write("Context", rx, ry, RIGHT_W, 8, true, FAINT);
      ry += 10;
      for (const c of contexts) {
        write(c, rx, ry, RIGHT_W, 8, false, MUTED);
        ry += measure(c, 8, RIGHT_W) + 3;
      }
    }
    ry += 16;
    write(status, rx, ry, RIGHT_W, 9.5, true, MUTED);

    y += cardH + 12;
  }

  drawFooter();
  doc.end();
  return done;
}
