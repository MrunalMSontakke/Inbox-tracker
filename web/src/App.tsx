export default function App() {
  const columns = ["Applied", "Interview", "Offer", "Rejected"];

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <h1 className="text-3xl font-bold text-slate-900">Inbox Tracker</h1>
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