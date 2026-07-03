# AgendaPilot — Milestone-Based Implementation Plan

**Event:** WNS 2026, Thu 20 – Sun 23 Aug 2026 · **Plan date:** 03 Jul 2026 (Fri) · **Runway:** ~7 weeks
**Basis:** PRD v0.9 + the PRD review + the consolidated faculty directory (856 active faculty) already produced in `derived_data/`.

---

## 0. Framing: why this plan is re-baselined

The PRD's rollout (P0 4w + P1 3w + P2 2w + P3 1w = **10 sequential weeks**) does not fit a **7-week** runway once WhatsApp/Meta verification (weeks) and dry-run week are included. This plan closes the gap three ways:

1. **Parallelise the long-lead, organizer-owned items** (WhatsApp verification, contact collection, chair/pool nominations, NS scheduling, website platform) from Day 1 — they don't need code.
2. **Sequence data-first.** Nothing the AI agent does is trustworthy until the schedule, halls, and identities are clean. Build that floor first.
3. **Define a guaranteed floor vs. a target.** Ship "single source of truth + dashboard + email notifications" no matter what; the AI disruption agent sits on top of clean data as the target, not the foundation.

### Floor / Target / Stretch
| Tier | Scope | Guarantee |
|---|---|---|
| **Floor (must ship)** | M0–M2 + email notifications + website feed | Kills the Excel/Word chaos; dashboard + conflict monitor; disruptions handled manually with one-click email notify |
| **Target** | + M3 (AI agent, two-step approval, WhatsApp/SMS, ack tracking) | The full propose→approve→publish→notify loop |
| **Stretch / v1.1** | Flight-status API, digital signage, badge-QR check-in, full NS-track automation | Deferred per PRD; enabled only if data + time allow |

---

## 1. Milestone overview

| # | Milestone | Window | Goal / exit criteria |
|---|---|---|---|
| **M0** | Foundations + long-lead kickoff | Wk 1 · **Jul 3–10** | Repo, stack, schema deployed, auth works; **all organizer long-leads started** (WhatsApp verification submitted, halls received, chairs confirmed) |
| **M1** | Master schedule & directory ("Kill the Excel") | Wk 2–3 · **Jul 10–24** | Neurology track fully in-app; 856 faculty as canonical records; every session in a hall; personal links + collection form live |
| **M2** | Dashboard & constraint engine | Wk 4 · **Jul 24–31** | Now/Next + conflict monitor on real data; deterministic rules engine catches every double-booking → **"single source of truth by ~1 Aug" met** |
| **M3** | Disruption agent & two-step approval | Wk 5–6 · **Jul 31–Aug 12** | End-to-end disruption→propose→Chair→Secretariat→publish→notify→ack works in sandbox with mock disruptions |
| **M4** | Distribution hardening | Wk 5–6 · **Aug 5–13** (overlaps M3) | Website widget + JSON feed, ICS, PDF regen, rate-limited notifications, partial-failure reconciliation |
| **M5** | Dry run & go-live | Wk 7 · **Aug 13–19** | Full rehearsal signed off; load + offline + fallback tested; sandbox→prod cutover; runbooks + on-call ready |
| **⟶** | Event hypercare | **Aug 20–23** | War-room support; daily go/no-go |

---

## 2. Milestone detail

### M0 — Foundations + long-lead kickoff · Jul 3–10
**Build**
- Recommended stack (optimised for a 7-week ship, aligns with "AI proposes, rules verify, humans approve"):
  - **Frontend:** React / Next.js on Vercel — mobile-first approval cards, responsive.
  - **Backend + DB:** Supabase — Postgres, Row-Level Security for RBAC (Admin/Approver/Faculty/Viewer), Realtime for Now/Next, Edge Functions.
  - **AI layer:** Claude API (Opus 4.8) for import parsing, revision options + rationales, notification drafting — always via structured outputs; **a deterministic constraint checker (plain TypeScript/Python), never the LLM, is the gate.**
  - **Notifications:** Email (Resend/SES) = primary; WhatsApp (Meta/Twilio) + SMS (Twilio) = best-effort.
- Deliver: repo + CI/CD, sandbox & prod environments, data-model v1 (`Event→Track→Day→Hall→Session→Slot(role)→Person`, plus `Disruption, RevisionProposal, Approval, Notification(ack), PublicationTarget`), auth + roles, seed with the consolidated directory JSON.

**Kick off (organizer-owned, all start this week — see §3):** Meta WhatsApp Business verification + template drafts; contact-gap chase (`contact-gaps-to-chase.csv`); hall inventory; Chair + deputy names per track; backup-pool nomination request; website-platform decision.

**Exit:** schema live in sandbox, auth works, directory seeded, WhatsApp verification submitted, hall list + chairs received.

---

### M1 — Master schedule & directory · Jul 10–24  *(critical path, largest milestone)*
- **Import wizard** for `Conference Program Schedule.xlsx` (the finalized Neurology track) → normalized sessions/slots with AI-assisted parsing + a **human review screen** for the messy bits (time-string normalization, free-text role parsing, "All Faculty" group slots, panel rosters).
- **Entity resolution** — the hidden hard problem: link each program speaker → a canonical directory record → all their roles (the commitment graph). Fuzzy-match + human-confirm UI; canonical person IDs. Handles the known inconsistencies (`Atmaram Bansal` vs `Atma Ram Bansal`; cross-track faculty Paritosh Pandey / Sandeep Patil).
- **Hall model** — build the hall inventory (from M0 input) and assign **every** session to a hall; encode the parallel streams (Neurology alone runs 4–5 concurrent on Sat/Sun).
- **Session lifecycle** states `DRAFT/SCHEDULED/PUBLISHED/REVISED/CANCELLED` + version history/audit on every slot.
- **Personal agenda links** (read-only per-person schedule) + a **collection form** on that link to gather WhatsApp number + opt-in + flight details — this feeds the parallel data-collection campaign.

**Exit:** Neurology track is the single source of truth in-app; all 856 faculty have canonical records; every session sits in a hall; personal links + collection form are live and gathering numbers.

> **Risk flag:** entity resolution + hall modelling are the two things most likely to overrun. If M1 slips, it eats M3 — so protect it. Contingency: ship M1 with a lighter review UI and resolve edge cases manually.

---

### M2 — Dashboard & constraint engine · Jul 24–31
- **Deterministic constraint checker** (the rules engine) — validates the whole schedule and any change: no person in two places, breaks/halls fixed, keynote/inaugural locked, session duration preserved ±10 min. **Built before the AI agent so it can gate every proposal.**
- **Organizer dashboard:** Now/Next board, health widgets (confirmed vs pending, at-risk, unassigned NS slots, approval-queue count), speaker tracker (realistically signals 1/3/6: pre-event taps, self check-in, coordinator/secretariat override — 2/4/flight deferred), **conflict monitor** (double-bookings, over-runs, missing moderators), change + notification logs, filters, control-room mode.

**Exit:** dashboard live on real data; conflict engine flags every seeded double-booking. **"Single source of truth by ~1 Aug" milestone achieved.** This is the Floor.

---

### M3 — Disruption agent & two-step approval · Jul 31–Aug 12  *(the Target)*
- **Triggers:** self-report form ("I'm delayed / can't attend" → new ETA or cancel + reason) + organizer manual flag.
- **AI agent:** builds impact set → generates 1–3 options via the playbook (swap-in-session → swap-across-day → pool substitute → compress/absorb) → **every option validated by the M2 constraint checker before display** → scored (disruption radius, audience impact, notification load, **+ role criticality/replaceability** — an addition to the PRD) → plain-language rationale + red/amber/green diff. Drafts (does not send) notifications.
- **Backup pool** seeded from the NS `TOPICS & ACC` tags + chair nominations; hard-filtered by pool membership + on-site status.
- **Two-step approval:** Chair mobile card (Approve / Approve-with-edits / Reject-with-note) → Secretariat sign-off (Confirm & Publish / Send back); escalation timers **set well under the SLA** (see PRD fix); emergency fast-path logged as exception; full signed/timestamped audit trail.
- **Execution & notification:** atomic-ish write of new version → targeted notify (email primary, WhatsApp/SMS where numbers exist) with Acknowledge buttons → ack tracking → unacked criticals surfaced for a phone call.

**Exit:** full loop runs in sandbox against mock disruptions incl. the Journey B (Dubey) scenario; audit trail complete; rollback works.

---

### M4 — Distribution hardening · Aug 5–13 (overlaps M3)
- Website **embeddable widget + public JSON feed** (platform-agnostic fallback; deep integration only if the CMS is confirmed), "Last updated" stamp + change badges.
- **ICS** auto-updating per-person feeds; **PDF** day-program regeneration for the registration desk.
- WhatsApp group summary posts (faculty / delegates).
- Reliability: notification **rate-limiting**, idempotency + per-channel retry + reconciliation (replaces "atomic"), sandbox/test mode.

**Exit:** a published revision propagates to website + ICS + PDF within a minute; partial channel failures reconcile.

---

### M5 — Dry run & go-live · Aug 13–19
- Full rehearsal with mock disruptions across all tracks; load-test the public feed at expected event-day concurrency; **offline/local-first** dashboard cache test on flaky Wi-Fi; print fallback; manual-override paths for every integration.
- Sandbox→prod cutover; secrets/PII encryption verified; retention policy set; **runbooks + on-call rota**; final KPI instrumentation.

**Exit:** signed-off dry run; **go/no-go** decision.

---

## 3. Parallel workstreams (organizer-owned — start Jul 3, block the build if late)

| Workstream | Why it's long-lead | Needed by | Owner |
|---|---|---|---|
| **Meta WhatsApp Business verification + template approval** | Meta approval takes days–weeks | Before M3 notify (Aug 7) | Secretariat |
| **Contact-gap chase + WhatsApp/opt-in collection** | 298 have no phone; 24% intl reachable; email-driven campaign | Rolling; targets by dry run | Secretariat |
| **Hall inventory + hall→session mapping** | No hall data exists; precondition for conflict engine | Start of M1 (Jul 10) | Organizer |
| **Chairs + deputies per track** | Two-step approval routing can't be built without them | M3 (Jul 31) | Organizer |
| **Backup-pool nominations (per topic area)** | Only legal substitute source; nominees must confirm | M3 (Jul 31); PRD deadline 1 Aug | Chairs |
| **Locked-slot list** (keynote Pal, memorial quiz final, inaugural, sponsored) | Hard constraints for the solver | M2 (Jul 24) | Organizer |
| **NS track scheduling (Spine Olympiad, Neuro-Odyssey)** | ~150+ topics each, zero times/speakers today | Decide scope by M1; content by Aug 7 or NS = display-only | NS leads |
| **Website platform + dev contact** | Determines embed vs. deep integration | M4 (Aug 5) | Organizer |
| **Hosting + expected event-day load** | Sizing the public feed | M5 (Aug 13) | Organizer |

---

## 4. Dependencies & go/no-go gates

- **M1 depends on** hall inventory (M0) + the consolidated directory (done).
- **M2 depends on** M1 (clean schedule) + locked-slot list.
- **M3 depends on** M2 (constraint checker) + chairs + backup pool + WhatsApp approval (for the WhatsApp channel only; email works without it).
- **Gate G1 (Aug 1):** Is the Floor live (M0–M2 + email notify)? If no → freeze scope, drop M3 to "manual-assisted" (agent suggests, human does the edits by hand).
- **Gate G2 (Aug 13):** Is M3 stable in sandbox? If no → ship Floor to the event; run disruptions via dashboard + email; keep M3 in sandbox for post-event.
- **Gate G3 (Aug 19):** Dry-run sign-off → go/no-go for each channel (website, WhatsApp, SMS, ICS) independently.

---

## 5. Contingency / de-scope ladder (if slipping, cut top-down)

1. Digital signage, badge-QR, flight API → already v1.1 (out).
2. NS tracks → **display-only** (schedule shown, not agent-managed) until data lands.
3. WhatsApp channel → defer; **email + dashboard-driven phone calls** carry the event.
4. AI agent (M3) → **manual-assisted** mode: agent proposes options, humans apply edits through the M1 editor; two-step approval still enforced.
5. Absolute floor that must survive all cuts: **M1 + M2 + email notifications + website feed** — i.e., one always-correct agenda, a conflict-aware dashboard, and a way to tell affected people.

---

## 6. Roles

- **Dev (build):** M0–M5 engineering.
- **Secretariat/Admin:** contact chase, WhatsApp setup, data review sign-off, event-day war room.
- **Scientific Chairs (+ deputies):** approvals, backup-pool nominations, locked-slot confirmation.
- **NS leads:** deliver Spine/Neuro-Odyssey times + speakers, or accept display-only.
- **AgendaPilot AI:** propose-only — parsing, options, drafts; never publishes.

---

## 7. Honest risk summary

The Floor (M0–M2) is achievable in the runway and delivers the single-source-of-truth win by ~1 Aug. The Target (M3) is achievable **only if** M1 doesn't overrun and the organizer long-leads land on time — chairs, backup pool, WhatsApp approval, and hall data are the four external dependencies most likely to move the date. Treat M3 as the goal but hold the Floor as the commitment.
