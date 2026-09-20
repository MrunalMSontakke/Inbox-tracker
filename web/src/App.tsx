import { useEffect, useState } from "react";

const API = import.meta.env.PROD ? "" : "http://localhost:3000";

type User = { id: string; email: string; name: string };
type Job = {
  status: "queued" | "running" | "done" | "failed";
  found: number;
  error: string | null;
} | null;
type Email = {
  gmail_id: string;
  from_addr: string;
  subject: string;
  received_at: string;
  label: string | null;
};

const call = (path: string, init?: RequestInit) =>
  fetch(API + path, { credentials: "include", ...init });

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<Job>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);

  const busy = job?.status === "queued" || job?.status === "running";

  async function loadJob() {
    const r = await call("/api/sync/status");
    if (r.ok) setJob((await r.json()).job);
  }

  async function loadEmails() {
    const r = await call("/api/emails");
    if (!r.ok) return;
    const d = await r.json();
    setEmails(d.emails);
    setTotal(d.total);
  }

  useEffect(() => {
    call("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setUser(d?.user ?? null);
        setGmailConnected(Boolean(d?.gmailConnected));
        if (d?.user) {
          loadJob();
          loadEmails();
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // While a sync is running, check on it every 2 seconds
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadJob, 2000);
    return () => clearInterval(t);
  }, [busy]);

  // When it finishes, load the results
  useEffect(() => {
    if (job?.status === "done") loadEmails();
  }, [job?.status]);

  async function startSync() {
    await call("/api/sync", { method: "POST" });
    setJob({ status: "queued", found: 0, error: null });
  }

  async function logout() {
    await call("/auth/logout", { method: "POST" });
    setUser(null);
  }

  if (loading) return null;

  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-slate-900">Inbox Tracker</h1>
          <p className="mt-2 text-slate-600">Your job applications, sorted automatically.</p>
          <a href={API + "/auth/google"} className="mt-6 inline-block rounded-lg bg-slate-900 px-5 py-3 font-medium text-white">
            Sign in with Google
          </a>
        </div>
      </main>
    );
  }

  const statusText =
    job?.status === "queued" ? "Waiting to start..." :
    job?.status === "running" ? "Syncing your last 90 days..." :
    job?.status === "done" ? "Done. " + job.found + " job-related emails matched." :
    job?.status === "failed" ? "Sync failed: " + job.error :
    "";

  const columns = ["Applied", "Interview", "Offer", "Rejected"];

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">Inbox Tracker</h1>
        <div className="text-sm text-slate-600">
          {user.email}{" "}
          <button onClick={logout} className="ml-2 underline">Sign out</button>
        </div>
      </div>

      <div className="mt-6 rounded-lg bg-white p-4 shadow">
        {!gmailConnected ? (
          <a href={API + "/auth/gmail"} className="inline-block rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">
            Connect Gmail
          </a>
        ) : (
          <div className="flex items-center gap-4">
            <button
              onClick={startSync}
              disabled={busy}
              className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? "Syncing..." : "Sync my inbox"}
            </button>
            <p className={"text-sm " + (job?.status === "failed" ? "text-red-600" : "text-slate-600")}>
              {statusText}
            </p>
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-4 gap-4">
        {columns.map((name) => (
          <section key={name} className="rounded-lg bg-white p-4 shadow">
            <h2 className="font-semibold text-slate-700">{name}</h2>
          </section>
        ))}
      </div>

      {total > 0 && (
        <div className="mt-6 rounded-lg bg-white p-4 shadow">
          <h2 className="font-semibold text-slate-700">
            {total} emails found (latest 50, not sorted yet)
          </h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {emails.map((e) => (
              <li key={e.gmail_id} className="flex gap-4 py-2">
                <span className="w-24 shrink-0 text-slate-400">
                  {new Date(e.received_at).toLocaleDateString()}
                </span>
                <span className="w-64 shrink-0 truncate text-slate-600">{e.from_addr}</span>
                <span className="truncate text-slate-900">{e.subject}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}