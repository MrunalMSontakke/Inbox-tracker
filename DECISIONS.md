# Decisions Log

One entry per real decision. Include what I asked the AI, what it suggested, and what I overruled. This is the interview story.

Template:
### D#: Title (date)
- Decision:
- Why:
- Alternatives considered:
- AI involvement (prompts, pushback, what I changed):
- Outcome / what I'd redo:

---

### D1: Build an inbox-driven application tracker (2026-09-19)
- Decision: Build a Gmail-connected job application tracker as the one project.
- Why: I'm user #1 and have the problem daily. Ritik is user #2. Hits OAuth, background jobs, an AI pipeline, and a real UI.
- Alternatives considered: grounded resume tailor, something from daily life.
- AI involvement: Asked for project ideas from my own situation, picked one, asked for scope and cut list.
- Outcome:

### D2: Stack (2026-09-19)
- Decision: React + TypeScript + Vite + Tailwind, Node/TS API, Postgres, Postgres-backed job queue, Claude API.
- Why: Already fluent in it, so time goes to the product, not learning tools.
- Alternatives considered: a fancier stack. Rejected, stack matters less than shipping with users.
- AI involvement: Asked whether it was "good enough". 
- Outcome:

### D3: Metadata only, no email bodies stored (2026-09-19)
- Decision: Store sender, subject, date, label. Never bodies. Add delete-my-data button.
- Why: Reading inboxes is sensitive, and trust is what gets friends to connect.
- Alternatives considered: store full bodies for better reclassification.
- AI involvement: Raised as a design constraint during scoping.
- Outcome:

### D4: Rules first, LLM fallback (2026-09-19)
- Decision: Classify with rules where confident, call the LLM only for unclear emails.
- Why: Cheaper, faster, easier to test, and lets me measure accuracy per layer.
- Alternatives considered: LLM for everything.
- AI involvement:
- Outcome:

### D5: Gmail OAuth in testing mode (2026-09-19)
- Decision: Stay in Google's testing mode for the first 10 users, skip app verification.
- Why: Verification for restricted scopes is heavy and not needed for 10 users. Tradeoff: unverified-app warning and weekly re-login.
- Alternatives considered: full verification.
- AI involvement: Flagged the limits, I need to verify them in Google's docs.
- what the Audience page says about testing-mode limits. That covers the "verify the limits" task too
- Outcome:

### D6: Ask for Gmail access separately from sign-in (2026-09-19)
- Decision: Sign-in requests only email and profile. Gmail read access is requested when the user clicks "Connect Gmail".
- Why: Lower trust barrier at first contact. Users only grant the scary permission when they want the feature.
- AI involvement: Suggested by Claude while planning the auth flow.
- Outcome:

### D7: Gmail tokens in memory for now (2026-09-19)
- Decision: Keep Gmail tokens in a server-side Map for week 1. Move to Postgres with encryption in week 2.
- Why: Gets a working end-to-end slice today. A real database comes with the sync worker anyway.
- Alternatives considered: tokens in the session cookie (rejected, readable in the browser), a local file (rejected, secrets on disk).
- Tradeoff: every server restart forces a reconnect. Fine for dev, not for users.
- AI involvement: Claude suggested the in-memory bridge and flagged the restart problem.
- Outcome:
