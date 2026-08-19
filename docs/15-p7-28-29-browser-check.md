# Browser check — P7-28 (task page) and P7-29 (form identifiers, public URL)

Everything below needs a signed-in session, which is why none of it ran in CI.
What *has* run: `check:metadata`, `tsc --noEmit`, `eslint` (0 errors), 371 unit
tests, and a production `next build`. So this is looking for things a type
system cannot see — wrong figures, a button that says the wrong word, a redirect
that asks a client to log in.

Tick as you go. Anything that fails, note the **step number** — each one below
names what it is really testing, so a failure points at a specific decision
rather than a screen.

---

## 0 · Setup

```bash
PORT=3177 npm run dev
```

⚠️ **Not port 3000.** That is the HFSE SIS app on this machine and its login
page also says "Welcome back", so a smoke test there passes against the wrong
application entirely.

Sign in at `http://localhost:3177/login`. Most of this is done as
**`test.tl.vizbytes@example.com`** — a Team Leader who is frequently also the QA
reviewer, which is the seat that sees the most of what changed. Two steps need a
**member** (`test.member1.vizbytes@example.com`) and one needs a private window
with no session at all.

---

## Part A · P7-28, the task page

### A1 · A client task — the five-stage rail

Open a task that came from a client request (`/tasks`, the **Client** chip, or
open the Client Requests folder in the sidebar).

- [ ] **1.** The **Status** row is the **first** thing inside "The work", above
      the Resolution box — not at the bottom of the card.
- [ ] **2.** Beside the dropdown there is one primary button reading **▶ Send
      for QA** (on an Ongoing task). The word matters: not "For QA".
- [ ] **3.** Open the Status dropdown. The button's move is **in that list**.
      *Testing that the button is derived from the same source as the menu — if
      they ever disagree, the button is offering something the server refuses.*
- [ ] **4.** With the Resolution box **empty**, the button is disabled and a
      **warning-toned** line with a triangle says "Fill in the resolution below
      to send this for QA." *It used to be muted grey and read as a form hint
      rather than an answer to "why can I not press that".*
- [ ] **5.** Type a resolution but **do not save**. The line changes to "The
      resolution has unsaved changes — Save before moving this." *The database
      checks the SAVED value; this is the gap that used to leave the move
      mysteriously unavailable.*
- [ ] **6.** Save, then press the button. It moves, a toast appears, the trail
      gains an entry.
- [ ] **7.** In the **History** card, above "EVERY MOVE", there is a rail of
      **five** stages: Requested · Gate 1 · Work in progress · Gate 2 · Gate 3.
- [ ] **8.** The first two carry a tick, a date and a **name** — the requester
      on step 1, the team leader who approved on step 2. *Gate 1 is
      `reviewed_by`/`reviewed_at`, added to a query the page was already making.*
- [ ] **9.** The current stage is bold with a filled dot, and its second line
      names the **actual status** — e.g. "Ongoing · PIC …".
- [ ] **10.** Squint or screenshot in greyscale. The four marker shapes (tick /
      filled dot / empty ring / alert) still tell the stages apart.

### A2 · Progress, time and subtasks

Same task.

- [ ] **11.** There is a **Subtasks** card between "The work" and its output
      files. On a task with none it says so and still offers **+**.
- [ ] **12.** Add one via **+**. It appears in the list; the header gains a
      progress bar and a count.
- [ ] **13.** Open `/tasks` and find the same task's row. **The bar and the
      count match.** *Both call `SubtaskProgress`; if they disagree, one of them
      is deriving progress from what the page happened to load.*
- [ ] **14.** ⚠️ On a task with **logged time**, "The work" shows a line like
      `1h 30m logged of 6h estimated`. Compare it to the **Time tracked** column
      on that task's `/tasks` row — **they must be identical**.
- [ ] **15.** ⚠️ Now sign in as **`test.member1.vizbytes@example.com`**, someone
      who logged only *part* of that time, and open the same task. **The total
      is the same number.** *This is the whole reason the figure comes from the
      `vizserve_pms_task_time_tracked` RPC. The timesheet entries policy is
      owner-or-their-lead, so a direct sum shows each viewer only their own
      hours and calls it the task total — two people reading two different
      numbers off the same screen, which nobody reports as a bug.*
- [ ] **16.** On a task with **nothing logged**, the time line is **absent** —
      not `0h of 6h`. Same for the progress bar with no subtasks.

### A3 · An internal task — four stages, no client gate

Open a task with no client request behind it (the **Internal** chip on `/tasks`).

- [ ] **17.** The rail has **four** stages: Created · Work in progress ·
      Internal QA · Done. ⚠️ **There is no Gate 3 row at all** — not a greyed
      one. *A greyed client gate on internal work would report closed work as
      unfinished, for ever.*
- [ ] **18.** At Ongoing there are **two** buttons: **▶ Send for QA** and
      **✓ Complete**. *Free movement makes both legal and common; promoting only
      one would hide whichever you wanted.*
- [ ] **19.** The dropdown still lists every stage (seven-ish entries). *The
      button is a shortcut, not a replacement — that is why the menu stayed.*
- [ ] **20.** Move it to QA in progress. The button becomes **▶ Pass QA and
      close**, and **✓ Complete disappears** — same move, one button.

### A4 · A personal task — three stages, no QA

Open one of your own personal tasks (`/tasks`, the **Personal** chip).

- [ ] **21.** The rail has **three** stages: Made it for yourself · Work in
      progress · Done. No QA stage, no client gate.
- [ ] **22.** At Ongoing the button reads **▶ Mark it done** — *not* "Send for
      QA". *P7-02: you made it, you close it.*
- [ ] **23.** The dropdown **still offers For QA**. *It is reachable, just not
      the expected route — the rail must not invent a stage the category does
      not own, and the button must not pretend one is missing.*

### A5 · The states that should offer nothing

- [ ] **24.** A task sitting at **For client approval**: no primary button, and
      the rail's Gate 3 row reads "Sent — waiting on the client". *Even as an
      admin. The dropdown can still force it — an admin overriding a client's
      answer is legal — but a one-click "Client approved" is not something
      anyone should be able to press by reflex.*
- [ ] **25.** A **completed** task: no primary button. *Internal work can be
      reopened and that move stays in the dropdown, but "reopen" is not what a
      button on a closed task should invite.*
- [ ] **26.** A task where you are **neither PIC nor QA nor the lead**: "Nothing
      for you to do here right now — it is with somebody else."
- [ ] **27.** A task at **Waiting for info**: the button reads **▶ Resume
      work**. *The enum declares that status between Ongoing and For QA, so a
      naive "next in order" reads resuming as going backwards — and would
      headline "Waiting for info" on every healthy task.*

---

## Part B · P7-29, form identifiers and the public URL

### B1 · The derivation, on create

`/forms/new`, as a Team Leader.

- [ ] **28.** Type a **Name** of `Collateral Request` and touch nothing else.
      The slug hint updates live to **`Public at /request/collateral-request —
      from the name. Type your own to change it.`**
- [ ] **29.** The **Reference prefix** hint reads **`e.g. COL-2026-0142, from
      the name`**, and both inputs are still **empty** with the derived value as
      a placeholder. *Shown, not silently applied.*
- [ ] **30.** Type your own slug. The "from the name" wording disappears and
      what you typed is what is used.
- [ ] **31.** Clear it again and **save**. The form is created with the derived
      slug and prefix, and `/forms/<id>` shows them filled in.
- [ ] **32.** Create a **second** form with the same name. It saves, and its
      slug is **`collateral-request-2`** with prefix **`COL2`**. *De-duplication
      is a retry against the unique index, not a lookup — RLS hides other
      departments' forms, so a "is this taken" query would be blind to exactly
      the clashes that matter.*
- [ ] **33.** Now create a third and **type** `collateral-request` by hand. It
      is **refused** with "That URL slug is taken" on the field. ⚠️ *It must not
      silently save `collateral-request-3`. Only a DERIVED value is ever bumped
      — an address one character from another department's form is one you are
      about to paste into an email.*

### B2 · The prefix lock

Open a form that **already has submissions** (the live "Test Client Request" has
one).

- [ ] **34.** The Reference prefix input is **disabled** and says "Locked —
      requests already quote it."
- [ ] **35.** ⚠️ **The real test.** In devtools, remove the `disabled`
      attribute, change the prefix, and Save. It is **refused** with
      `Locked at COL — 1 request already quotes it.` *The front end will be
      bypassed; the rule is in the action, not the input. Same shape as
      `field_key` immutability (D20/R5).*
- [ ] **36.** On a form with **no** submissions, the prefix still changes
      freely.

### B3 · The public URL

- [ ] **37.** `/forms` — the share link reads and points at **`/request/<slug>`**.
- [ ] **38.** Open it in a **private window** (no session). ⚠️ *A signed-in one
      proves nothing.* The form renders and **submits**.
- [ ] **39.** In the same private window, open the **old** `/f/<slug>`. It
      **redirects** to `/request/<slug>` and renders the form.
- [ ] **40.** ⚠️ It must **not** show a login page. *If `/f/` had been dropped
      from the proxy allowlist, the redirect would sit behind the auth gate and
      an old link in a client's inbox would ask somebody with no account to sign
      in — worse than the 404 the redirect exists to prevent.*
- [ ] **41.** Confirm it is a **308** in the network tab, not a 307. *Permanent.
      An old link lives in emails, bookmarks and printed briefs, and none of
      those can be recalled.*
- [ ] **42.** Signed in, open `/requests` — the internal review queue still
      requires a session and is unaffected. *It is one character from the new
      public prefix; a unit test pins this too.*
- [ ] **43.** **Return** a pending request to its client (Gate 1, "needs more
      information"). The email in the outbox links to **`/request/<slug>`**.
      *This is the reference that mattered most in the move — it goes to
      somebody outside the company.*

---

## Still open after this

**§4c — renaming the live form.** Not done, and it is a data decision rather
than code. See the note in the branch discussion: renaming is now *only* a
rename — the slug does not follow (the derivation is create-only by design, so a
shared URL never changes underneath somebody), the inbox list in Client Requests
does not follow either (`vizserve_pms_forms_sync_list` fires on
`department_id` only, and only creates a list where none exists), and the prefix
**cannot** follow while `COL-2026-0001` exists, because step 35 above is exactly
the rule that stops it.
