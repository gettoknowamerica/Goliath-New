import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { hashPassword, verifyPassword } from "~/password";
import {
  createSessionToken, getUserFromRequest, isSecureRequest,
  redirectResponse, sessionCookieHeader, unauthorized,
} from "~/auth";

// POST /api/auth/password — {current, new} (form-encoded or JSON). Requires a
// valid session. Validates strength (min 8 chars, not equal to current),
// re-hashes, clears must_change_password, bumps session_version (rotates the
// session — all previously issued cookies are rejected), re-issues the cookie,
// then 303s to /. Form-encoded from the /change-password page.
export const Route = createFileRoute("/api/auth/password")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = getUserFromRequest(request);
        if (!user) return unauthorized();
        try {
          const raw = await request.text();
          let current = "", next = "";
          if (raw.trim().startsWith("{")) {
            const b = JSON.parse(raw) as Record<string, unknown>;
            current = String(b.current ?? ""); next = String(b.new ?? "");
          } else {
            const p = new URLSearchParams(raw);
            current = p.get("current") || ""; next = p.get("new") || "";
          }
          if (!current || !next) return redirectResponse("/change-password?error=missing");
          if (!verifyPassword(current, user.password_hash)) return redirectResponse("/change-password?error=current");
          if (next.length < 8) return redirectResponse("/change-password?error=weak");
          if (next === current) return redirectResponse("/change-password?error=same");
          const nextHash = hashPassword(next);
          db.run(
            "UPDATE users SET password_hash=?, must_change_password=0, session_version=session_version+1 WHERE id=?",
            nextHash, user.id,
          );
          const fresh = db.query<typeof user>("SELECT * FROM users WHERE id=?").get(user.id);
          const token = createSessionToken(fresh!);
          const secure = isSecureRequest(request);
          return redirectResponse("/", [sessionCookieHeader(token, secure)]);
        } catch (e) {
          console.error("[auth] password change failed:", e);
          return redirectResponse("/change-password?error=server");
        }
      },
    },
  },
});
