/**
 * What shipped, newest first — the source for `/changelog`.
 *
 * ⚠️ NO VERSION NUMBERS, DELIBERATELY. This app has no release train: it is
 * deployed continuously, `package.json` has sat at `0.1.0` since the scaffold,
 * and nothing tags a build. Printing "v1.3.0" beside a date would invent a
 * scheme the repo does not have and that nobody could reconcile with a commit.
 *
 * What it DOES have is dates and backlog IDs, so those are what an entry
 * carries. `refs` are the same IDs the commits use (`P7-73`), which is the
 * thread back to the work — see "How work is organised" in CLAUDE.md.
 *
 * ⚠️ HAND-MAINTAINED, AND THAT IS THE POINT. A changelog generated from commit
 * subjects is a commit log with worse formatting; this is the short list of
 * things a colleague would notice, written for them. Add to the TOP.
 *
 * The history back to 29 Jul 2026 was reconstructed from
 * `docs/13-implementation-status.md` and `git log`, phase by phase. That
 * document is the record of what is actually built and stays the authority — if
 * the two ever disagree, it wins and this file is wrong.
 */
export type ChangelogEntry = {
  /**
   * Bare `YYYY-MM-DD`. Formatted at render through `lib/dates.ts`, never here —
   * it parses as midday UTC so the day cannot slip backwards (CLAUDE.md).
   */
  date: string;
  /** The part of the app this landed in. Shown as the badge. */
  area:
    | "Tasks"
    | "Timesheet"
    | "Leave"
    | "DTR"
    | "Forms"
    | "Approvals"
    | "Reporting"
    | "Platform";
  title: string;
  /** One or two sentences. What changed and why somebody would care. */
  description: string;
  /** The specifics. Keep them short enough to scan. */
  items?: string[];
  /** Backlog IDs, as the commits carry them. */
  refs?: string[];
  /**
   * A caveat, shown as a warning line under the entry.
   *
   * ⚠️ THIS FIELD EXISTS SO THE CHANGELOG CANNOT LIE. Several features are
   * code-complete with a migration that has not been applied to the live
   * project — `docs/13-implementation-status.md` names each one. Announcing
   * those as shipped would send somebody looking for a screen that errors.
   */
  pending?: string;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-09-21",
    area: "Tasks",
    title: "A list can be read as a timeline",
    description:
      "Gantt joins List and Board as a third view of the same list, so a schedule is something you look at rather than something you reconstruct from due dates.",
    items: [
      "Bars run from a task's start date to its due date, grouped by stage",
      "Drag a bar to reschedule it, or drag an edge to change the span",
      "Filter which stages appear, without touching the List or Board views",
      "Tasks missing a start or due date are counted on screen rather than quietly dropped",
    ],
  },
  {
    date: "2026-09-18",
    area: "Timesheet",
    title: "The rest of the week can be filled in early",
    description:
      "The week grid no longer refuses days that have not happened yet, so planned work can be encoded before the week runs.",
    refs: ["P7-76"],
  },
  {
    date: "2026-09-18",
    area: "Leave",
    title: "My submissions, My leave, and leave on the calendar",
    description:
      "Two pages that answer 'what have I asked for, and where did it get to' without going through an approvals queue built for approvers. Requested leave now appears on the shared calendar rather than only once approved.",
    items: ["An allocation on its own no longer shows a gendered leave type on My leave"],
    refs: ["P7-45", "P7-75"],
  },
  {
    date: "2026-09-17",
    area: "Tasks",
    title: "Custom fields on a list, and a tree you can reorder",
    description:
      "A list can carry its own fields — text, number, date, dropdown, labels, checkbox — editable straight from the task list. Lists and folders can be dragged into order.",
    items: [
      "An empty field is clickable rather than dead space",
      "The button and the filter label both read \"Custom fields\"",
      "A drag never refiles: a list moves within its folder only",
    ],
    refs: ["P7-73", "P7-74"],
    pending:
      "The status doc records the custom-fields migration as written but not yet applied, and not verified in a browser.",
  },
  {
    date: "2026-09-17",
    area: "Tasks",
    title: "@ mentions in a task comment",
    description:
      "A comment can name somebody and notify them. Replies and reactions are still deliberately absent — the thread stays flat.",
    refs: ["P7-71"],
    pending: "The status doc records both migrations as written but not yet applied.",
  },
  {
    date: "2026-09-17",
    area: "Forms",
    title: "Forms can be archived, restored and deleted",
    description:
      "A form that is finished with no longer has to stay in the rail forever, and a draft stops appearing in the tasks tree.",
    refs: ["P7-72"],
  },
  {
    date: "2026-09-16",
    area: "Tasks",
    title: "Subtasks, checklists, copies and comment images",
    description:
      "The task page stopped being a single flat record. The largest run of task work so far.",
    items: [
      "Anybody who can see a task can break it into subtasks",
      "A task can carry a checklist",
      "A task can be copied into another list; a subtask lands where its parent lives",
      "Images can be pasted into a comment and opened full size",
      "The task page shows the last three entries and hands the full thread to a sheet",
      "The task list stops hiding its controls, and a board card drags by the card",
    ],
    refs: ["P7-67", "P7-68", "P7-69", "P11-08", "P12-18", "P12-19"],
  },
  {
    date: "2026-09-15",
    area: "Tasks",
    title: "A shared list is shared",
    description: "A list shared with somebody now behaves as shared for them, rather than only saying so.",
    refs: ["P12-16"],
  },
  {
    date: "2026-09-14",
    area: "Platform",
    title: "Error boundaries, and a faster task policy",
    description:
      "The app had no error boundaries at all — a single failing component took the whole page down. It now fails in one place instead. Separately, the task policy is evaluated once per statement rather than once per row.",
    refs: ["P12-04", "P12-14"],
  },
  {
    date: "2026-09-07",
    area: "Platform",
    title: "The product is now VizServe Team Portal",
    description:
      "Eighteen user-visible strings were renamed. The codebase deliberately was not: the repo, the table prefixes and the app-access key all stay vizserve-pms, because changing that last one locks everybody out.",
    items: [
      "An approval timeline that prints names instead of ids",
      "Character counters on the fields that have a limit",
      "Clock-in and clock-out reminders get their own separate lead times",
      "A department's members may now edit its tasks — reversing P7-14, which is why every direct update is audited",
    ],
    refs: ["P11-01", "P11-02", "P11-03", "P11-04"],
  },
  {
    date: "2026-09-07",
    area: "Platform",
    title: "The performance pass",
    description:
      "No business logic changed anywhere in this pass — only when queries were issued, and how often. Auth round trips per request went from two to none.",
    items: [
      "Request waterfalls collapsed and duplicate reads memoised",
      "27 Suspense boundaries added, so chrome paints before data arrives",
      "Next.js 16.2.12 to 16.3.4",
    ],
    refs: ["P10"],
  },
  {
    date: "2026-09-05",
    area: "Leave",
    title: "Leave hand-over, and an approval chain with real stages",
    description:
      "Every leave request now needs two approvals — the department's team leader, then a manager. A lead approving leave no longer finishes it.",
    items: [
      "Leave types HR marks as needing a reliever gain a third stage in front of those two",
      "The requester names one to three colleagues and hands each of them specific tasks",
      "A request can be withdrawn",
    ],
    refs: ["P9-01", "P9-08"],
  },
  {
    date: "2026-09-01",
    area: "Leave",
    title: "HR as a capability, and a filterable leave audit",
    description:
      "HR stops being a role and becomes something a person can hold, so the leave audit is reachable by the people who need it without promoting them.",
    refs: ["P7-52", "P7-53"],
  },
  {
    date: "2026-08-25",
    area: "DTR",
    title: "The smart DTR, holidays, and leave balances",
    description:
      "The daily time record learned the shape of a real working month — holidays, balances, and a leave audit somebody can hand over.",
    items: [
      "A holiday calendar, which needed no migration at all",
      "Leave balances and gender, so entitlements that differ can differ",
      "The leave audit as a PDF",
      "VAWC leave",
      "The timesheet entry editor rebuilt",
    ],
    refs: ["P7-32", "P7-35", "P7-36", "P7-40", "P7-41", "P7-44"],
  },
  {
    date: "2026-08-19",
    area: "Tasks",
    title: "Folders, the project tree, and a board you can drag",
    description:
      "The sidebar became the shape people already know: department, then folder, then list. Folders are a real table, because the grouping people wanted — \"VizServe Projects\" — is not a department.",
    items: [
      "Deleting an internal task, with the damage named before it happens",
      "Dragging a card on the board, and a subtask that stays with its parent",
      "Department visibility and collapsible sidebar groups",
      "Every native control moved onto the design system, fixing 19 broken dropdowns",
    ],
    refs: ["P7-17", "P7-18", "P7-19", "P7-20"],
  },
  {
    date: "2026-08-19",
    area: "Reporting",
    title: "The first reporting surfaces",
    description:
      "Tasks by stage, requests by status, what is overdue, and hours per department — the narrow reading of the reporting backlog, not the whole of it.",
    refs: ["P6-05"],
  },
  {
    date: "2026-08-18",
    area: "Timesheet",
    title: "The timesheet is a week grid",
    description:
      "Rebuilt from a rail-and-day-list into the shape the team already knows: tasks down the side, days across the top, a duration typed into the cell, totals on both axes.",
    items: [
      "A bare number in a cell means hours — 1.5 becomes 90 minutes, and re-renders as 1:30 so the reading is visible where it was typed",
      "A cell holding more than one entry goes read-only and defers to its popover, because one number cannot honestly replace two notes",
      "Monday start, with the week in the URL",
    ],
    refs: ["P6-01", "P6-02", "P6-03", "D21"],
  },
  {
    date: "2026-08-18",
    area: "Tasks",
    title: "Personal tasks, subtasks, comments, priority and overtime",
    description:
      "Work that belongs to a person rather than to a client request. The timesheet approval built on this became the third consumer of the Phase 2 approval engine, with no change to the engine.",
    items: [
      "A member can create work for themselves",
      "Subtasks, one level deep, enforced by a trigger",
      "Task comments — flat, author-only edit",
      "Task priority, and several assignees on one task",
      "Overtime as an internal request type, capped at 960 minutes",
      "Leave types became an admin-editable table",
    ],
    refs: ["P7-01", "P7-05", "P7-07", "P7-09", "P7-11", "P7-12", "P7-13"],
  },
  {
    date: "2026-08-04",
    area: "Platform",
    title: "The design system, and an app shell that holds together",
    description:
      "A Base UI primitive layer, the sidebar shell, four shared layout components the app never had, and dark mode finally reachable. Loading skeletons went onto the eleven routes that had none.",
  },
  {
    date: "2026-08-04",
    area: "DTR",
    title: "Daily time record and internal approvals",
    description:
      "Clocking in and out, and the four internal request types, routed through the same approval engine Gate 1 uses — the engine was not touched to do it.",
    items: [
      "Earliest-in and latest-out, so a second punch cannot shorten a day",
      "A correction is the only path allowed to overwrite an earliest-in",
      "Payroll export as CSV",
    ],
    refs: ["P5-01", "P5-12"],
  },
  {
    date: "2026-08-04",
    area: "Approvals",
    title: "Gate 3 — the client approves by email, without logging in",
    description:
      "A tokenised link, stored only as a hash and bound to one email address. Two reminders go out before anything expires.",
    items: [
      "The public approval page shows the original specs alongside the output",
      "An hourly job completes unanswered requests as COMPLETED (no response) — never as COMPLETED",
      "Feedback is requested on every completion, including the automatic ones",
    ],
    refs: ["P4-01", "P4-13"],
  },
  {
    date: "2026-08-03",
    area: "Tasks",
    title: "Tasks, lists, and the status machine",
    description:
      "The eight stages, and a state machine that is enforced in the database rather than in the screen. status is not an updatable column — only the transition function moves a task.",
    items: [
      "The task list with URL filters, and the board as its companion",
      "The task detail page, which doubles as the QA screen",
      "The resolution gate: a task cannot be closed without saying how",
    ],
    refs: ["P3-01", "P3-15"],
  },
  {
    date: "2026-08-03",
    area: "Approvals",
    title: "The approval engine, and Gate 1",
    description:
      "Built generically once, with the client request gate as its first consumer rather than its implementation — proven by routing a throwaway request type end to end without touching engine code.",
    items: [
      "The team leader review screen, with a live capacity panel per assignee",
      "Editing the date, title and description before approving, all audited with before and after",
      "PIC and QA selectors, QA defaulting to the approving lead",
      "Return and reject both refuse to submit without a reason, enforced in three places",
    ],
    refs: ["P2-00", "P2-13"],
  },
  {
    date: "2026-08-03",
    area: "Forms",
    title: "Client request forms, public and with no login",
    description:
      "A form can be built, published, and reached at a public URL by somebody who has never seen the app.",
    items: [
      "Reference numbers that are gapless per form per year",
      "Attachments, with size, MIME and magic-number checks",
      "Rate limiting and a honeypot on the public endpoint",
      "The SLA timer starts on submission",
    ],
    refs: ["P1-01", "P1-16"],
  },
  {
    date: "2026-08-03",
    area: "Platform",
    title: "Foundations — sign-in, roles, and the authorization layer",
    description:
      "Everything the rest of the app is allowed to assume: who you are, what you may see, and a record of what you did.",
    items: [
      "Entra SSO and email/password, resolving to one profile",
      "Four inclusive roles, with every scope decision in one authorization layer",
      "Row-level security on every table, plus the grants migration that followed it",
      "An audit log, notifications and an inbox, and transactional email",
      "User management at /admin/users, and a scope test suite as the exit criterion",
    ],
    refs: ["P0-01", "P0-12"],
  },
  {
    date: "2026-07-30",
    area: "Platform",
    title: "The brand palette, and a shell that works on a phone",
    description:
      "The brand blue became the primary colour rather than the template's near-black, and the shell became responsive.",
    refs: ["D11"],
  },
  {
    date: "2026-07-29",
    area: "Platform",
    title: "First commit",
    description:
      "The scaffold: Next.js, React, TypeScript, Tailwind and Supabase, with the planning docs that still set the phase order.",
  },
];
