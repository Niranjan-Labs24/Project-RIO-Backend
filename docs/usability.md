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
| 1 | A failed classification's reason and recovery actions are ~1,365px down the Need page, past 7 other sections, with no cue that they exist | Task 1 | Medium | Deferred | Found via proxy pass 2026-09-01, not yet actioned — needs a fix (surface the AI Classification status/actions near the top for a failed state) before the real session runs |
| 2 | "Retry AI Classification" is enabled for a role (Human Reviewer) that gets "Insufficient permission" on click, with no pointer to the action that *does* work | Task 1 | High | Deferred | Found via proxy pass 2026-09-01 — should be fixed first: either disable/hide the button for roles that can't use it, or the error should point at "Classify Domain & Sub-domain Manually" |
| 3 | Priority Dashboard's Need list shows the parent Study's title instead of the Need's own title, so two Needs under one study are visually identical | Priority Dashboard (incidental) | High | Deferred | Found via proxy pass 2026-09-01 — a real data-display bug, not a training issue; recommend fixing before the real session so participants aren't blocked identifying which row is which |

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
