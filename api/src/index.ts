import express from "express";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(3000, () => console.log("API on http://localhost:3000"));