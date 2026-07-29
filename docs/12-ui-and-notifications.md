# UI Direction and Notification Policy

Two decisions that shape Kurt's track from the first screen.

---

## 1. Brand palette

| Role | Hex | Token |
|---|---|---|
| **Primary** | `#4359A5` | `--color-primary` |
| **Secondary** | `#5BC0DE` | `--color-secondary` |

### Measured contrast — read this before assigning either colour to text

Computed against WCAG 2.1 (4.5:1 for normal text, 3:1 for large text and UI boundaries):

| Pair | Ratio | Normal text | Large text / UI |
|---|---|---|---|
| Primary `#4359A5` on white | **6.54:1** | ✅ pass | ✅ pass |
| White on primary | **6.54:1** | ✅ pass | ✅ pass |
| Secondary `#5BC0DE` on white | **2.09:1** | ❌ fail | ❌ fail |
| White on secondary | **2.09:1** | ❌ fail | ❌ fail |
| Ink `#202020` on secondary | **7.79:1** | ✅ pass | ✅ pass |
| Primary on secondary | 3.13:1 | ❌ fail | ✅ pass |

**What this means in practice:**

- **`#4359A5` is the workhorse.** Primary buttons, active nav, links, focus rings, headings. It carries white text safely and reads well on white.
- **`#5BC0DE` is a surface and accent colour, not a text colour.** At 2.09:1 it fails against white in both directions. Use it for chip and badge *backgrounds* (with `#202020` text on top, which passes at 7.79:1), highlight bars, chart fills, and hover tints. **Never** use it for body text on white, and never put white text on it.
- If a light-blue text treatment is genuinely wanted, darken it. `#2A8FB0`-ish territory gets you to ~4.5:1 on white while staying recognisably the same hue. Worth adding as a `--color-secondary-text` variant rather than bending the brand colour.

This matters more than it sounds. Status pills, badges, and small meta labels are exactly where a low-contrast accent gets used by reflex, and they are exactly the text a Team Leader squints at when scanning a queue.

### Semantic colours

The brand pair covers identity, not state. Status needs its own scale — task statuses run through eight values (`OPEN` → `COMPLETED_NO_RESPONSE`) and rejection paths must be visually distinct from approval paths. Define these alongside the brand colours in `app/globals.css`:

- **Success / approved** — green
- **Warning / waiting** — amber
- **Danger / rejected** — red
- **Neutral / open** — grey
- **Info / in progress** — the primary blue works here

Keep every one of them at ≥3:1 against its background as a fill, and use text on top rather than colour alone to convey state. Colour-only status indicators fail for a meaningful share of users and are useless in a printed or screenshotted queue.

---

## 2. What `DESIGN.md` is for

`DESIGN.md` in the project root is a token extraction from **ClickUp's marketing site**. Treat it as loose structural inspiration, not as the design system.

**Why not as the system:**

- It describes a **brochure**, not an application. 80px display headlines, conic-gradient hero borders, "Trusted by" logo strips, stat callout cards. The components this build actually needs — dense table rows, status pills, form inputs, side nav, empty states, toasts — are barely covered.
- Its palette is ClickUp's (`#6647f0` violet). **Superseded** by `#4359A5` / `#5BC0DE` above.
- Adopting its shape wholesale means overriding shadcn/Radix defaults across radius, type scale and spacing, then maintaining that bespoke layer. That is real ongoing cost for a tool used by a dozen internal people.
- There is a modest but real awkwardness in closely copying the visual identity of the product you are replacing and may eventually sell against.

**What to take from it:**

- The **pill radius** on buttons and chips, if that look is wanted — it is a cheap, high-impact borrowing.
- **Plus Jakarta Sans** for headings with **Inter** for body, if Kurt likes it. Both are free and load fine.
- The **density instinct**. ClickUp's product UI is dense and information-first, and that is the right instinct for a queue-and-approval tool. Just derive it from their *app*, not their landing page.

**The base stays shadcn/ui on Radix**, themed with the brand colours in `app/globals.css` per the SIS house rules (Tailwind v4, no JS config). That keeps Ace and Kurt on components they already know and keeps this codebase legible to whoever inherits it.

---

## 3. Notification policy

**In-app inbox is the default. Email is reserved for boundaries.**

The reasoning is not aesthetic. Phase 4's entire value rests on a client opening an approval email and acting on it. If the same sending domain has been firing status-change notifications all week, the team filters it to a folder — and then the emails that matter get missed too. Email is a budget, and it should be spent where nothing else reaches the person.

### Email — only these

| Event | Recipient | Why email |
|---|---|---|
| Request submitted | Team Leader of the owning department | Crosses from a client into the team; nobody is watching the app yet |
| Request returned or rejected | Requester (client) | They have no account and no other channel |
| Task ready for client approval | Requester (client) | The Phase 4 gate. This is the one that must land |
| Approval reminders (×2) | Requester (client) | Before auto-complete fires |
| Feedback request | Requester (client) | Post-completion |
| Task assigned to you | PIC | Starts someone's work; missing it stalls the ticket |
| You are QA on a task now at `FOR_QA` | QA assignee | Same reason |
| Client decided (approved / rejected / auto-completed) | PIC, QA, TL | Closes the loop, and rejection means work resumes |

### In-app only — everything else

Status transitions, comments, `WAITING_FOR_INFO` toggles, edits at approval time, list changes. All of it lands in the inbox and the dashboard card, none of it sends mail.

### Rules

1. **One place to look.** Every emailed event also writes a `vizserve_pms_notifications` row. Email is a nudge toward the inbox, never a separate truth.
2. **Every email links to the exact record**, not to a dashboard the recipient then has to search.
3. **Make it configurable per type from the start** — a boolean column on the notification type, not a hardcoded `if`. Preferences will be asked for eventually, and retrofitting them into scattered send calls is tedious.
4. **Client email and internal email are different budgets.** A client who receives four emails about one request will stop reading them, and that breaks Phase 4.

---

## 4. Client scope at launch

**HFSE only.** `vizserve_pms_requests.requester_org` stays a plain text field — no controlled list, no per-entity routing, no per-entity branding.

Revisit if ISA, GEG, or an external client comes into scope. That is also the moment the deferred multi-tenancy question (Q3) stops being hypothetical.
