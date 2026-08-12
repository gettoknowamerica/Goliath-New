// Password hashing for LeadForge auth — node:crypto scrypt (built into Bun, no
// native deps). Format: scrypt$N$r$p$<salt_b64url>$<hash_b64url>
// Per-user random 16-byte salt; 64-byte derived key; constant-time verify.
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const N = 16384; // cost (2^14) — ~40-80 ms per hash on modest hardware
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return [
    "scrypt",
    String(N),
    String(R),
    String(P),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, "base64url");
    const derived = scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// A precomputed dummy hash used to equalize login timing when the email is
// unknown (we still burn a scrypt round so response time doesn't reveal
// whether an account exists).
let dummyHash: string | null = null;
export function dummyPasswordHash(): string {
  if (!dummyHash) dummyHash = hashPassword("not-a-real-password-for-timing-" + Math.random());
  return dummyHash;
}
