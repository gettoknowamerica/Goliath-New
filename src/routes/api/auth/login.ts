import { createFileRoute } from "@tanstack/react-router";
import { db, type User } from "~/db";
import { dummyPasswordHash, verifyPassword } from "~/password";
import {
  createSessionToken, isSecureRequest, redirectResponse, sessionCookieHeader,
} from "~/auth";

// POST /api/auth/login — form-encoded {email, password}. On success sets the
// httpOnly signed session cookie and 303-redirects to /change-password when a
// password change is forced (first login), else to /. On failure redirects back
// to /login?error=... (works for both a plain HTML form and fetch callers).
export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const params = new URLSearchParams(await request.text());
          const email = (params.get("email") || "").trim().toLowerCase();
          const password = params.get("password") || "";
          if (!email || !password) return redirectResponse("/login?error=missing");
          const user = db.query<User>("SELECT * FROM users WHERE email=?").get(email);
          const ok = user
            ? verifyPassword(password, user.password_hash)
            : verifyPassword(password, dummyPasswordHash()); // equalize timing
          if (!user || !ok) return redirectResponse("/login?error=invalid");
          db.run("UPDATE users SET last_login_at=? WHERE id=?", new Date().toISOString(), user.id);
          const token = createSessionToken(user);
          const secure = isSecureRequest(request);
          const to = user.must_change_password ? "/change-password" : "/";
          return redirectResponse(to, [sessionCookieHeader(token, secure)]);
        } catch (e) {
          console.error("[auth] login failed:", e);
          return redirectResponse("/login?error=server");
        }
      },
    },
  },
});
