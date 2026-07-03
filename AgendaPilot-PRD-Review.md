# AgendaPilot PRD (v0.9) — Critical Review & Recommendations

**Reviewer:** Claude Code · **Date:** 03 July 2026 · **Basis:** PRD v0.9 + the five source files in this folder (Neurology program `.xlsx`, Spine Olympiad & Neuro-Odyssey `.docx`, NR & NS faculty `.xlsx`)

> This is a pressure-test, not an endorsement. The concept is sound and well-thought-through — the two-step approval gate, propose-only AI, and lifecycle states are the right instincts. The problems below are almost all about the **gap between what the PRD assumes about the data and what the data actually is**, plus a timeline that doesn't close. I read the real files before writing this; the evidence is cited inline.

---

## 1. Verdict in one paragraph

The product design is coherent, but v0.9 is written as if the master data already exists in clean, structured form. It does not. Halls don't exist in the data at all; the two neurosurgery tracks are unscheduled topic dumps with **zero times and zero speakers**; the faculty directory is **~5× larger** than the PRD's estimate and its **phone/WhatsApp coverage is worst exactly for the international faculty who drive the flagship disruption scenario**; and speaker identity is inconsistent even within a single source file. On top of that, the rollout plan needs ~10 sequential weeks and the event is ~7 weeks away. My recommendation: **re-baseline to a smaller, data-first MVP** that de-risks event week, and treat the AI disruption agent as the second milestone, not the first.

---

## 2. What I verified against the real files (grounding)

| PRD claim | Reality in the files | Implication |
|---|---|---|
| "150–250" faculty/participants | **~850 faculty** on the lists: NR ≈153 (136 national + 17 international), NS ≈700+ (696 national + 29 international) | Directory & notification system must hold ~850, not 250. Scale of contact-management is ~5× the estimate. |
| Contact details (phone, email, **WhatsApp**) captured per person | **Email ≈99%** everywhere. **Phone: 79% NR-national, 18% NR-international, 64% NS-national, 24% NS-international.** No dedicated WhatsApp field — only a generic "Contact No / Mob No." | WhatsApp/SMS-first notification rests on data that is missing for ~1/3 of faculty and **~80% of international faculty**. Email is the only reliable channel today. |
| Neurology track "finalized" | True — fully timed, named speakers, Pre-conf + Days 1–3, incl. parallel workshops | Good. This track is genuinely importable. |
| Spine Olympiad & Neuro-Odyssey "tentative — no times or speakers yet" | Confirmed and understated: **~150+ topics each, zero times** (only "Morning 09:30 onwards / Afternoon 02:30 onwards"), **zero speaker assignments** | These aren't "tentative schedules," they're content backlogs. Building them is a large human effort, not an import. |
| High faculty overlap (Hrishikesh Kumar example) | Confirmed: Hrishikesh Kumar appears **4×** across Days 1–2 (Rapid-Fire moderator, Quiz Master prelims, Botulinum workshop moderator, Quiz Master final) | The commitment-graph requirement is real and load-bearing. |
| Journey B scenario (Dubey, Featured Lecture 3, 10:40–11:10, Day 2) | Confirmed in the program. **But** Divyanshu Dubey is international (Mayo, USA) and has **no phone number** in the file — email only | The showcase scenario depends on reaching exactly the person you can't phone or WhatsApp. |
| Halls / hall→track mapping | **No hall or room column exists anywhere in any file** | The conflict engine's hard constraint ("hall bookings fixed, no person in two places") has **no source data**. Halls must be built from scratch before the engine can run. |

---

## 3. Top risks, ranked (most severe first)

### R1 — The notification backbone assumes data you don't have, and fails worst where it matters most
The entire disruption value prop is "reach the affected people fast via WhatsApp/SMS." But WhatsApp numbers are **not a captured field**, phone coverage is 64–79% domestically and **18–24% internationally**, and the core use case (a delayed *international* speaker) targets precisely the cohort with the worst coverage. Email is ~99% complete but is the slowest channel for a time-critical "your talk moved in 40 minutes" alert.
**Recommend:** (a) Reframe email as the reliable primary channel and WhatsApp as best-effort. (b) Launch a WhatsApp-number + opt-in collection campaign *this week* via the personal-link mechanism — it's on the critical path and Meta template approval already takes weeks (your own Risk section). (c) The "≥95% acknowledge before their slot" KPI is unachievable for international faculty until numbers are collected; either collect them or scope the KPI to reachable faculty.

### R2 — Halls are a precondition, not an open question
The PRD treats halls as Open Question #6. But the conflict engine, Now/Next board, and every "no double-booking" guarantee depend on a hall model that has **zero source data**. Parallelism is also higher than the "3 tracks" framing: within Neurology alone, Sat/Sun run 4–5 concurrent streams (main track + NIBS + Pediatric Symposium + Neuro-Tech + TCD/NMUS + Neuro-Rehab), *plus* the two NS tracks Fri–Sun.
**Recommend:** Make "build hall inventory + assign every session to a hall" a **P0 deliverable**. The engine cannot be tested without it.

### R3 — Identity resolution is the hidden hard problem
Building "a person's *entire* commitment graph" (the heart of F3) requires linking each program speaker to a directory record and to all their roles. But names are inconsistent **even within one file**: `Atma Ram Bansal` (R009) vs `Atmaram Bansal` (R015/R027) in the program; `ABDUL MUNIM` vs `ABDUL MUNIEM` across the NR faculty sheets. Roles live in free-text cells with ~10 different labels (`Moderator`, `Grand Master`, `Session Expert`, `Quiz Master`, `Expert Panellist`, `Clinical Expert`, `Pathology Expert`, `Workshop Director`, `Introduction of Speaker`, plus plain `Speaker`), sometimes several people per label.
**Recommend:** Treat entity resolution as a first-class step with canonical person IDs, a fuzzy-match + human-confirm review screen, and a controlled role vocabulary. If this is silently wrong, F3's impact-set silently misses roles — which directly defeats the "zero silent conflicts" goal.

### R4 — The two NS tracks are the biggest schedule risk and they're not on the critical path
~150+ topics × ~700 candidate NS faculty, with no times and no assignments, must be turned into real schedules **inside the tool** before the disruption agent has anything to protect for those tracks. The DRAFT→SCHEDULED lifecycle acknowledges this, but the 4-week P0 budget doesn't account for the human labour of scheduling and staffing two entire tracks.
**Recommend:** Get a realistic date from the NS organizers for when times/speakers land (Open Q7). If it's late, decide explicitly whether NS tracks are in-scope for the AI agent at v1 or are "display-only" until finalized.

### R5 — The timeline doesn't close
Event: 20–23 Aug 2026. Today: 03 Jul 2026 → **~7 weeks out.** Rollout = P0(4w) + P1(3w) + P2(2w) + P3(1w) = **10 sequential weeks**, before WhatsApp Business verification + template approval ("days–weeks," per your Risk section) and the unknown website integration. The "single source of truth by 1 Aug" goal is **28 days away**.
**Recommend:** Re-baseline now. A defensible MVP (see §7) is: import + master schedule + dashboard + personal links + **manual** multi-channel notify, with the AI agent and full two-step automation as a fast-follow. Ship the thing that removes the Excel/Word chaos first; automation second.

### R6 — The metrics contradict the document and lack instrumentation
- "≤10 min P90 recovery" vs. the PRD's own worked example (Journey B, happy path, everyone on-site) that clocks **17 minutes**. Internal contradiction.
- Two-step approval with **10-min escalation timers per step** mathematically cannot fit inside a 10-min total SLA (10 + 10 > 10).
- "0 double-bookings" and "≥95% ack" have no baseline, no owner, and (for ack) no reachable population.
**Recommend:** Reconcile the target with the workflow (either raise the SLA to ~20 min or shrink the approval path for low-risk changes), set per-step timers well under the SLA, and name a metric owner with instrumentation before event week.

---

## 4. Feature-by-feature notes

- **F1 Ingestion.** Strong that human review is built in. Under-specified: time-string normalization (the files mix `–`/`-`, `Hrs`, double spaces, missing end-times), the free-text role parser, entity resolution (R3), and "All Faculty"/panel group-roles. The multiple-emails-in-one-cell and `` `+1... `` phone artifacts are real and need cleaning rules.
- **F2 Dashboard.** The layered check-in model (6 signals) is genuinely good design. Caveat: signals 2–5 (flight API, badge QR, hall-coordinator tap) depend on integrations/data you may not have by August; make sure the dashboard degrades gracefully to signals 1, 3, 6 only.
- **F3 AI agent.** The scoring dimensions omit **role criticality / replaceability** — a delayed "All Faculty" demo participant ≠ a delayed sole keynote. Add a criticality weight. The substitute-pool is the *only* substitute source but nominations haven't started (Q4) and may be thin for hyper-specialized talks (e.g., Dubey's autoimmune-antibody lecture). Promoting a co-moderator is a good fallback and should be preferred where it exists.
- **F4 Approval.** Sound. But the escalation-timer math (R6) and the emergency fast-path (Secretariat solo publish ≤15 min pre-session — exactly when errors are costly) need tight, reversible logging.
- **F5 Execution.** "Atomically … WhatsApp + email + SMS + website + ICS" is a distributed transaction that *will* partially fail. Design for idempotency, per-channel retry, and reconciliation — not atomicity.
- **F6 Publication.** Entirely blocked on an unknown website platform (Q1). The widget/iframe fallback is the right hedge, but "revised within seconds" may not survive a cached CMS. Set expectations to "within a minute."
- **F7 Safety/RBAC.** Propose-only + human gate + rollback is exactly right. Add a concrete data-protection stance: hundreds of medical-faculty PII records incl. international (India DPDP + GDPR exposure); "retention post-event" needs an actual date and deletion process.

---

## 5. The 12 open questions — my read on which are blocking

**Blocking (can't build the core without answers):**
1. **Q6 Halls** — precondition for the whole engine (R2). Blocking.
2. **Q3 Chairs per track** — the two-step approval can't route without them. Blocking for F4.
3. **Q7 NS data readiness** — determines whether NS tracks are in scope for v1 (R4). Blocking for scope.
4. **Q5 Locked slots** — hard constraints the solver needs (keynote Pramod Pal, memorial quiz final, inaugural). Blocking for F3 correctness.

**High-priority (block a channel or a KPI, workaround exists):**
5. **Q2 WhatsApp account/groups** + **Q9 SMS/languages** — gate the notification channel; email is the fallback (R1).
6. **Q1 Website platform** — gates F6; widget fallback exists.
7. **Q4 Backup pool** — gates substitution; other playbook options (swap/absorb) work meanwhile.

**Lower / v1.1:**
8. **Q8 Flight numbers** — only matters once the v1.1 flight API exists; but note it's inert without collecting numbers, and international faculty are the disruption-prone cohort.
9. **Q10 Hosting/load** — needed before go-live but not before build starts.

---

## 6. Internal inconsistencies to fix in v1.0

1. "Under 10 minutes" target vs. the 17-minute worked example in Journey B.
2. 10-min-per-step escalation timers inside a 10-min total SLA.
3. "150–250" faculty vs. ~850 in the actual lists.
4. "3+ parallel tracks" vs. 6–7 concurrent streams on Sat/Sun.
5. WhatsApp-first notifications vs. no WhatsApp field and sparse phone data.
6. "Atomically" publish across 5 channels vs. the reality of partial failure.

---

## 7. Recommended re-scope (a v1 that can actually ship in ~7 weeks)

**Milestone A — "Kill the Excel" (target ~1 Aug):**
Import Neurology track + faculty directory (with entity resolution + human review), hall model, master schedule with lifecycle states, organizer dashboard (Now/Next + conflict monitor using signals 1/3/6), personal agenda links, ICS + a read-only public JSON feed / widget. **Manual** notification (organizer clicks "notify affected" → email primary, WhatsApp where numbers exist).

**Milestone B — "The agent" (event-week ready):**
Disruption trigger forms, AI proposal + deterministic constraint checker, two-step approval, audit trail, targeted notification with ack tracking. This is where the AI agent earns its keep — but only once A has made the data trustworthy.

**Parallel, start immediately (long lead times):**
WhatsApp Business verification + templates; WhatsApp-number/opt-in collection; website-platform decision; Chairs + backup-pool nominations; NS scheduling decision.

**Defer to v1.1 (as the PRD already suggests):** flight API, digital signage, badge-QR integration.

---

## 8. Bottom line

The vision is right and the safety architecture (propose-only AI, dual human gates, versioned rollback) is exactly what a live-event tool needs. The risk is entirely in the **foundation**: missing halls, missing contact channels, unscheduled tracks, inconsistent identities, and a calendar that's tighter than the plan. Fix the data first, ship the "single source of truth" first, and let the AI agent stand on top of clean data — rather than asking it to reason over a schedule the humans haven't finished building.
