import path from "node:path";
import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { classify, classifyPreview, extractCompany, extractCompanyFromPreview, companyKey, isOutcomeSubject } from "./classify";

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

// Optional: without a key the app still works, the unclear pile just stays unclear
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = "claude-haiku-4-5-20251001";

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
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS company TEXT`);
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS company_key TEXT`);
  // What the AI said about emails the rules couldn't sort. Kept separate from the rules' answer.
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS llm_label TEXT`);
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS llm_company TEXT`);
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS llm_company_key TEXT`);
  // Which second pass decided: 'preview' (free rules on Gmail's preview) or 'ai' (Claude)
  await pool.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS llm_source TEXT`);
  // A user's manual fix for one card. stage is a column key, or 'hidden' for "not a job"
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corrections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, company_key)
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
  "newer_than:90d -in:sent -category:promotions " +
  "-from:jobmail@s.seek.com.au -from:noreply@glassdoor.com " +
  "-from:alert@indeed.com -from:jobalerts-noreply@linkedin.com " +
  "{subject:application subject:applications subject:applying subject:interview " +
  'subject:unfortunately subject:assessment subject:"thank you for your interest" ' +
  'subject:"job offer" subject:"offer of employment" subject:"your update from" ' +
  "from:greenhouse.io from:lever.co from:myworkday.com from:myworkdayjobs.com " +
  "from:smartrecruiters.com from:ashbyhq.com from:workablemail.com from:noreply@s.seek.com.au from:indeedapply@indeed.com}";

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

  // If the query got stricter, drop stored emails it no longer matches.
  // Only when we saw the full result set, so the 500 cap never deletes real data.
  if (ids.length < MAX_MESSAGES) {
    await pool.query(
      `DELETE FROM emails WHERE user_id = $1 AND NOT (gmail_id = ANY($2))`,
      [userId, ids]
    );
  }
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

  await reclassify(userId);

  // Second pass is a bonus: if it fails, the sync still succeeds with subject-only labels
  try {
    await secondPass(userId, client);
  } catch (err) {
    console.error("Second pass failed", err);
  }
  return ids.length;
}

// ---------- AI fallback for emails the rules couldn't sort ----------

const AI_LABELS = ["applied", "in_review", "interview", "offer", "rejected", "other", "unclear"];

const AI_PROMPT = `You sort emails from a job seeker's inbox. For each email, decide what it says about the user's own job application:
- applied: confirms an application was received or submitted
- in_review: application viewed or being reviewed, no decision yet
- interview: invitation to an interview, assessment, test, or next stage
- offer: a job offer
- rejected: not progressing, unsuccessful, role closed or filled
- other: not about the user's own application (newsletters, courses, job alerts, marketing, account notices)
- unclear: you truly cannot tell
Many "application update" or "outcome" emails are rejections, so read the preview carefully.
Also give the hiring company's name. Never a job board or ATS (SEEK, LinkedIn, Indeed, Workday, etc). Use "" if unknown.
Emails as JSON:
`;

type AiInput = { gmail_id: string; from_addr: string; subject: string; snippet: string };

async function askClaude(emails: AiInput[]) {
  const msg = await anthropic!.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    tools: [
      {
        name: "record_labels",
        description: "Record one label and company for every email",
        input_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string", enum: AI_LABELS },
                  company: { type: "string" },
                },
                required: ["id", "label", "company"],
              },
            },
          },
          required: ["results"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_labels" },
    messages: [
      {
        role: "user",
        content:
          AI_PROMPT +
          JSON.stringify(
            emails.map((e) => ({ id: e.gmail_id, from: e.from_addr, subject: e.subject, preview: e.snippet }))
          ),
      },
    ],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  const input = block && block.type === "tool_use" ? (block.input as { results?: unknown }) : {};
  const results = Array.isArray(input.results) ? input.results : [];
  return results.filter(
    (x): x is { id: string; label: string; company: string } =>
      typeof x?.id === "string" && AI_LABELS.includes(x?.label) && typeof x?.company === "string"
  );
}

async function saveSecondPass(
  userId: string,
  rows: { gmail_id: string; label: string; company: string | null; source: string }[]
) {
  if (rows.length === 0) return;
  await pool.query(
    `UPDATE emails e
     SET llm_label = v.label, llm_company = v.company, llm_company_key = v.company_key, llm_source = v.source
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       AS v(gmail_id, label, company, company_key, source)
     WHERE e.user_id = $1 AND e.gmail_id = v.gmail_id`,
    [
      userId,
      rows.map((r) => r.gmail_id),
      rows.map((r) => r.label),
      rows.map((r) => r.company),
      rows.map((r) => (r.company ? companyKey(r.company) : null)),
      rows.map((r) => r.source),
    ]
  );
}

// For emails the subject rules couldn't sort:
//   1. free rules on Gmail's preview (always)
//   2. Claude, only for what's still unclear, and only if ANTHROPIC_API_KEY is set
async function secondPass(userId: string, client: OAuth2Client) {
  // Outcome emails that were already checked but stayed unclear: apply the "likely rejection" fallback
  const old = await pool.query(
    `SELECT gmail_id, subject FROM emails
     WHERE user_id = $1 AND label = 'unclear' AND llm_label = 'unclear'`,
    [userId]
  );
  await saveSecondPass(
    userId,
    old.rows
      .filter((e) => isOutcomeSubject(e.subject))
      .map((e) => ({ gmail_id: e.gmail_id, label: "rejected", company: null, source: "outcome" }))
  );

  // Emails worth a second look:
  //  - "unclear": the subject said nothing
  //  - "applied": friendly subjects like "Thank you for your application" often hide a rejection
  // Plus unclear ones the preview couldn't sort, if AI is now available to try.
  const r = await pool.query(
    `SELECT gmail_id, from_addr, subject, label, llm_label, company FROM emails
     WHERE user_id = $1 AND label IN ('unclear', 'applied')
       AND (llm_label IS NULL OR (label = 'unclear' AND llm_label = 'unclear' AND llm_source = 'preview'))
     ORDER BY received_at DESC LIMIT 400`,
    [userId]
  );
  // Without AI, anything already preview-checked has nothing new to learn
  const rows = anthropic ? r.rows : r.rows.filter((e) => e.llm_label === null);
  if (rows.length === 0) return;
  const subjectLabel = new Map<string, string>(rows.map((e) => [e.gmail_id, e.label]));
  const hasCompany = new Set<string>(rows.filter((e) => e.company).map((e) => e.gmail_id));

  // Gmail's ~200 character preview. Used in memory only, never stored.
  const emails: AiInput[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    const batch = await Promise.all(
      rows.slice(i, i + 10).map(async (e) => {
        const m = await client.request<{ snippet?: string }>({
          url: GMAIL + "/" + e.gmail_id + "?format=metadata&fields=snippet",
        });
        return { gmail_id: e.gmail_id, from_addr: e.from_addr, subject: e.subject, snippet: (m.data.snippet ?? "").slice(0, 300) };
      })
    );
    emails.push(...batch);
  }

  // Pass 1: free preview rules
  const decided: { gmail_id: string; label: string; company: string | null; source: string }[] = [];
  const stillUnclear: AiInput[] = [];
  for (const e of emails) {
    let label: string = classifyPreview(e.snippet);
    let source = "preview";
    // Preview didn't settle it, but the subject is an "outcome/update" email: likely a rejection
    if (label === "unclear" && isOutcomeSubject(e.subject)) {
      label = "rejected";
      source = "outcome";
    }
    // No company in the subject (e.g. Indeed confirmations)? Try the preview.
    const company = hasCompany.has(e.gmail_id) ? null : extractCompanyFromPreview(e.snippet);
    decided.push({ gmail_id: e.gmail_id, label, company, source });
    // AI only for emails whose subject said nothing (not for every "applied" one, to keep costs tiny)
    if (label === "unclear" && subjectLabel.get(e.gmail_id) === "unclear") stillUnclear.push(e);
  }
  await saveSecondPass(userId, decided);

  // Pass 2: Claude, 20 emails per request, only if a key is configured
  if (!anthropic) return;
  for (let i = 0; i < stillUnclear.length; i += 20) {
    const chunk = stillUnclear.slice(i, i + 20);
    const results = await askClaude(chunk);
    const byId = new Map(results.map((x) => [x.id, x]));
    await saveSecondPass(
      userId,
      chunk.map((e) => {
        const res = byId.get(e.gmail_id);
        return {
          gmail_id: e.gmail_id,
          label: res?.label ?? "unclear",
          company: res?.company.trim() || null,
          source: "ai",
        };
      })
    );
  }
}

// Relabel every email for this user in ONE query, so rule changes apply to old emails too
async function reclassify(userId: string) {
  const r = await pool.query(
    `SELECT gmail_id, from_addr, subject FROM emails WHERE user_id = $1`,
    [userId]
  );
  const ids: string[] = [];
  const labels: string[] = [];
  const companies: (string | null)[] = [];
  const keys: (string | null)[] = [];
  for (const e of r.rows) {
    const company = extractCompany(e.from_addr, e.subject);
    ids.push(e.gmail_id);
    labels.push(classify(e.from_addr, e.subject));
    companies.push(company);
    keys.push(company ? companyKey(company) : null);
  }
  await pool.query(
    `UPDATE emails e
     SET label = v.label, company = v.company, company_key = v.company_key
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       AS v(gmail_id, label, company, company_key)
     WHERE e.user_id = $1 AND e.gmail_id = v.gmail_id`,
    [userId, ids, labels, companies, keys]
  );
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

const STAGES = ["applied", "in_review", "interview", "offer", "rejected"];

type TimelineItem = { subject: string; received_at: string; label: string; via: string };
type Card = {
  key: string;
  company: string;
  stage: string;
  appliedAt: string;
  updatedAt: string;
  respondedAt: string | null; // first reply after applying, for "typical reply time"
  reachedInterview: boolean;
  emails: number;
  timeline: TimelineItem[];
  autoStage: string;   // what the rules said
  corrected: boolean;  // true if the user's fix is being applied
};

app.get("/api/board", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });

  const r = await pool.query(
    `SELECT gmail_id, from_addr, subject, received_at,
       -- The preview/AI answer wins when the subject said nothing, or only said "applied"
       CASE WHEN label IN ('unclear', 'applied') AND llm_label IS NOT NULL AND llm_label NOT IN ('unclear', 'other')
            THEN llm_label
            WHEN label = 'unclear' AND llm_label = 'other' THEN 'other'  -- AI says it isn't about an application
            ELSE label END AS label,
       CASE WHEN label IN ('unclear', 'applied') AND llm_label IS NOT NULL AND llm_label NOT IN ('unclear', 'other')
                 AND llm_label <> label
            THEN llm_source ELSE 'rules' END AS via,
       COALESCE(company, llm_company) AS company,
       COALESCE(company_key, llm_company_key) AS company_key
     FROM emails WHERE user_id = $1 ORDER BY received_at ASC`,
    [user.id]
  );

  const cards = new Map<string, Card>();
  const unclear: { gmail_id: string; from_addr: string; subject: string; received_at: string }[] = [];

  // Oldest first, so each later email moves the card forward
  for (const e of r.rows) {
    if (e.label === "unclear") {
      unclear.push({ gmail_id: e.gmail_id, from_addr: e.from_addr, subject: e.subject, received_at: e.received_at });
      continue;
    }
    if (!STAGES.includes(e.label) || !e.company_key) continue;

    const item = { subject: e.subject, received_at: e.received_at, label: e.label, via: e.via };
    const isInterview = e.label === "interview" || e.label === "offer";
    const card = cards.get(e.company_key);

    if (!card) {
      cards.set(e.company_key, {
        key: e.company_key,
        company: e.company,
        stage: e.label,
        appliedAt: e.received_at,
        updatedAt: e.received_at,
        respondedAt: null,
        reachedInterview: isInterview,
        emails: 1,
        timeline: [item],
        autoStage: e.label,
        corrected: false,
      });
    } else {
      if (!card.respondedAt && e.label !== "applied") card.respondedAt = e.received_at;
      card.stage = e.label;
      card.autoStage = e.label;
      card.updatedAt = e.received_at;
      card.reachedInterview = card.reachedInterview || isInterview;
      card.emails++;
      card.timeline.push(item);
    }
  }

  // Apply the user's corrections on top of the rules.
  // A fix only holds until a newer email arrives: if you move a card to Interview
  // and a rejection comes in next week, the rejection wins. "Not a job" is permanent.
  const fixes = await pool.query(
    `SELECT company_key, stage, created_at FROM corrections WHERE user_id = $1`,
    [user.id]
  );
  let hidden = 0;
  for (const f of fixes.rows) {
    const card = cards.get(f.company_key);
    if (!card) continue;
    if (f.stage === "hidden") {
      cards.delete(f.company_key);
      hidden++;
    } else if (new Date(card.updatedAt) <= new Date(f.created_at)) {
      card.stage = f.stage;
      card.corrected = true;
    }
  }

  res.json({
    cards: [...cards.values()].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    unclear: unclear.reverse(),
    hidden,
  });
});

// "This is wrong": move a card to another column, or hide it as not a job
app.post("/api/corrections", express.json(), async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { companyKey, stage } = req.body ?? {};
  if (typeof companyKey !== "string" || ![...STAGES, "hidden"].includes(stage)) {
    return res.status(400).json({ error: "Bad correction" });
  }
  await pool.query(
    `INSERT INTO corrections (user_id, company_key, stage) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, company_key) DO UPDATE SET stage = EXCLUDED.stage, created_at = now()`,
    [user.id, companyKey, stage]
  );
  res.json({ ok: true });
});

// Undo a correction, back to what the rules say
app.delete("/api/corrections/:key", async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  await pool.query(
    `DELETE FROM corrections WHERE user_id = $1 AND company_key = $2`,
    [user.id, req.params.key]
  );
  res.json({ ok: true });
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