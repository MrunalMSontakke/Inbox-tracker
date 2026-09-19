import { useEffect, useState } from "react";

const API = import.meta.env.PROD ? "" : "http://localhost:3000";
type User = { id: string; email: string; name: string };
type Latest = { from: string; subject: string; date: string } | null;

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [latest, setLatest] = useState<Latest>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(API + "/api/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setUser(d?.user ?? null);
        setGmailConnected(Boolean(d?.gmailConnected));
      })
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await fetch(API + "/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }

  async function loadLatest() {
    setError("");
    const r = await fetch(API + "/api/gmail/latest", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      setError(d.error ?? "Something went wrong");
      return;
    }
    setLatest(d.message);
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

  const columns = ["Applied", "Interview", "Offer", "Rejected"];
  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">Inbox Tracker</h1>
        <div className="text-sm text-slate-600">
          {user.email}{" "}
          <button onClick={logout} className="ml-2 underline">
            Sign out
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-lg bg-white p-4 shadow">
        {!gmailConnected ? (
          <a href={API + "/auth/gmail"} className="inline-block rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">
            Connect Gmail
          </a>
        ) : (
          <div>
            <p className="text-sm text-green-700">Gmail connected</p>
            <button onClick={loadLatest} className="mt-2 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">
              Read my latest email
            </button>
            {latest && (
              <div className="mt-3 text-sm text-slate-700">
                <p><b>From:</b> {latest.from}</p>
                <p><b>Subject:</b> {latest.subject}</p>
                <p><b>Date:</b> {latest.date}</p>
              </div>
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
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
    </main>
  );
}