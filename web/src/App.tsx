import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.PROD ? "" : "http://localhost:3000";

// ---------- Types ----------

type User = { id: string; email: string; name: string };
type Job = { status: "queued" | "running" | "done" | "failed"; found: number; error: string | null } | null;
type TimelineItem = { subject: string; received_at: string; label: string; via: string };
type Card = {
  key: string;
  company: string;
  stage: string;
  appliedAt: string;
  updatedAt: string;
  respondedAt: string | null;
  reachedInterview: boolean;
  emails: number;
  timeline: TimelineItem[];
  autoStage: string;
  corrected: boolean;
};
type Unclear = { gmail_id: string; from_addr: string; subject: string; received_at: string };

// ---------- Look and feel ----------

// Full class strings, so Tailwind can see them at build time
const STAGES = [
  { key: "applied", title: "Applied", dot: "bg-sky-500", border: "border-t-sky-500", pill: "bg-sky-50 text-sky-700 ring-sky-200" },
  { key: "in_review", title: "In review", dot: "bg-violet-500", border: "border-t-violet-500", pill: "bg-violet-50 text-violet-700 ring-violet-200" },
  { key: "interview", title: "Interview", dot: "bg-amber-500", border: "border-t-amber-500", pill: "bg-amber-50 text-amber-700 ring-amber-200" },
  { key: "offer", title: "Offer", dot: "bg-emerald-500", border: "border-t-emerald-500", pill: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  { key: "rejected", title: "Rejected", dot: "bg-rose-500", border: "border-t-rose-500", pill: "bg-rose-50 text-rose-700 ring-rose-200" },
];
const stageOf = (key: string) => STAGES.find((s) => s.key === key) ?? STAGES[0];

const AVATARS = [
  "bg-sky-100 text-sky-700", "bg-violet-100 text-violet-700", "bg-amber-100 text-amber-800",
  "bg-emerald-100 text-emerald-700", "bg-rose-100 text-rose-700", "bg-indigo-100 text-indigo-700",
  "bg-teal-100 text-teal-700", "bg-orange-100 text-orange-700",
];
function avatarClass(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

const DAY = 86_400_000;
const GHOST_DAYS = 21;
const daysSince = (d: string) => Math.floor((Date.now() - new Date(d).getTime()) / DAY);
function ago(d: string) {
  const n = daysSince(d);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 30) return n + "d ago";
  return new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const fullDate = (d: string) =>
  new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const isGhosted = (c: Card) => c.stage === "applied" && daysSince(c.appliedAt) >= GHOST_DAYS;

const call = (path: string, init?: RequestInit) =>
  fetch(API + path, { credentials: "include", ...init });

// ---------- App ----------

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<Job>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [unclear, setUnclear] = useState<Unclear[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Card | null>(null);
  const [hidden, setHidden] = useState(0);

  const busy = job?.status === "queued" || job?.status === "running";

  async function loadJob() {
    const r = await call("/api/sync/status");
    if (r.ok) setJob((await r.json()).job);
  }

  async function loadBoard() {
    const r = await call("/api/board");
    if (!r.ok) return;
    const d = await r.json();
    setCards(d.cards);
    setUnclear(d.unclear);
    setHidden(d.hidden ?? 0);
  }

  async function correct(card: Card, stage: string) {
    await call("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyKey: card.key, stage }),
    });
    setOpen(null);
    loadBoard();
  }

  async function undo(card: Card) {
    await call("/api/corrections/" + encodeURIComponent(card.key), { method: "DELETE" });
    setOpen(null);
    loadBoard();
  }

  useEffect(() => {
    call("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setUser(d?.user ?? null);
        setGmailConnected(Boolean(d?.gmailConnected));
        if (d?.user) {
          loadJob();
          loadBoard();
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadJob, 2000);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (job?.status === "done") loadBoard();
  }, [job?.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function startSync() {
    await call("/api/sync", { method: "POST" });
    setJob({ status: "queued", found: 0, error: null });
  }

  async function logout() {
    await call("/auth/logout", { method: "POST" });
    setUser(null);
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cards.filter((c) => c.company.toLowerCase().includes(q)) : cards;
  }, [cards, query]);

  if (loading) return null;
  if (!user) return <SignIn />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-6 py-3">
          <Logo />
          <div className="ml-auto flex items-center gap-3">
            {gmailConnected && (
              <>
                <SyncStatus job={job} />
                <button
                  onClick={startSync}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
                >
                  {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
                  {busy ? "Syncing" : "Sync inbox"}
                </button>
              </>
            )}
            <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
              <span className={"grid h-8 w-8 place-items-center rounded-full text-xs font-semibold " + avatarClass(user.email)}>
                {initials(user.name)}
              </span>
              <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-900">Sign out</button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-6 py-8">
        {!gmailConnected ? (
          <ConnectGmail />
        ) : cards.length === 0 && !busy ? (
          <EmptyBoard onSync={startSync} />
        ) : (
          <>
            <Stats cards={cards} />
            <Funnel cards={cards} />

            <div className="mt-8 flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">Your pipeline</h2>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search companies..."
                className="w-64 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-5">
              {STAGES.map((s) => {
                const inCol = visible.filter((c) => c.stage === s.key);
                return (
                  <section key={s.key} className={"flex flex-col rounded-xl border-t-4 bg-slate-100/70 " + s.border}>
                    <div className="flex items-center gap-2 px-3 py-3">
                      <span className={"h-2 w-2 rounded-full " + s.dot} />
                      <h3 className="text-sm font-semibold text-slate-700">{s.title}</h3>
                      <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500">
                        {inCol.length}
                      </span>
                    </div>
                    <div className="max-h-[65vh] space-y-2 overflow-y-auto px-3 pb-3">
                      {inCol.map((c) => (
                        <CardTile key={c.key} card={c} onOpen={() => setOpen(c)} />
                      ))}
                      {inCol.length === 0 && (
                        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
                          Nothing here yet
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>

            {unclear.length > 0 && <UnclearList items={unclear} />}
            {hidden > 0 && (
              <p className="mt-4 text-center text-xs text-slate-400">
                {hidden} {hidden === 1 ? "card" : "cards"} hidden as not a job application
              </p>
            )}
          </>
        )}
      </main>

      {open && (
        <Drawer
          card={open}
          onClose={() => setOpen(null)}
          onCorrect={(stage) => correct(open, stage)}
          onUndo={() => undo(open)}
        />
      )}
    </div>
  );
}

// ---------- Pieces ----------

function Logo({ light = false }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500 via-violet-500 to-rose-500 text-sm font-bold text-white shadow-sm">
        IT
      </div>
      <span className={"font-semibold tracking-tight " + (light ? "text-white" : "text-slate-900")}>Inbox Tracker</span>
    </div>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

// Illustration of the board on the sign-in page. Made-up companies, clearly an example.
const PREVIEW = [
  { title: "Applied", dot: "bg-sky-400", cards: [["Northwind", "2d ago"], ["Fabrikam", "5d ago"], ["Contoso", "Ghosted · 24d"]] },
  { title: "Interview", dot: "bg-amber-400", cards: [["Globex", "yesterday"], ["Initech", "3d ago"]] },
  { title: "Offer", dot: "bg-emerald-400", cards: [["Umbrella", "today"]] },
];

function BoardPreview() {
  return (
    <div className="relative">
      <div className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-sky-500/30 via-violet-500/30 to-rose-500/30 blur-2xl" />
      <div className="relative rotate-1 rounded-2xl border border-white/10 bg-slate-900/80 p-4 shadow-2xl backdrop-blur transition duration-500 hover:rotate-0">
        <div className="mb-4 grid grid-cols-3 gap-2">
          {[["24", "applications"], ["58%", "response rate"], ["6 days", "typical reply"]].map(([v, l]) => (
            <div key={l} className="rounded-lg bg-white/5 px-3 py-2">
              <p className="text-lg font-bold text-white">{v}</p>
              <p className="text-[11px] text-slate-400">{l}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {PREVIEW.map((col) => (
            <div key={col.title} className="rounded-xl bg-white/5 p-2">
              <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-300">
                <span className={"h-1.5 w-1.5 rounded-full " + col.dot} />
                {col.title}
              </p>
              <div className="space-y-1.5">
                {col.cards.map(([name, when]) => (
                  <div key={name} className="rounded-lg bg-white/10 px-2.5 py-2">
                    <p className="text-xs font-medium text-white">{name}</p>
                    <p className="text-[10px] text-slate-400">{when}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-center text-[10px] uppercase tracking-widest text-slate-500">Example board</p>
      </div>
    </div>
  );
}

function SignIn() {
  const points = [
    ["Sorts itself", "Applied, in review, interview, offer, rejected. Straight from your inbox."],
    ["Spots ghosting", "See who never replied, and how long companies really take."],
    ["Private by design", "Read-only. We keep sender, subject and date, never email bodies."],
  ];
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <div className="absolute -top-40 left-1/4 h-[480px] w-[720px] rounded-full bg-gradient-to-r from-sky-500/20 via-violet-500/20 to-rose-500/20 blur-3xl" />
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "28px 28px" }}
      />
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-16 px-6 py-16 lg:grid-cols-2">
        <div>
          <Logo light />
          <h1 className="mt-10 text-4xl font-bold leading-tight tracking-tight text-white sm:text-6xl">
            Your job hunt,
            <br />
            sorted{" "}
            <span className="bg-gradient-to-r from-sky-400 via-violet-400 to-rose-400 bg-clip-text text-transparent">
              automatically.
            </span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-slate-400">
            Connect Gmail once. Every application lands on one board, and moves on its own when companies reply.
          </p>
          <a
            href={API + "/auth/google"}
            className="mt-8 inline-flex items-center gap-3 rounded-xl bg-white px-5 py-3 font-medium text-slate-900 shadow-lg shadow-violet-500/20 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-500/30"
          >
            <GoogleG />
            Sign in with Google
          </a>
          <div className="mt-12 grid gap-5 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {points.map(([title, body]) => (
              <div key={title}>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-1 text-sm text-slate-400">{body}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden lg:block">
          <BoardPreview />
        </div>
      </div>
    </div>
  );
}

function ConnectGmail() {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-xl font-semibold">Connect your Gmail</h2>
      <p className="mt-2 text-slate-500">
        We look for application emails from the last 90 days and build your board. Read-only, and you can delete everything anytime.
      </p>
      <a href={API + "/auth/gmail"} className="mt-6 inline-block rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white hover:bg-slate-700">
        Connect Gmail
      </a>
    </div>
  );
}

function EmptyBoard({ onSync }: { onSync: () => void }) {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-xl font-semibold">Let's build your board</h2>
      <p className="mt-2 text-slate-500">One sync reads your last 90 days of application emails. Takes about a minute.</p>
      <button onClick={onSync} className="mt-6 rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white hover:bg-slate-700">
        Sync my inbox
      </button>
    </div>
  );
}

function SyncStatus({ job }: { job: Job }) {
  if (!job) return null;
  const text =
    job.status === "queued" ? "Starting..." :
    job.status === "running" ? "Reading your last 90 days..." :
    job.status === "done" ? job.found + " emails scanned" :
    "Sync failed";
  return (
    <span className={"hidden text-sm sm:inline " + (job.status === "failed" ? "text-rose-600" : "text-slate-500")} title={job.error ?? ""}>
      {text}
    </span>
  );
}

function Stats({ cards }: { cards: Card[] }) {
  const total = cards.length;
  const responded = cards.filter((c) => c.stage !== "applied").length;
  const interviews = cards.filter((c) => c.reachedInterview).length;
  const ghosted = cards.filter(isGhosted).length;
  const replyDays = cards
    .filter((c) => c.respondedAt)
    .map((c) => (new Date(c.respondedAt!).getTime() - new Date(c.appliedAt).getTime()) / DAY)
    .sort((a, b) => a - b);
  const median = replyDays.length ? Math.round(replyDays[Math.floor(replyDays.length / 2)]) : null;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  const tiles = [
    { label: "Applications", value: String(total), sub: "in the last 90 days" },
    { label: "Response rate", value: pct(responded) + "%", sub: responded + " companies got back to you" },
    { label: "Interviews", value: String(interviews), sub: pct(interviews) + "% of applications" },
    { label: "Typical reply time", value: median === null ? "–" : median + (median === 1 ? " day" : " days"), sub: "from applying to first reply" },
    { label: "Ghosted", value: String(ghosted), sub: "no reply in " + GHOST_DAYS + "+ days" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t.label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight">{t.value}</p>
          <p className="mt-1 text-xs text-slate-500">{t.sub}</p>
        </div>
      ))}
    </div>
  );
}

function Funnel({ cards }: { cards: Card[] }) {
  const total = cards.length || 1;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {STAGES.map((s) => {
          const n = cards.filter((c) => c.stage === s.key).length;
          return n ? (
            <div key={s.key} className={s.dot + " transition-all duration-700"} style={{ width: (n / total) * 100 + "%" }} title={s.title + ": " + n} />
          ) : null;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
        {STAGES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={"h-2 w-2 rounded-full " + s.dot} />
            {s.title} <b className="font-semibold text-slate-700">{cards.filter((c) => c.stage === s.key).length}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function CardTile({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const ghosted = isGhosted(card);
  return (
    <button
      onClick={onOpen}
      className="group w-full rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        <span className={"grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold " + avatarClass(card.company)}>
          {initials(card.company)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{card.company}</p>
          <p className="text-xs text-slate-500">
            {ago(card.updatedAt)} · {card.emails} {card.emails === 1 ? "email" : "emails"}
            {card.corrected && " · moved by you"}
          </p>
        </div>
      </div>
      {ghosted && (
        <span className="mt-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
          Ghosted · {daysSince(card.appliedAt)} days
        </span>
      )}
    </button>
  );
}

function Drawer({
  card, onClose, onCorrect, onUndo,
}: {
  card: Card;
  onClose: () => void;
  onCorrect: (stage: string) => void;
  onUndo: () => void;
}) {
  const s = stageOf(card.stage);
  return (
    <div className="fixed inset-0 z-30">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-slate-200 p-6">
          <span className={"grid h-12 w-12 shrink-0 place-items-center rounded-xl text-sm font-bold " + avatarClass(card.company)}>
            {initials(card.company)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{card.company}</h2>
            <span className={"mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 " + s.pill}>{s.title}</span>
            {card.corrected && <span className="ml-2 text-xs text-slate-400">moved by you</span>}
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            ✕
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-4 border-b border-slate-200 p-6 text-sm">
          <div>
            <dt className="text-slate-500">First seen</dt>
            <dd className="font-medium">{fullDate(card.appliedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Last update</dt>
            <dd className="font-medium">{fullDate(card.updatedAt)}</dd>
          </div>
        </dl>

        <div className="border-b border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-700">Wrong column?</h3>
          <p className="mt-1 text-xs text-slate-500">Move it, and it stays put until a newer email arrives.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {STAGES.map((st) => (
              <button
                key={st.key}
                onClick={() => onCorrect(st.key)}
                disabled={st.key === card.stage}
                className={
                  "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition " +
                  (st.key === card.stage ? st.pill + " cursor-default" : "bg-white text-slate-600 ring-slate-200 hover:ring-slate-400")
                }
              >
                <span className={"h-1.5 w-1.5 rounded-full " + st.dot} />
                {st.title}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-xs">
            <button onClick={() => onCorrect("hidden")} className="text-rose-600 hover:underline">
              Not a job application, hide it
            </button>
            {card.corrected && (
              <button onClick={onUndo} className="text-slate-500 hover:underline">
                Undo my change
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Timeline</h3>
          <ol className="relative space-y-5 border-l border-slate-200 pl-5">
            {[...card.timeline].reverse().map((t, i) => {
              const ts = stageOf(t.label);
              return (
                <li key={i} className="relative">
                  <span className={"absolute -left-[26px] top-1 h-3 w-3 rounded-full ring-4 ring-white " + ts.dot} />
                  <p className="text-sm text-slate-900">{t.subject}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {ts.title} · {fullDate(t.received_at)}
                    {t.via !== "rules" && (
                      <span className="ml-2 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 ring-1 ring-violet-200">
                        {t.via === "ai" ? "AI" : "from preview"}
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </aside>
    </div>
  );
}

function UnclearList({ items }: { items: Unclear[] }) {
  return (
    <details className="group mt-8 rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-50 text-sm font-bold text-amber-700">?</span>
        <div>
          <p className="font-medium">{items.length} emails need a closer look</p>
          <p className="text-sm text-slate-500">Neither the subject nor the preview says what happened. Check these in Gmail.</p>
        </div>
        <span className="ml-auto text-slate-400 transition group-open:rotate-180">▾</span>
      </summary>
      <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
        {items.map((e) => (
          <li key={e.gmail_id} className="flex gap-4 px-4 py-2.5">
            <span className="w-20 shrink-0 text-slate-400">{ago(e.received_at)}</span>
            <span className="w-56 shrink-0 truncate text-slate-500">{e.from_addr.replace(/<.*>/, "").trim()}</span>
            <span className="truncate">{e.subject}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}