import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { OAuth2Client, type Credentials } from "google-auth-library";
import path from "node:path";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
  throw new Error("Missing env vars, check api/.env");
}

const PUBLIC_URL = process.env.PUBLIC_URL;
const IS_HTTPS = PUBLIC_URL?.startsWith("https://") ?? false;
const WEB_URL = PUBLIC_URL ?? "http://localhost:5173";
const API_URL = PUBLIC_URL ?? "http://localhost:3000";
const REDIRECT_URI = API_URL + "/auth/google/callback";

const newOAuthClient = () =>
  new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
const oauth = newOAuthClient();

// TEMPORARY: in memory, wiped on every server restart. Postgres replaces this in week 2.
const gmailTokens = new Map<string, Credentials>();

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: WEB_URL, credentials: true }));
app.use(
  cookieSession({
    name: "session",
    keys: [SESSION_SECRET],
    httpOnly: true,
    sameSite: "lax",
    secure: IS_HTTPS,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Sign in (basic profile only)
app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session = { state, flow: "login" };
  const url = oauth.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
  });
  res.redirect(url);
});

// Connect Gmail (read-only, asks for a refresh token)
app.get("/auth/gmail", (req, res) => {
  const user = req.session?.user;
  if (!user) return res.redirect(WEB_URL);
  const state = crypto.randomBytes(16).toString("hex");
  req.session = { user, state, flow: "gmail" };
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    login_hint: user.email,
    state,
  });
  res.redirect(url);
});

// One callback for both flows
app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== "string" || state !== req.session?.state) {
    return res.status(400).send("Invalid login attempt");
  }
  const { tokens } = await oauth.getToken(code);

  if (req.session?.flow === "gmail") {
    const user = req.session.user;
    gmailTokens.set(user.id, tokens);
    req.session = { user };
    return res.redirect(WEB_URL);
  }

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
  res.json({ user, gmailConnected: gmailTokens.has(user.id) });
});

// Reads headers only (From, Subject, Date). No body, nothing stored.
app.get("/api/gmail/latest", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const tokens = gmailTokens.get(user.id);
  if (!tokens) return res.status(400).json({ error: "Gmail not connected" });

  const client = newOAuthClient();
  client.setCredentials(tokens);

  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const list = await client.request<{ messages?: { id: string }[] }>({
    url: base + "?maxResults=1",
  });
  const id = list.data.messages?.[0]?.id;
  if (!id) return res.json({ message: null });

  const msg = await client.request<{
    payload?: { headers?: { name: string; value: string }[] };
  }>({
    url:
      base + "/" + id +
      "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
  });
  const headers = msg.data.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  res.json({
    message: { from: get("From"), subject: get("Subject"), date: get("Date") },
  });
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

if (PUBLIC_URL) {
  const dist = path.resolve(process.cwd(), "../web/dist");
  app.use(express.static(dist));
  app.get("/*splat", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log("API on " + API_URL));