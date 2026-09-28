# RIO-NFR-012 — Usability Test Script

**Purpose:** Close AC 1 and AC 2 of RIO-NFR-012 — a real person from each role completes their core task set with minimal training, covering the Sprint 2 flows (classification/scoring review, report generation, decision logging), observed and documented.

**Who runs this:** Anyone (Ayush, QA, or you) can facilitate. It takes ~45–60 minutes total across 3 short sessions (15–20 min each).

**Ground rules for the facilitator:**
- Do not explain the UI beforehand. Hand over the task and watch.
- Do not help unless the participant is fully stuck for 60+ seconds — if you do help, write that down as a finding.
- Write down anything the participant says out loud ("where do I click now," "I expected this to...") — those quotes are the most useful part of the session.
- Time each task loosely; the number matters less than whether they finished without help.

---

## Participants needed (one per role, ideally not a developer)

| Role | Use for | Suggested account |
|---|---|---|
| Research Officer / Reviewer | Classification/scoring review task | A Research Officer or Human Reviewer who hasn't used this specific build before |
| Data Analyst | Report generation + Decision logging tasks | A Data Analyst who hasn't used the Reports/Decisions screens in this build |
| NGO Admin / Management | A lighter oversight-pass task | An NGO Admin reviewing outcomes, not doing the data-entry tasks |

If only one or two people are available, run the sessions sequentially with the same person switching accounts — note that in the writeup (it's a real limitation, not a fabricated multi-person session).

---

## Task 1 — Classification/Scoring Review (Research Officer / Reviewer)

**Hand the participant this and nothing else:**

> "Log in with the account I gave you. Find a Need that still needs its AI classification reviewed, and decide whether to approve or change what the AI suggested. Then open that Need's Priority Score and tell me, out loud, what you think it means."

**Watch for:**
- Do they find the Need needing review without being told where to look?
- Do they understand the confidence score / reasoning shown with the AI suggestion?
- Do they know the difference between Approve, Modify, and Reject?
- When they open the Priority Score tab, can they explain the 9-factor breakdown in their own words, or do they just read the final number?

**Success = they complete both halves without asking "where do I click."**

---

## Task 2 — Report Generation (Data Analyst)

**Hand the participant this:**

> "Generate a report for [study name] and open it once it's ready."

**Watch for:**
- Do they find the Reports screen and the Generate button without help?
- Once the dialog opens, do they understand which fields are required before Generate is enabled?
- Can they find the report they just generated in the list?
- Can they actually open and read it (not just see it in the list)?

**Success = a report is generated and opened without the facilitator naming a button or menu.**

---

## Task 3 — Decision Logging (Data Analyst)

**Hand the participant this:**

> "Pick a Need with a priority score and log a decision against it. Then move that decision from Open to In Progress to Completed."

**Watch for:**
- Do they understand why the Decisions tab might be blocked if the score isn't approved yet (if they hit that case)?
- Do they find Gap Type, Decision Type, Responsible Party fields without confusion?
- Can they walk the status through all three stages, and do they know where to check the history afterward?

**Success = a decision is logged and its status walked to Completed without help.**

---

## Task 4 (lighter pass) — Oversight review (NGO Admin / Management)

**Hand the participant this:**

> "Without me telling you anything, find out how many Needs currently have an approved priority score, and whether any decisions are still open."

**Watch for:**
- Do they know where to look for a cross-need summary view?
- Do they correctly distinguish "approved score" from "any score at all"?

**Success = they answer both questions correctly using only the UI.**

---

## Preliminary pass already run (2026-09-01) — NOT a substitute for AC 1

**Important scope note:** the walkthrough below was run by Claude, acting as a proxy tester against the live Zamina demo environment (`saraah@yopmail.com`/`amiraa@yopmail.com`/`fasill@yopmail.com`, all `Passw0rd!`). This does **not** satisfy AC 1 — an AI already familiar with this UI's structure cannot experience the "minimal training" condition a real person can, and cannot report the subjective confusion a human would feel. It's included here because it surfaced two concrete, real defects worth fixing before the actual human session, so participants don't hit an already-known dead end. Real representative-user sessions (per the template below) are still required to close AC 1 and AC 2.

### Task 1 — Classification/Scoring Review

Logged in as Amira (Human Reviewer). Found a Need ("School Infrastructure -01") with status "AI Classification Failed" via Studies → study → Needs list — the "Reviewer Alerts" nav item, despite sounding like the right entry point, actually only lists pending **report** approvals, not needs pending classification review, so it's a plausible wrong turn first.

**Finding 1 (real defect):** on the Need detail page, the "AI Classification Failed" badge shows at the top, but the actual reason ("Unable to classify this need — Service Unavailable Exception") and the only two recovery actions ("Retry AI Classification" / "Classify Domain & Sub-domain Manually") are ~1,365px down the page — roughly a page and a half of scrolling past Need Statement, Governorates, Centers, Village, Affected Population, Evidence, and Urgency sections — with no visual cue at the top that there's an actionable section below. A real user would very plausibly not find it.

**Finding 2 (real defect, more serious):** clicking "Retry AI Classification" as the Human Reviewer produced **"Insufficient permission for this action"** — the button is fully enabled and clickable for this role, but the role can't actually use it. No guidance appeared telling the reviewer who *can* retry it, or steering them toward the "Classify Domain & Sub-domain Manually" button sitting right next to it. This is exactly the kind of dead-end a real reviewer would hit and then not know how to proceed.

The Priority Score half of the task (open the score, explain the breakdown) was not reached given the above blocker — genuinely worth having a real Reviewer attempt on a Need that already has a normal pending classification, not a failed one, to test that half cleanly.

### Task 2 — Report Generation

Logged in as Fasil (Data Analyst). The two previously-shipped fixes are real and working well: the Generate dialog clearly states "Still needed: Report type" (then updates to name the next missing field as each one is filled), and the button shows "Generating…" while in flight — no confusion here.

**One piece of real friction (not clearly a defect):** picking the first study in the list produced "This study has no scored data yet. Run scoring before generating this report." — a clear, well-written error, but it meant a "just pick something" cold-user instinct led to a dead end on the first try. Worth deciding whether studies with no scored data should be filtered out of the picker entirely, or left with this (already good) inline explanation.

Successfully generated and located a Village Report end to end.

### Task 3 — Decision Logging

Logged in as Fasil. This task had **no friction at all** — logged a new decision, walked it Open → In Progress → Completed via a plain dropdown, and "Show history" revealed exact timestamps for every transition. Genuinely well-designed; nothing to report here.

### Finding 3 (real defect, found incidentally on the Priority Dashboard)

The Priority Dashboard's Need list shows the **Study's** title in the "Need" column, not the individual Need's own title. Two separate Needs under the same study ("Riyadh Learning Needs Assessment") both displayed as literally the identical string, with no way to tell them apart — confirmed by opening one, whose real title turned out to be "Overcrowded Classrooms Limiting Enrollment," never shown anywhere on the list page. A Data Analyst scanning this list for "which Need is X" cannot do so today.

---

## Informal real-user usage (reported, not formally recorded)

Per the client, roughly 5-6 real people across multiple roles have already used the live application directly (not a proxy walkthrough). **This is not a substitute for AC 1**, the same way the 2026-09-01 proxy pass above isn't: no structured record exists of which roles were covered, which of the four tasks above they performed, whether they completed them without help, or what confusion points came up. Recorded here as an honest data point — real usage has happened and nothing catastrophic was reported back — not as closure of this requirement. To actually close AC 1, capture at minimum: participant role, which task(s) they did, completion without help (yes/no), and any confusion points, using the Observer notes template below — retroactively from memory if the sessions already happened, or on the next real session.

---

## Developer end-to-end functional testing (28 Sep 2026) — separate from usability, not a substitute for it

Two developers on this project ran full end-to-end functional testing across every role in the system, confirming the features themselves work correctly end to end. **This is real, valuable testing — but it answers a different question than AC 1, and does not count toward closing it.** AC 1 exists specifically to catch what a person unfamiliar with this build's structure gets stuck on — a developer who built or has deeply tested the system already knows where everything is, so a developer's smooth run through every role cannot surface the kind of first-time confusion a real Research Officer or Reviewer would hit. This is the identical reason the 2026-09-01 proxy walkthrough above (run by an AI, not a person) is explicitly disclaimed as not satisfying AC 1: familiarity with the build disqualifies a tester from this specific requirement, regardless of whether that familiarity comes from being an AI, a developer, or anyone else who already knows the UI. Recorded here as confirmation the underlying features work — genuinely useful — not as usability evidence.

**Client-confirmed, 28 Sep 2026:** in addition to the two developers above, the product team has also used the system extensively across all roles as part of ongoing testing, with nothing observed broken. Recorded here for the same reason as the developer testing above — it is real, valuable evidence the system works, and it is being deliberately kept in this "does not close AC 1" section rather than marked as satisfying it, for the identical reason: the product team, like the developers, already knows this build's structure, so their smooth usage cannot stand in for a first-time user's experience. **This status is Substantial, not Done** — a real, heavily-used, working system, with the specific first-time-user requirement (AC 1) still open.

---

## Observer notes template (fill in during each session)

```
Participant: [role, one-line background — e.g. "Research Officer, 2 years, first time on this build"]
Task: [1/2/3/4]
Completed without help? [yes / no / needed a hint at minute X]
Time taken: [rough, minutes]
Confusion points observed (quote if possible):
  -
  -
Facilitator intervened? [no / yes — describe what and when]
```

---

## Triage table (fill in after all sessions)

| # | Issue found | Task | Severity | Fixed / Deferred | Reason (if deferred) |
|---|---|---|---|---|---|
| 1 | A failed classification's reason and recovery actions are ~1,365px down the Need page, past 7 other sections, with no cue that they exist | Task 1 | Medium | Fixed | 28 Sep 2026 — added a "AI classification failed — see details" button next to the status badge at the top of the Need page (`studies/[id]/needs/[needId]/page.tsx`) that jumps straight to the AI Classification section (given `id="ai-classification"`). |
| 2 | "Retry AI Classification" is enabled for a role (Human Reviewer) that gets "Insufficient permission" on click, with no pointer to the action that *does* work | Task 1 | High | Fixed | 28 Sep 2026 — both Retry and Classify Manually now check `aiReview:write` (`usePermission("aiReview", "write")` in `ai-classification-section.tsx`) before rendering; a role without it (Human Reviewer only holds `aiReview:approve`, confirmed in `role-matrix.ts`) sees an explanatory message ("Only the Research Officer who owns this study can retry or manually classify this need") instead of a button that would 403. |
| 3 | Priority Dashboard's Need list shows the parent Study's title instead of the Need's own title, so two Needs under one study are visually identical | Priority Dashboard (incidental) | High | Fixed (already, prior to this session) | Traced the live code path (`priority-v2.service.ts`'s `listPage`, called by `GET /priority-scores`) end to end on 28 Sep 2026: `needTitle: need.title` and `studyTitle: studyTitleById.get(...)` are two separately-sourced fields with no join/aliasing collision; the frontend list column already renders `entry.needTitle`. This looks like it was fixed by other engineering work between the 2026-09-01 proxy pass and now — re-verify with a real Need pair on the next real session to close this out for certain. |

Every row must end in either **Fixed** (say what changed) or **Deferred** (say why — "low impact, Sprint 3" is fine; a blank reason is not). That's what AC 3 requires and what the six fixes already shipped satisfy — add any new findings from this session to the same table so it stays the single source of truth.

---

## Already-fixed issues (carried forward from the prior engineering pass — no need to re-test these, just cite them)

| Issue | Fixed |
|---|---|
| Priority Dashboard didn't distinguish "filtered to nothing" from "nothing scored yet" | Yes — message now names the filter and says "clear them" |
| Priority Dashboard loading state was a static grey bar, read as broken | Yes — now an animated skeleton |
| Generate Report button was disabled with no explanation | Yes — now names which fields are still needed |
| Reports list didn't distinguish "filtered to nothing" from "nothing generated" | Yes |
| Decision log showed nothing while loading, indistinguishable from "no decisions" | Yes — now shows a loading state |

---

## Write-up

Once sessions are done, turn this file's filled-in Observer Notes + Triage Table into the final evidence for AC 1/AC 2/AC 3 — date it, name the participants (role only is fine, doesn't need to be their real name if that's a concern), and that becomes the closing artifact for RIO-NFR-012.
