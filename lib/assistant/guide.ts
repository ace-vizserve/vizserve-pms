import { roleAtLeast, type Role } from "@/lib/auth/roles";
import { visibleNavItems, type NavViewer } from "@/lib/navigation";

/**
 * The assistant — "where do I go to …?" answered with a guided tour.
 *
 * DELIBERATELY NOT A LANGUAGE MODEL. A question is matched against the
 * keywords below, and the best destination the viewer can actually open wins.
 * The assistant then flies to the matching sidebar row, opens the page, points
 * at each `step.target` while a speech bubble says what it is for, and flies
 * back to its corner. Nothing leaves the browser, nothing costs per question,
 * and every answer is one somebody wrote down — so it can be wrong only in
 * ways a test can catch.
 *
 * ⚠️ REACHABILITY COMES FROM THE NAV, NOT FROM A THIRD COPY OF THE ROLE RULES.
 * `reachableHrefs` flattens `visibleNavItems`, so the assistant offers exactly
 * the screens the sidebar does. Like the sidebar, that is presentation: every
 * route still re-checks, and RLS under it.
 *
 * ⚠️ A TARGET IS A CSS SELECTOR AND MAY BE MISSING — a role that does not see
 * the control, a list still loading, a phone with the sidebar folded away. The
 * tour then says the line without pointing, rather than stopping. Prefer an
 * existing `aria-label` (it is also what a screen reader announces, so it is
 * the least likely thing to change), and otherwise a `data-tour` attribute.
 *
 * ORDER MATTERS ON A TIE. Two destinations scoring the same resolve to the one
 * listed first among those the viewer can reach — which is how "holidays" lands
 * HR on the editor and everybody else on the home calendar.
 */

export type TourStep = {
  /** What the bubble says. */
  text: string;
  /**
   * The element pointed at — a selector, or several joined by ", " where the
   * same control has a different id in different dialogs. Omit to say the line
   * without pointing.
   */
  target?: string;
  /** Press the target when moving on — how a tour opens the dialog it explains. */
  click?: boolean;
  /** Not there for this person (a lead-only field): skip it rather than say it. */
  optional?: boolean;
  /**
   * Inside an open dialog. A modal makes everything outside it inert, so the
   * bubble cannot be clicked: it moves on by itself, and Escape ends the tour.
   */
  modal?: boolean;
};

export type GuideDestination = {
  id: string;
  /** What the assistant calls the place. */
  title: string;
  /** The page the tour runs on. External means pointed at, never opened. */
  href: string;
  external?: boolean;
  /**
   * Where to go once the tour is over — a `?type=` prefill that opens the
   * request dialog. AFTER, not during: a modal makes everything outside it
   * inert, the speech bubble included.
   */
  then?: string;
  /**
   * Phrases, lower case. Taglish is welcome — it is how the team asks. A
   * phrase scores its word count, so "leave balance" (2) beats "leave" (1).
   */
  keywords: string[];
  steps: TourStep[];
};

const tour = (id: string) => `[data-tour="${id}"]`;
const labelled = (label: string) => `[aria-label="${label}"]`;

const NEW_REQUEST = tour("new-request");
const slot = (name: string) => `[data-arm-slot="${name}"]`;
/** One control under the id each New task dialog gives it. */
const anyId = (...ids: string[]) => ids.map((id) => `[id="${id}"]`).join(", ");

/*
  THE TASK LIST, CONTROL BY CONTROL, THEN INTO NEW TASK.

  Row controls are found by their `data-arm-slot`, which the list already sets
  for its hover-to-reveal icons — the first visible row is the one pointed at.
  The dialog half covers all three New task dialogs (a lead's, a member's own,
  the collaboration space's): shared fields are listed under every id they
  use, and the lead-only ones are `optional`.
*/
const TASK_TOUR: TourStep[] = [
  { text: "Your projects live here — department, then folder, then list. Open a list to see just its tasks.", target: tour("projects") },
  { text: "List, Board and Gantt are three views of the same tasks.", target: labelled("View") },
  { text: "Show all work, or only internal or only client work.", target: labelled("Kind of work") },
  { text: "Everything, only yours, or the ones waiting on your QA review.", target: labelled("Scope") },
  { text: "Find a task by its name.", target: 'input[placeholder="Search tasks"]', optional: true },
  { text: "Narrow it to one person, or to what is due soon.", target: anyId("task-person"), optional: true },
  { text: "Show or hide columns.", target: tour("columns"), optional: true },
  { text: "Give this list fields of its own — text, numbers, dates, dropdowns.", target: tour("custom-fields"), optional: true },
  { text: "Tasks are grouped by stage. Drag one into another stage to move it along.", target: tour("status-group"), optional: true },
  { text: "The pencil renames a task.", target: slot("rename"), optional: true },
  { text: "The flag sets its priority.", target: slot("priority-icon"), optional: true },
  { text: "This makes it repeat — daily, weekly or monthly.", target: slot("repeat-icon"), optional: true },
  { text: "The plus breaks it into subtasks.", target: slot("add-subtask"), optional: true },
  { text: "Who is on it. Click to add or change people.", target: slot("assignees"), optional: true },
  { text: "Click Time tracked to log hours against it, without opening your timesheet.", target: slot("log-time"), optional: true },
  { text: "Comment here — type @ and a name to bring somebody in.", target: slot("comments"), optional: true },
  { text: "Add a task straight into a stage with just a title.", target: tour("add-task"), optional: true },
  { text: "Or use New task for the full form. I'll open it for you.", target: tour("new-task"), click: true, optional: true },
  { text: "Give it a title that says what done looks like.", target: anyId("title"), modal: true, optional: true },
  {
    text: "The department it belongs to — anyone in it can work on it.",
    target: anyId("department"),
    modal: true,
    optional: true,
  },
  { text: "When the work starts…", target: anyId("start", "start_date"), modal: true, optional: true },
  { text: "…and when it is due.", target: anyId("due", "due_date"), modal: true, optional: true },
  { text: "The person in charge of it.", target: anyId("assignee"), modal: true, optional: true },
  { text: "Who checks the work before it can be closed.", target: anyId("qa"), modal: true, optional: true },
  {
    text: "The list it files into — the one you have open is already picked.",
    target: anyId("list", "list_id"),
    modal: true,
    optional: true,
  },
  { text: "Fill these in and press Create. Esc closes the form.", modal: true },
];

export const GUIDE_DESTINATIONS: GuideDestination[] = [
  {
    id: "my-leave",
    title: "My leave",
    href: "/approvals/leave",
    keywords: [
      "leave balance", "leave credit", "remaining leave", "my leave", "how many leave",
      "ilan leave", "natitirang leave",
    ],
    steps: [
      { text: "This is My leave — your balance for each leave type this year." },
      { text: "Used days come from approved requests, so one still pending is not counted yet." },
    ],
  },
  {
    id: "file-leave",
    title: "File a leave",
    href: "/approvals",
    then: "/approvals?type=LEAVE",
    keywords: [
      "file leave", "file a leave", "request leave", "apply leave", "apply for leave",
      "leave request", "vacation leave", "sick leave", "vacation", "sick", "mag leave",
      "magleave", "mag file ng leave",
    ],
    steps: [
      { text: "Everything you file lives here in Approvals.", target: labelled("Approvals") },
      { text: "Leave starts from New request.", target: NEW_REQUEST },
      { text: "Pick the type and dates, and name who covers your work. I'll open the form for you now." },
    ],
  },
  {
    id: "file-overtime",
    title: "Overtime",
    href: "/approvals",
    then: "/approvals?type=OVERTIME",
    keywords: ["overtime", "ot", "file overtime", "file ot", "log overtime", "mag ot"],
    steps: [
      { text: "Overtime is filed from New request.", target: NEW_REQUEST },
      { text: "Enter the date, the hours and what the work was. Opening the form now." },
    ],
  },
  {
    id: "file-no-time-out",
    title: "No time-out",
    href: "/approvals",
    then: "/approvals?type=NO_TIME_OUT",
    keywords: ["no time out", "forgot to time out", "nakalimutan mag time out", "missed time out", "di nakapag out"],
    steps: [
      { text: "A missed time-out is fixed with a request, from here.", target: NEW_REQUEST },
      { text: "Enter when you actually left. Once approved, it goes into your DTR. Opening it now." },
    ],
  },
  {
    id: "file-no-time-in",
    title: "No time-in",
    href: "/approvals",
    then: "/approvals?type=NO_TIME_IN",
    keywords: [
      "no time in", "forgot to time in", "nakalimutan mag time in", "missed time in",
      "missed punch", "dtr correction", "time correction", "correction",
    ],
    steps: [
      { text: "A missed time-in is fixed with a request, from here.", target: NEW_REQUEST },
      { text: "If the time is wrong rather than missing, correct that row from your DTR instead." },
      { text: "Enter when you actually started. Opening the form now." },
    ],
  },
  {
    id: "file-reimbursement",
    title: "Reimbursement",
    href: "/approvals",
    then: "/approvals?type=REIMBURSEMENT",
    keywords: ["reimbursement", "reimburse", "refund", "expense", "claim", "resibo", "receipt"],
    steps: [
      { text: "Reimbursements are filed from New request.", target: NEW_REQUEST },
      { text: "Enter the amount, what it was for, and attach the receipt. Opening it now." },
    ],
  },
  {
    id: "approvals",
    title: "Approvals",
    href: "/approvals",
    keywords: ["leave", "approval", "approve", "pending approval", "withdraw", "my request", "status of my request"],
    steps: [
      { text: "This is Approvals — what you filed, and anything waiting on you.", target: labelled("Approvals") },
      { text: "File something new from here.", target: NEW_REQUEST },
      { text: "Requests go to your team leader, then the manager. Open one to see its timeline." },
    ],
  },
  {
    id: "dtr",
    title: "Daily time record",
    href: "/dtr",
    keywords: [
      "time in", "time out", "timein", "timeout", "clock in", "clock out", "punch", "dtr",
      "daily time record", "my attendance", "pasok", "uwi", "mag time in", "mag out",
    ],
    steps: [
      { text: "Punch in and out here. Your earliest in and your latest out are the ones that count.", target: tour("punch") },
      { text: "Missed one? Ask me about a forgotten time-in and I'll show you the request." },
    ],
  },
  {
    id: "team-week",
    title: "Team week",
    href: "/timesheet/team",
    keywords: ["team timesheet", "approve timesheet", "team week", "team hour", "submitted week"],
    steps: [
      { text: "This is the team week — everyone's hours, grouped by department." },
      { text: "Open a submitted week to approve it or send it back." },
    ],
  },
  {
    id: "timesheet-history",
    title: "My submissions",
    href: "/timesheet/history",
    keywords: ["timesheet history", "past timesheet", "my submission", "submitted timesheet", "old timesheet"],
    steps: [{ text: "These are the weeks you handed in, and what happened to each." }],
  },
  {
    id: "timesheet",
    title: "Timesheet",
    href: "/timesheet",
    keywords: [
      "timesheet", "log time", "log hour", "log my hour", "hour", "time spent", "my week",
      "submit timesheet", "time tracking", "track time",
    ],
    steps: [
      { text: "This is your week: tasks down the side, days across the top.", target: tour("week-grid") },
      { text: "Type hours into a cell — 1.5 and 1:30 both mean an hour and a half.", target: tour("week-grid") },
      { text: "When the week is done, submit it here. It locks until your lead decides.", target: tour("week-status") },
    ],
  },
  {
    id: "lists",
    title: "Lists",
    href: "/tasks/lists",
    keywords: ["manage list", "create list", "new list", "new folder", "create folder", "rename list"],
    steps: [
      { text: "Lists and folders for your department are made and arranged here." },
      { text: "They show up under Projects in the sidebar.", target: tour("projects") },
    ],
  },
  {
    id: "tasks",
    title: "Tasks",
    href: "/tasks",
    keywords: [
      "task", "my task", "todo", "to do", "ticket", "board", "gantt", "timeline", "new task",
      "add task", "create task", "subtask", "checklist", "project", "trabaho", "gagawin",
    ],
    steps: TASK_TOUR,
  },
  {
    id: "inbox",
    title: "Inbox",
    href: "/inbox",
    keywords: ["inbox", "notification", "mention", "who mentioned me", "alert", "unread"],
    steps: [
      { text: "Mentions, assignments and anything waiting on you land here." },
      { text: "Narrow it to one kind, or to unread, with these.", target: tour("inbox-filters") },
    ],
  },
  // THE BUILDER BEFORE "FILL A FORM", so a bare "form" ties to the builder for
  // a lead and falls through to answering one for a member, who cannot open it.
  {
    id: "forms",
    title: "Forms",
    href: "/forms",
    keywords: [
      "form", "build form", "build a form", "create form", "create a form", "make form",
      "make a form", "new form", "form builder", "client form", "edit form", "publish form",
      "form link", "gawa form", "gumawa ng form",
    ],
    steps: [
      { text: "These are your department's forms — live ones have a public link for the client." },
      { text: "Start a new one here.", target: 'a[href="/forms/new"]' },
      { text: "Open any form to edit its fields, then publish it to get its link." },
    ],
  },
  {
    id: "respond",
    title: "Fill a form",
    href: "/respond",
    keywords: [
      "form", "fill a form", "fill form", "fill up", "fill out", "answer form", "answer a form",
      "survey", "internal form",
    ],
    steps: [{ text: "These are the internal forms you can answer. Open one to fill it in." }],
  },
  {
    id: "requests",
    title: "Requests",
    href: "/requests",
    keywords: ["client request", "request queue", "gate 1", "pending request", "approve request", "incoming request"],
    steps: [
      { text: "These are the requests clients sent through the public forms." },
      { text: "Open one to approve it, set its urgency, or send it back." },
    ],
  },
  {
    id: "analytics-delivery",
    title: "Delivery & quality",
    href: "/analytics/delivery",
    keywords: ["delivery", "quality", "qa", "on time", "sla", "turnaround", "overdue"],
    steps: [{ text: "Delivery & quality — what finished on time, and how QA went." }],
  },
  {
    id: "analytics-time",
    title: "Time & attendance",
    href: "/analytics/time",
    keywords: ["time and attendance", "attendance analytic", "hour by department"],
    steps: [{ text: "Time & attendance — hours and attendance, against the previous period." }],
  },
  {
    id: "analytics-client",
    title: "Client results",
    href: "/analytics/client",
    keywords: ["client result", "rating", "feedback", "client satisfaction", "review score"],
    steps: [{ text: "Client results — ratings, and how clients responded at sign-off." }],
  },
  {
    id: "analytics-people",
    title: "People",
    href: "/analytics/people",
    keywords: ["people performance", "person page", "individual performance", "employee performance", "member performance"],
    steps: [{ text: "Open anyone here to see their performance against their department." }],
  },
  {
    id: "analytics",
    title: "Analytics",
    href: "/analytics",
    keywords: ["analytic", "workload", "performance", "report", "kpi", "metric", "stat"],
    steps: [
      { text: "This is Analytics, open on Workload." },
      { text: "The other sections cover delivery, time, client results and people." },
    ],
  },
  {
    id: "users",
    title: "Users",
    href: "/admin/users",
    keywords: ["user", "add user", "new employee", "new user", "role", "change role", "deactivate", "account"],
    steps: [{ text: "Open someone here to change their roles, department or access." }],
  },
  {
    id: "holidays-admin",
    title: "Holidays & events",
    href: "/admin/holidays",
    keywords: ["holiday", "add holiday", "event", "add event", "company event"],
    steps: [{ text: "Add a holiday or event here and it shows on everyone's calendar." }],
  },
  {
    id: "hr-balances",
    title: "Leave balances",
    href: "/hr/balances",
    keywords: ["everyone leave balance", "all leave balance", "team leave balance", "set leave balance", "leave allocation"],
    steps: [{ text: "Everybody's leave balances for the year. Change an allocation from here." }],
  },
  {
    id: "hr-leave-types",
    title: "Leave types",
    href: "/hr/leave-types",
    keywords: ["leave type", "add leave type", "new leave type"],
    steps: [{ text: "These are the leave types people can file." }],
  },
  {
    id: "hr-reports",
    title: "Leave reports",
    href: "/hr/reports",
    keywords: ["leave report", "leave audit", "leave pdf"],
    steps: [{ text: "The year at a glance, with the printable documents below." }],
  },
  {
    id: "hr-attendance",
    title: "Attendance",
    href: "/hr/attendance",
    keywords: ["attendance", "who is late", "late", "absent", "absence", "tardiness", "sino late"],
    steps: [{ text: "Lates, absences and missing time-outs across the company." }],
  },
  {
    id: "admin-settings",
    title: "Settings",
    href: "/admin/settings",
    keywords: ["company setting", "notification rule", "email setting", "admin setting"],
    steps: [{ text: "Company-wide settings, including who is told at each stage." }],
  },
  {
    id: "audit",
    title: "Audit trail",
    href: "/admin/audit",
    keywords: ["audit", "audit trail", "audit log", "who changed"],
    steps: [{ text: "Every change, and who made it." }],
  },
  {
    id: "error-log",
    title: "Error log",
    href: "/admin/errors",
    keywords: ["error", "error log", "bug", "crash", "what failed", "what broke", "sira", "nag error"],
    steps: [
      { text: "Everything that failed, per day — and the same bug counted once on the right." },
      { text: "Open Details on any row for the full message, the page and the stack trace." },
    ],
  },
  {
    id: "my-settings",
    title: "Your settings",
    href: "/settings",
    keywords: ["my setting", "setting", "password", "change password", "reminder", "preference", "profile"],
    steps: [{ text: "Your own settings — your password and your clock reminders." }],
  },
  {
    id: "changelog",
    title: "Changelog",
    href: "/changelog",
    keywords: ["changelog", "what new", "whats new", "update", "new feature", "release note"],
    steps: [{ text: "Everything that changed in the portal, newest first." }],
  },
  {
    id: "payslip",
    title: "VizCore",
    href: "https://core.vizserve.com/actions",
    external: true,
    keywords: ["payslip", "pay slip", "salary", "sahod", "sweldo", "payroll", "vizcore"],
    steps: [
      { text: "Payslips live in VizCore. This button opens it in a new tab.", target: 'a[title="VizCore"]' },
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    href: "/dashboard",
    keywords: ["dashboard", "overview", "summary", "my number"],
    steps: [{ text: "Your open tasks, your QA queue, and what is waiting on you." }],
  },
  {
    id: "home",
    title: "Home",
    href: "/",
    keywords: [
      "home", "announcement", "calendar", "holiday", "event", "who is on leave", "sino naka leave",
      "on leave today",
    ],
    steps: [
      { text: "Notices from your leads show up here.", target: labelled("Announcements") },
      { text: "Time in and out without leaving the home page.", target: labelled("Daily time record") },
      { text: "The things people file most, one click each.", target: labelled("Quick actions") },
      { text: "Who is on leave, plus holidays and events.", target: 'section[aria-label="Leave and vacation"]' },
    ],
  },
];

/**
 * TOURS OF A PAGE YOU ARE ALREADY ON — "how do I fill this in?" rather than
 * "where is it?". Matched by route and, where one route draws different
 * screens, by query (`/forms/new?purpose=…` is three). A destination's own
 * steps double as its page's tour, so only pages that are not a destination,
 * or need more than a destination says, are listed here.
 */
export type PageTour = {
  path: string;
  /** Every pair must be in the URL; omit for "any query". */
  query?: Record<string, string>;
  title: string;
  steps: TourStep[];
};

const field = (id: string) => `[id="${id}"]`;

export const PAGE_TOURS: PageTour[] = [
  {
    path: "/forms/new",
    query: { purpose: "CLIENT_REQUEST" },
    title: "New client form",
    steps: [
      { text: "Name it the way the client will read it, like Marketing Collateral Request.", target: field("name") },
      { text: "The slug is the end of the public link — short, lowercase, with dashes.", target: field("slug") },
      { text: "A line or two the client reads above the fields.", target: field("description") },
      { text: "Whose Team Leader approves what comes in through this form.", target: field("department") },
      {
        text: "Working days to deliver: the first box when the TL marks it Urgent, the second when not.",
        target: field("urgent_days"),
      },
      {
        text: "How long the client has to sign the work off before it completes on its own.",
        target: field("client_approval_days"),
      },
      {
        text: "Keep this on for work requests. Turn it off for a form that only collects answers, like feedback.",
        target: field("requires_approval"),
      },
      { text: "It stays a draft until you publish, so you can add the fields first.", target: field("is_active") },
      { text: "Then press Create form at the bottom, and add your fields on the next page." },
    ],
  },
  {
    path: "/forms/new",
    query: { purpose: "INTERNAL" },
    title: "New internal form",
    steps: [
      { text: "Name the form. Staff will find it under Fill a form.", target: field("name") },
      { text: "Create it, then add the questions on the next page." },
    ],
  },
  {
    path: "/forms/new",
    title: "New form",
    steps: [
      { text: "First pick the kind of form." },
      { text: "A client request form has a public link and turns each submission into work for your team." },
      { text: "An internal form is answered by staff, behind the login." },
    ],
  },
];

/** The tour for the page in front of the viewer, if there is one. */
export function tourForPage(pathname: string, search: URLSearchParams): { title: string; steps: TourStep[] } | null {
  const page = PAGE_TOURS.find(
    (tour) =>
      tour.path === pathname &&
      Object.entries(tour.query ?? {}).every(([key, value]) => search.get(key) === value),
  );
  if (page) return page;
  const destination = GUIDE_DESTINATIONS.find((d) => !d.external && d.href === pathname);
  return destination ? { title: destination.title, steps: destination.steps } : null;
}

/**
 * Pointing at the page itself — "this", "here", "help", "dito". Checked on the
 * raw words (not `normalise`, which would turn "this" into "thi").
 */
const ABOUT_THIS_PAGE = /\b(this|here|page|help|guide|explain|tour|around|dito|ito|ano to|paano)\b/i;

export function isAboutThisPage(question: string): boolean {
  return ABOUT_THIS_PAGE.test(question);
}

/**
 * Below this, a match is one word — "fill" in "how do I fill this up" — and a
 * question that also points at the page means the page, not somewhere else.
 */
export const STRONG_MATCH = 2;

/** Reached from the shell rather than the sidebar's module list. */
const ALWAYS_REACHABLE = ["/", "/tasks", "/inbox", "/settings", "/changelog"];

/** Every portal route this viewer's sidebar offers, plus the shell's own links. */
export function reachableHrefs(role: Role, viewer: NavViewer): Set<string> {
  const hrefs = new Set(ALWAYS_REACHABLE);
  for (const item of visibleNavItems(role, viewer)) {
    hrefs.add(item.href);
    for (const child of item.children ?? []) hrefs.add(child.href);
  }
  // In the Projects tree rather than NAV_ITEMS; same floor as its page.
  if (roleAtLeast(role, "team_leader")) hrefs.add("/tasks/lists");
  return hrefs;
}

function canReach(destination: GuideDestination, reachable: Set<string>): boolean {
  return destination.external === true || reachable.has(destination.href);
}

/**
 * Lower case, punctuation to spaces, and a trailing plural "s" dropped from
 * longer words — applied to the question AND the keywords, so "balances" meets
 * "balance" without a second spelling of every phrase.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))
    .join(" ");
}

/** Words too common to say anything about where somebody wants to go. */
const STOPWORDS = new Set(["a", "an", "and", "the", "my", "your", "of", "to", "in", "on", "for", "how", "where"]);

/** One letter added, dropped or changed — "aproval", "timeshet". */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Below this a one-letter slip turns one real word into another: "time"/"tile". */
const TYPO_MIN_LENGTH = 5;

/**
 * A phrase found whole scores its word count. On top of the keywords, the
 * destination's own TITLE counts a point a word — so "forms" or "inbox" always
 * lands even where nobody thought to list it. A single word one typo away
 * scores half, so a misspelling finds its page without outranking a real match.
 */
function score(question: string, destination: GuideDestination): number {
  const haystack = ` ${question} `;
  const words = question.split(" ");
  const nearly = (term: string) =>
    term.length >= TYPO_MIN_LENGTH && words.some((word) => word.length >= TYPO_MIN_LENGTH - 1 && withinOneEdit(word, term));

  let total = 0;
  for (const keyword of destination.keywords) {
    const phrase = normalise(keyword);
    if (!phrase) continue;
    if (haystack.includes(` ${phrase} `)) total += phrase.split(" ").length;
    else if (!phrase.includes(" ") && nearly(phrase)) total += 0.5;
  }
  for (const word of normalise(destination.title).split(" ")) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    if (words.includes(word)) total += 1;
    else if (nearly(word)) total += 0.5;
  }
  return total;
}

export type GuideAnswer =
  | { kind: "go"; destination: GuideDestination; score: number }
  /** The question matched, but only somewhere this viewer cannot open. */
  | { kind: "locked"; destination: GuideDestination }
  | { kind: "unknown" };

export function answerQuestion(question: string, reachable: Set<string>): GuideAnswer {
  const text = normalise(question);
  if (!text) return { kind: "unknown" };

  let bestReachable: { destination: GuideDestination; score: number } | null = null;
  let bestLocked: { destination: GuideDestination; score: number } | null = null;

  for (const destination of GUIDE_DESTINATIONS) {
    const points = score(text, destination);
    if (points === 0) continue;
    if (canReach(destination, reachable)) {
      if (!bestReachable || points > bestReachable.score) bestReachable = { destination, score: points };
    } else if (!bestLocked || points > bestLocked.score) {
      bestLocked = { destination, score: points };
    }
  }

  // A reachable answer wins even on a lower score: somewhere you can go beats
  // being told about somewhere you cannot.
  if (bestReachable) return { kind: "go", destination: bestReachable.destination, score: bestReachable.score };
  if (bestLocked) return { kind: "locked", destination: bestLocked.destination };
  return { kind: "unknown" };
}

/** What the assistant says for an answer that goes nowhere. */
export function stepsFor(answer: GuideAnswer): TourStep[] {
  switch (answer.kind) {
    case "go":
      return answer.destination.steps;
    case "locked":
      return [
        { text: `That is on ${answer.destination.title}, which your role cannot open.` },
        { text: "Ask your team leader or the manager if you need something from it." },
      ];
    case "unknown":
      return [
        { text: "I could not tell where that is." },
        { text: "Try words like leave, time in, timesheet, tasks or payslip." },
      ];
  }
}

/** The quick picks under the question box — only ones this viewer can open. */
export const GUIDE_SUGGESTIONS: { label: string; question: string }[] = [
  { label: "File a leave", question: "file a leave" },
  { label: "Time in", question: "time in" },
  { label: "Log my hours", question: "log my hours" },
  { label: "My tasks", question: "my tasks" },
  { label: "Payslip", question: "payslip" },
];

export type GuidePlan =
  /** Tour the page already open — no navigation. */
  | { kind: "here"; steps: TourStep[] }
  | { kind: "answer"; answer: GuideAnswer };

/**
 * Where a question goes, given the page it was asked on.
 *
 * A clear request for somewhere else always wins — "file a leave" asked on the
 * forms page still files a leave. Otherwise, a question that points at the
 * page ("how do I fill this in?"), one naming the page already open, or one
 * that matched nothing at all, tours the page in front of the person, which is
 * a better answer than "I could not tell".
 */
export function planFor(
  question: string,
  reachable: Set<string>,
  pathname: string,
  page: { steps: TourStep[] } | null,
): GuidePlan {
  const answer = answerQuestion(question, reachable);
  if (!page) return { kind: "answer", answer };

  if (answer.kind === "go") {
    const isThisPage = answer.destination.href === pathname && !answer.destination.then;
    if (isThisPage) return { kind: "here", steps: page.steps };
    if (answer.score < STRONG_MATCH && isAboutThisPage(question)) return { kind: "here", steps: page.steps };
    return { kind: "answer", answer };
  }
  if (isAboutThisPage(question)) return { kind: "here", steps: page.steps };
  if (answer.kind === "unknown") {
    return {
      kind: "here",
      steps: [{ text: "I could not tell where that is, so here is what this page does." }, ...page.steps],
    };
  }
  return { kind: "answer", answer };
}
