import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
  throw new Error("Missing env vars, check api/.env");
}

const WEB_URL = "http://localhost:5173";
const API_URL = "http://localhost:3000";

const oauth = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${API_URL}/auth/google/callback`
);

const app = express();
app.use(cors({ origin: WEB_URL, credentials: true }));
app.use(
  cookieSession({
    name: "session",
    keys: [SESSION_SECRET],
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session = { state };
  const url = oauth.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== "string" || state !== req.session?.state) {
    return res.status(400).send("Invalid login attempt");
  }
  const { tokens } = await oauth.getToken(code);
  const ticket = await oauth.verifyIdToken({
    idToken: tokens.id_token!,
    audience: GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email) return res.status(400).send("No profile returned");

  req.session = {
    user: { id: p.sub, email: p.email, name: p.name ?? p.email },
  };
  res.redirect(WEB_URL);
});

app.get("/api/me", (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ user: null });
  res.json({ user });
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.listen(3000, () => console.log(`API on ${API_URL}`));