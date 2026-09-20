import path from "node:path";
import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { Pool } from "pg";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, DATABASE_URL } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET || !DATABASE_URL) {
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

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- Database ----------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      credentials JSONB NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emails (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gmail_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      label TEXT,
      PRIMARY KEY (user_id, gmail_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      found INT NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
  `);
}

async function upsertUser(user: { id: string; email: string; name: string }) {
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
    [user.id, user.email, user.name]
  );
}

async function saveGmailTokens(userId: string, tokens: Credentials) {
  await pool.query(
    `INSERT INTO gmail_accounts (user_id, credentials) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET credentials = EXCLUDED.credentials`,
    [userId, tokens]
  );
}

async function getGmailTokens(userId: string): Promise<Credentials | null> {
  const r = await pool.query(`SELECT credentials FROM gmail_accounts WHERE user_id = $1`, [userId]);
  return r.rows[0]?.credentials ?? null;
}

// ---------- Gmail ----------

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const MAX_MESSAGES = 500;

// v2: match subjects instead of bodies, skip promotions and job alerts
const JOB_QUERY =
  "newer_than:90d -category:promotions " +
  "-from:jobmail@s.seek.com.au -from:noreply@glassdoor.com " +
  "{subject:application subject:applications subject:applying subject:interview " +
  'subject:unfortunately subject:assessment subject:"thank you for your interest" ' +
  'subject:"job offer" subject:"offer of employment" ' +
  "from:greenhouse.io from:lever.co from:myworkday.com from:myworkdayjobs.com " +
  "from:smartrecruiters.com from:ashbyhq.com from:workablemail.com from:noreply@s.seek.com.au}";

async function gmailClientFor(userId: string) {
  const tokens = await getGmailTokens(userId);
  if (!tokens) throw new Error("Gmail not connected");
  const client = newOAuthClient();
  client.setCredentials(tokens);
  client.on("tokens", (fresh) => {
    saveGmailTokens(userId, { ...tokens, ...fresh }).catch(() => {});
  });
  return client;
}

async function listMessageIds(client: OAuth2Client) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url =
      GMAIL + "?maxResults=100&q=" + encodeURIComponent(JOB_QUERY) +
      (pageToken ? "&pageToken=" + pageToken : "");
    const r = await client.request<{ messages?: { id: string }[]; nextPageToken?: string }>({ url });
    for (const m of r.data.messages ?? []) ids.push(m.id);
    pageToken = r.data.nextPageToken;
  } while (pageToken && ids.length < MAX_MESSAGES);
  return ids.slice(0, MAX_MESSAGES);
}

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  payload?: { headers?: { name: string; value: string }[] };
};

async function fetchMeta(client: OAuth2Client, id: string) {
  const r = await client.request<GmailMessage>({
    url: GMAIL + "/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject",
  });
  const headers = r.data.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  return {
    id: r.data.id,
    threadId: r.data.threadId,
    from: get("From"),
    subject: get("Subject"),
    receivedAt: new Date(Number(r.data.internalDate)),
  };
}

async function syncUser(userId: string) {
  const client = await gmailClientFor(userId);
  const ids = await listMessageIds(client);

  const existing = await pool.query(
    `SELECT gmail_id FROM emails WHERE user_id = $1 AND gmail_id = ANY($2)`,
    [userId, ids]
  );
  const have = new Set(existing.rows.map((r) => r.gmail_id));
  const todo = ids.filter((id) => !have.has(id));

  // 10 at a time: fast, but gentle on Gmail's rate limits
  for (let i = 0; i < todo.length; i += 10) {
    const batch = await Promise.all(todo.slice(i, i + 10).map((id) => fetchMeta(client, id)));
    for (const m of batch) {
      await pool.query(
        `INSERT INTO emails (user_id, gmail_id, thread_id, from_addr, subject, received_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [userId, m.id, m.threadId, m.from, m.subject, m.receivedAt]
      );
    }
  }
  return ids.length;
}

// ---------- Job queue (a Postgres table) ----------

let workerRunning = false;

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const r = await pool.query(`
        UPDATE sync_jobs SET status = 'running'
        WHERE id = (
          SELECT id FROM sync_jobs WHERE status = 'queued'
          ORDER BY id LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, user_id
      `);
      const job = r.rows[0];
      if (!job) break; // queue empty, stop so Neon can sleep

      try {
        const found = await syncUser(job.user_id);
        await pool.query(
          `UPDATE sync_jobs SET status = 'done', found = $2, finished_at = now() WHERE id = $1`,
          [job.id, found]
        );
      } catch (err) {
        console.error("Sync failed", err);
        await pool.query(
          `UPDATE sync_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [job.id, String(err)]
        );
      }
    }
  } finally {
    workerRunning = false;
  }
}

// ---------- App ----------

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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session = { state, flow: "login" };
  const url = oauth.generateAuthUrl({ scope: ["openid", "email", "profile"], state });
  res.redirect(url);
});

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

app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== "string" || state !== req.session?.state) {
    return res.status(400).send("Invalid login attempt");
  }
  const { tokens } = await oauth.getToken(code);

  if (req.session?.flow === "gmail") {
    const user = req.session.user;
    await upsertUser(user);
    await saveGmailTokens(user.id, tokens);
    req.session = { user };
    return res.redirect(WEB_URL);
  }

  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token!, audience: GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email) return res.status(400).send("No profile returned");

  const user = { id: p.sub, email: p.email, name: p.name ?? p.email };
  await upsertUser(user);
  req.session = { user };
  res.redirect(WEB_URL);
});

app.get("/api/me", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ user: null });
  const tokens = await getGmailTokens(user.id);
  res.json({ user, gmailConnected: Boolean(tokens) });
});

// Queue a sync. Returns immediately, the worker does the slow part.
app.post("/api/sync", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const active = await pool.query(
    `SELECT id FROM sync_jobs WHERE user_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
    [user.id]
  );
  if (active.rows.length === 0) {
    await pool.query(`INSERT INTO sync_jobs (user_id) VALUES ($1)`, [user.id]);
  }
  runWorker().catch((err) => console.error("Worker crashed", err));
  res.status(202).json({ ok: true });
});

app.get("/api/sync/status", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const r = await pool.query(
    `SELECT status, found, error, finished_at FROM sync_jobs
     WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  res.json({ job: r.rows[0] ?? null });
});

app.get("/api/emails", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const total = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE user_id = $1`, [user.id]);
  const r = await pool.query(
    `SELECT gmail_id, from_addr, subject, received_at, label FROM emails
     WHERE user_id = $1 ORDER BY received_at DESC LIMIT 50`,
    [user.id]
  );
  res.json({ total: total.rows[0].n, emails: r.rows });
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

if (PUBLIC_URL) {
  const dist = path.resolve(process.cwd(), "../web/dist");
  app.use(express.static(dist));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  await initDb();
  // If the server died mid-sync, put those jobs back in the queue
  await pool.query(`UPDATE sync_jobs SET status = 'queued' WHERE status = 'running'`);
  app.listen(PORT, () => console.log("API on " + API_URL));
  runWorker().catch((err) => console.error("Worker crashed", err));
}

start().catch((err) => {
  console.error("Failed to start", err);
  process.exit(1);
});