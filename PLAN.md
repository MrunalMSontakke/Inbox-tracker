# Application Tracker (working title)

Connect Gmail, and your job applications sort themselves into a board: Applied, Interview, Offer, Rejected. No manual entry.

## Users
- User #1: Mrunal (job hunting right now)
- User #2: Ritik (job hunting right now)
- Target: 10 real weekly users by end of week 4

## Scope (one user, one problem, one screen)
In:
- Google sign-in, Gmail connect
- Background sync of the last 90 days
- Classifier: rules first, LLM fallback for unclear emails
- Emails grouped into applications by company and role
- Board view, auto-updating
- "This is wrong" one-click correction
- "Delete all my data" button

Out (cut list, cut in this order when time runs short):
1. Reminders and follow-up nudges
2. Analytics
3. Outlook support
4. LLM fallback (rules only)
5. Email drafting

Never cut: the correction button, the delete-my-data button.

## Privacy rules
- Store metadata only: sender, subject, date, label. Never full email bodies.
- Send the LLM the minimum text needed.
- Users can delete everything in one click.

## Stack
React, TypeScript, Vite, Tailwind, Node/TS API, Postgres, Postgres-backed job queue, Claude API.

## 4 weeks
Week 1: public repo, Google sign-in, Gmail connect, deployed link, board with manual cards.
Week 2: sync worker, classifier v1, grouping into applications.
Week 3: auto-updating board, correction UI, tests, CI.
Week 4: onboard 10 users, sit with one silently, fix what breaks, hardest-bug writeup, README with screenshot.

## Week 1 checklist
- [ ] Public GitHub repo, first commit
- [ ] Google Cloud project, OAuth consent screen (testing mode), add Ritik as test user
- [ ] Verify current Google testing-mode limits in their docs
- [ ] Sign in with Google works locally
- [ ] Gmail connect works, read one message
- [ ] Postgres schema v0: users, applications, emails
- [ ] Board UI with manual cards
- [ ] Deploy, live link in README (ugly is fine)
- [ ] Commit small and often, spread over the week

## Receipts (what we get judged on)
- [ ] Live link anyone can open
- [ ] Public repo, commits spread over weeks
- [ ] README: what it does and who uses it in the first three lines, plus screenshot
- [ ] Hardest-bug writeup
- [ ] One number: weekly users
- [ ] One more number: classifier accuracy on ~200 hand-labelled emails
- [ ] Roadmap and feature backlog written down
