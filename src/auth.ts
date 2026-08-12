// LeadForge auth core — signed httpOnly session cookies (HMAC-SHA256).
//
// Session token format: base64url(JSON payload) "." base64url(HMAC-SHA256)
// Payload: { uid, mcp, sv, exp } — user id, must-change-password flag,
// session_version (rotated on password change → old cookies die), expiry.
// No server-side session store needed: logout = clear cookie; rotation =
// bump session_version. SESSION_SECRET lives only in .env.
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, type User } from "~/db";

export const SESSION_COOKIE = "lf_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET is missing or too short — add it to /home/team/shared/site/.env and restart");
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

// Returns the verified payload string (constant-time signature compare) or null.
function verifySigned(payload: string, sig: string): boolean {
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type SessionPayload = { uid: number; mcp: 0 | 1; sv: number; exp: number };

export function createSessionToken(user: Pick<User, "id" | "must_change_password" | "session_version">): string {
  const payload: SessionPayload = {
    uid: user.id,
    mcp: user.must_change_password ? 1 : 0,
    sv: user.session_version,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readSessionToken(token: string): SessionPayload | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!verifySigned(body, sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!p || typeof p.uid !== "number" || typeof p.exp !== "number") return null;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

export function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// The signed-cookie session is validated against the DB on every request:
// the user must still exist and session_version must match (password change
// rotates the version → old cookies rejected).
export function getUserFromRequest(request: Request): User | null {
  const token = cookieValue(request);
  if (!token) return null;
  const p = readSessionToken(token);
  if (!p) return null;
  const user = db.query<User>("SELECT * FROM users WHERE id=?").get(p.uid);
  if (!user) return null;
  if (user.session_version !== p.sv) return null;
  return user;
}

export function isSecureRequest(request: Request): boolean {
  const u = new URL(request.url);
  return u.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function redirectResponse(location: string, setCookies: string[] = [], status = 303): Response {
  const headers = new Headers({ Location: location });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status, headers });
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
