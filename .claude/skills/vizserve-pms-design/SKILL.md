---
name: vizserve-pms-design
description: The design system of record for VizServe PMS — brand tokens, type/radius/elevation foundations, component rules, and testable WCAG 2.2 AA criteria. Use when building or changing any UI in this repo: pages, components, primitives, status pills, emails, or app/globals.css.
---

# VizServe PMS — Design System

## Mission

Implementation-ready UI guidance for **VizServe PMS**, the internal ops platform replacing ClickUp and Teams Approvals. Two audiences share one system: authenticated operators (member → team_leader → manager → admin) working queues all day, and unauthenticated clients who see exactly two screens (`/request/[slug]`, `/approve/[token]`) and must not need instructions.

This file is the authority. `DESIGN.md` is a token *extraction* that has been auto-replaced four times (ClickUp → Pinterest → Shadcn Fintech → Tarsi Web); read it as raw material, never as the system. Where they disagree, this file and `docs/12-ui-and-notifications.md` win.

---

## 1. Foundations

Everything lives in `app/globals.css`. **Tailwind v4, no `tailwind.config.*`.** Use semantic token names in components — never a raw hex, never a raw `oklch()`.

### 1.1 Brand — D11, confirmed by Q15 on 30 Jul 2026

| Token | Light | Dark | Role |
|---|---|---|---|
| `--brand` / `--primary` | `#4359A5` | `#8FA3E0` | The workhorse. Primary buttons, active nav, links, focus rings |
| `--brand-foreground` / `--primary-foreground` | `#FFFFFF` | `#1A2340` | Text on brand |
| `--brand-tint` | `#5BC0DE` | `#5BC0DE` | **Surface only.** Fills, chips, highlight bars, chart series |
| `--brand-ink` | `#202020` | `#202020` | The only text colour permitted on `--brand-tint` |
| `--brand-surface` | `#4359A5` | `#4359A5` | Does **not** flip with theme — backs the white-only logo asset |
| `--brand-gradient` | `linear-gradient(135deg, #1C2547, #4359A5 55%, #2B3A6E)` | same | Full-bleed hero (sign-in) |
| `--accent` / `--accent-foreground` | `#EDF0F8` / `#4359A5` | `#1E2537` / `#8098DE` | Hover and selected surfaces — a brand tint, not grey |
| `--accent-border` | `#C6D0E9` | `#37405C` | The hairline on an accent-filled chip or tile |

**Ground and ink** — the 2026 refresh. A cool-grey ground rather than pure white, so a panel has something to sit on and a shadow has something to fall onto:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#F5F7FA` | `#12151C` | The page |
| `--card` / `--popover` | `#FFFFFF` | `#181C25` | Panels and overlays |
| `--muted` / `--secondary` | `#F0F3F7` | `#1E232E` | Raised and inset fills |
| `--track` | `#E7EBF1` | `#262C38` | Progress grooves, skeletons |
| `--border` | `#E3E7EE` | `#262C37` | The hairline |
| `--input` | `#D2D8E2` | `#333A47` | Field and control edges |
| `--border-strong` | `#B9C1CE` | `#454D5C` | A raised control's bottom edge |
| `--foreground` | `#0F1626` | `#EDF0F5` | Body copy |
| `--foreground-muted` | `#556074` | `#9AA4B6` | Secondary text — 6.25:1, body-safe |
| `--muted-foreground` | `#656F82` | `#8E98AA` | Tertiary text — 5.06:1, body-safe |
| `--foreground-faint` | `#818B9C` | `#6E7889` | **3.44:1 — NON-TEXT ONLY** |
| `--panel` | `rgb(255 255 255 / .82)` | `rgb(24 28 37 / .82)` | Frosted chrome; pair with `backdrop-blur-md` |

> **The `--foreground-faint` law.** It measures **3.44:1** on white and fails 4.5:1 in both themes. The design canvas used this value for hints, labels and table headers; we did not. It exists so the tertiary grey is available for decoration — dots, chevrons, rules, a null em-dash — without being reachable for text. Never put a word in it. `--muted-foreground` is the tertiary *text* colour.

**Measured contrast (WCAG 2.1; 4.5:1 normal text, 3:1 large text and UI boundaries):**

| Pair | Ratio | Verdict |
|---|---|---|
| `#4359A5` on white | 6.54:1 | pass both |
| White on `#4359A5` | 6.54:1 | pass both |
| `#5BC0DE` on white | **2.09:1** | fail both |
| White on `#5BC0DE` | **2.09:1** | fail both |
| `#202020` on `#5BC0DE` | 7.79:1 | pass both |
| `#4359A5` on `#5BC0DE` | 3.13:1 | fail normal, pass large/UI |
| `#4359A5` on `--accent` `#EDF0F8` | 5.74:1 | pass both |
| `#656F82` (`--muted-foreground`) on white | 5.06:1 | pass both |
| `#818B9C` (`--foreground-faint`) on white | **3.44:1** | fail normal — non-text only |
| `#277590` (`--info`) on `#E7F2F6` | 4.57:1 | pass both |

The full measured set, both themes, is recorded in `DESIGN.md`.

> **The `#5BC0DE` law.** It is a surface colour. It must carry `--brand-ink` and nothing else. It must never be used for body text, meta labels, links, or icons that convey meaning on a light background. This is where a low-contrast accent gets used by reflex — status pills and small meta labels — and it is exactly the text a Team Leader squints at scanning a queue.

**Deliberately neutral, do not tint:** `--foreground`, `--muted-foreground`, `--border`. Those are body copy and structure, not identity. Tinting them puts a blue cast on every table row and reads as a rendering fault.

### 1.2 Semantic status

Identity colours cannot carry state. Each status is a **triple** — a solid for text and the dot, a `-subtle` fill, and a `-border` hairline — because a chip needs all three to read as a lit object rather than a painted rectangle.

| Solid | Subtle | Border | Light solid | Dark solid | Meaning |
|---|---|---|---|---|---|
| `--success` | `--success-subtle` | `--success-border` | `#1C7A52` | `#4CB483` | Approved, completed |
| `--warning` | `--warning-subtle` | `--warning-border` | `#8A6206` | `#D8A94A` | Waiting, pending, awaiting review |
| `--info` | `--info-subtle` | `--info-border` | `#277590` | `#5FB6D2` | Returned, emailed, informational |
| `--destructive` | `--destructive-subtle` | `--destructive-border` | `#B3352C` | `#E0736A` | Rejected, failed |
| `--accent` | — | `--accent-border` | `#4359A5` fg | `#8098DE` fg | In progress, QA — the brand tint |
| `--muted` | — | `--border` | `--foreground-muted` | — | Open, draft, neutral, no-response |

Every solid must hold **4.5:1 as text on its own subtle fill** — measure it, do not assume. `--info` shipped as the canvas's `#2A7F9C` and measured **3.99:1** on `--info-subtle`; it was darkened along the same hue to `#277590` (**4.57:1**). It is text-legal, unlike `--brand-tint`, which it does **not** replace.

### 1.3 Type

The face is **Figtree**, loaded as a variable font in `app/layout.tsx` with no `weight` array — weight 450 is the body default and is not a static cut, so listing cuts would silently snap every screen to 400 or 500.

Base is set on `body` in `@layer base`: **16px / weight 450 / line-height 1.55 / `letter-spacing: -0.005em`**.

| Utility | Size | Use |
|---|---|---|
| `text-2xs` | 12px | Meta, timestamps, sidebar counts, section captions |
| `text-xs` | 13px | Hints, table headers, secondary labels |
| `text-sm` | 14px | Dense rows and compact controls |
| `text-base` | 16px | Body — the default, rarely written explicitly |
| `text-lg` | 18px | Card titles, section headings |
| `text-xl` | 24px | Page headings |
| `text-2xl` | 32px | Stat values, the largest in-app size |
| `text-3xl`+ | Tailwind default | Marketing and auth surfaces only |

> **Do not shrink this scale.** It was built at 13px (the design canvas's density) and then at 15px. Both read as tiny on a real screen — nav labels, meta rows and table cells all needed squinting at. 16px is where it landed after two rounds of that. If density is wanted, tighten padding, not type.

Retuning these tokens is how a type decision reaches ~30 pages without editing one of them. Change the scale; never add a size at a call site.

**Control scale**, which moves with the type:

| Control | Height |
|---|---|
| Button `default` / `sm` / `lg` / `xs` | **40** / 36 / 44 / 28 |
| Input, textarea, select trigger | **40** |
| Table header row | 40 |
| Sidebar nav row | 40 |
| Status chip | 28 |
| Icon tile (stat tile, row icon, avatar) | 32 |

Numbers in any column that changes must use `tabular-nums`.

**Families are a single swap point** — `--font-sans`, `--font-heading`, `--font-display`. Never name a family in a component. The family choice is deliberately open; only these three tokens change when it is settled.

### 1.4 Radius

`--radius: 0.625rem` (10px), giving sm=6 · md=8 · lg=10 · xl=14. The scale derives from it via `calc()` — **the vendored primitives assume the derived scale, so do not replace it with literals.** Panels are `rounded-lg`, controls `rounded-md`, chips `rounded-sm`.

`--radius-pill` (9999px) survives only for genuinely circular things — the status dot, an avatar. Status chips are **not** pills any more; see §4.1.

### 1.5 Elevation and depth

**Depth is outward only.** A *raised* thing carries a 1px highlight along its top edge (`--hl`), a graded face, and a shadow beneath. Everything else is **flat** — told apart by its fill and its border.

> **No inward emboss. Ever.** No carved fields, no sunken tracks, no pressed nav rows, no inset shadow of any kind. Things sit **on** the page, never in it. An inset control reads as damage on a light UI; it is what made the active sidebar row look stamped into the panel. `--well` and `--pressed` were removed from the system for this reason and must not be reintroduced.

| Plane | Means | Gets | Examples |
|---|---|---|---|
| **Raised** | act on it | `bg-raised` + `shadow-raised` | Buttons, panels, stat tiles, status chips, board cards, the segmented thumb, select triggers |
| **Flat** | everything else | a fill + a border, no shadow | Inputs, textareas, progress tracks, board columns, skeletons, the segmented track, empty-state wells, ghost and link buttons |

A button is told from an input by **having a lift at all** — not by the input being pushed in. That is the whole rule.

A press is the lift **collapsing** (`active:shadow-none`, plus the 1px nudge the button base class already carries), never the surface caving in.

Use the tokens; do not hand-roll shadows.

| Token | Use |
|---|---|
| `--shadow-ring` | Hairline boundary, where a real `border` cannot be used |
| `--shadow-raised` | Controls and small raised objects |
| `--shadow-raised-lg` | Panels, cards, stat tiles |
| `--shadow-raised-ring` | A raised element that also needs an explicit ring |
| `--shadow-overlay` | Popovers, dropdowns, dialogs, sheets |
| `--shadow-chrome` | The frosted sidebar and top bar |

Surface grades come from the `grade-surface` / `grade-raised` / `grade-chip` / `grade-primary` utilities, layered **over** a background colour (`bg-card grade-surface`) — never instead of one, so a surface keeps a valid solid colour if the gradient is unsupported.

> **They are named `grade-*` and must not be renamed into `bg-*`.** `cn()` is tailwind-merge, which treats every `bg-…` class as one conflicting property and keeps only the last. While they were `bg-surface` / `bg-raised` / `bg-chip`, writing `bg-card bg-surface` resolved to the grade alone and silently discarded the colour token on every panel, button, chip and icon tile — `bg-accent bg-chip` lost its accent fill outright. tailwind-merge does not recognise the `grade-` prefix, so both survive.

### 1.6 Width

**Page.** `PageShell` is **full width**, `p-5`, `gap-4`. Two capped versions were built and reverted: centring a 1440px cap opened a void between the sidebar and the page while the top bar still ran to the sidebar edge, and even left-aligned it left the page short of the viewport, which reads as the app failing to fill its own window.

> A table whose columns drift too far apart is a **table** problem — give that table column widths — not a reason to shrink every page. The timesheet grid shares itself out in percentages (34% task, 8% per day, 10% total) for exactly this reason. A page needing a reading measure still sets its own `max-w-*` in `className`; `cn` is tailwind-merge, so it replaces nothing and simply applies.

**Sidebar.** `SIDEBAR_WIDTH` is **19rem (304px)**. The canvas drew 216px; it was widened three times (216 → 256 → 272 → 304) as the type scale went up. Do not shrink it.

The panel is bracketed by two matching bordered, raised cards: the brand lockup at the top and the user menu at the bottom. Neither is a bare row.

**Top bar.** 56px (`h-14`), frosted `bg-panel` with `backdrop-blur-md` and `shadow-chrome`. Its horizontal padding matches `PageShell`, so the breadcrumb and the content it labels share a left edge.

**Bounding is a real `border` now, not a ring.** A ring cannot carry the inner highlight, so a ringed card has no way to read as lit. `ring-1 ring-foreground/10` has been removed from the codebase and must not come back.

### 1.7 Motion

`--default-transition-duration: 150ms` (instant), `--motion-duration-fast: 200ms`. Anything longer must justify itself. All motion must respect `prefers-reduced-motion` — see `components/marketing/scroll-link.tsx` for the pattern already in the repo.

---

## 2. Where a component comes from

**Never a bare HTML control.** Every interactive element uses the vendored primitive in `components/ui/`: `Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Dialog`, `Popover`, `DropdownMenu`, `Sheet`, `Tabs`, `Tooltip`, `Table`, `Card`, `Badge`, `Label`. A raw `<button>`, `<input>`, `<select>` or `<textarea>` in a page is a bug, not a shortcut.

This is not style policing. Those primitives carry the token wiring, the seven states, the focus ring, the `data-*` variants from `shadcn/tailwind.css`, and the Base UI keyboard and ARIA behaviour. A native control has none of it, so it ships with a browser-default focus ring, no dark mode, no disabled semantics, and — for `<select>` and `<dialog>` — an accessibility story that differs per browser.

**The order to reach for things:**

1. **An existing primitive in `components/ui/`.** Check first; there are 26 of them.
2. **An existing shared component in `components/`** — see the reuse table in §3. Most screens need nothing new.
3. **A new primitive built on `@base-ui/react`**, following the vendored pattern exactly (below).
4. **Only then** something hand-rolled, and only when Base UI genuinely has no equivalent.

**When you must build one**, copy the shape of the existing primitives rather than inventing a house style:

- Wrap the `@base-ui/react` part, do not reimplement it. It supplies focus trapping, roving tabindex, `aria-*`, typeahead and dismissal — all the parts that are invisible until they are missing.
- `cva` for variants and sizes; a `size` scale that matches §1.3's control heights.
- `data-slot="<name>"` on the root. The `.client-surface` rules and several call-site overrides key off `data-slot`, so a primitive without one cannot be targeted.
- `cn(...)` last, with `className` at the end so a caller can override.
- **Semantic tokens only** — never a raw hex, never `oklch()`, never a hand-written shadow. `shadow-raised` for a control, `shadow-overlay` for anything floating, a real `border` for the boundary.
- All seven states: default, hover, focus-visible, active, disabled, loading, error.
- Keep grade utilities out of the `bg-` namespace — see §1.5.

**A non-Base-UI dependency is a last resort**, and it inherits the same rules: wrap it in `components/ui/` with our variants, tokens and `data-slot`, so the rest of the app never imports it directly and it can be swapped without touching a page. Weigh it honestly first — `parse-duration` was rejected because it read `1:30` as 1.03ms and returned a number rather than an error, and the twenty-line parser it would have replaced was already tested.

### 2.1 Stack rules that will bite you

**These are the mistakes this codebase invites. Read them before adding a component.**

- **The primitives are `@base-ui/react`, not Radix.** `components.json` sets `"style": "base-nova"`. Composition uses `render={<Link/>}` slots, not `asChild`. **Running `npx shadcn add` against the default (Radix) registry will break the shell.**
- **`app/globals.css` imports `shadcn/tailwind.css` from `node_modules`.** It supplies around twenty `@custom-variant`s (`data-open`, `data-closed`, `data-checked`, `data-selected`, `data-disabled`, and so on) that the vendored components depend on. Removing that import silently unstyles every interactive state.
- **If it navigates, it is a link.** Do not write `<Button render={<Link/>}>` — Base UI's `Button` is a native `<button>` and warns that the semantics it promised are gone. Use `<Link className={buttonVariants({ variant, size })}>`. For an icon-only link, put `aria-label` on the link itself rather than an `sr-only` span.
- **`--brand-gradient` and any new non-colour token must be exposed in `@theme inline`** or it is reachable only from an inline `style`.
- **No date library.** `dayjs` / `date-fns` / `moment` are banned; use `lib/dates.ts`. It parses bare `YYYY-MM-DD` as **midday UTC** — midnight lands on the previous day in any negative offset.

---

## 3. Reuse before authoring

Check this table first. Most new screens need zero new components.

| Need | Use | Path |
|---|---|---|
| Page wrapper | `PageShell` | `components/page-shell.tsx` |
| Page heading | `PageHeader` — **but the breadcrumb is the page label on most screens**; only use this where the breadcrumb cannot carry the meaning | `components/page-shell.tsx` |
| Any table | `DataTable` + `Column<T>`, or `DataTableShell` for a hand-built one | `components/data-table.tsx` |
| Nothing to show | `EmptyState` | `components/empty-state.tsx` |
| A KPI number | `StatTile` — deliberately *not* a `Card` | `components/stat-tile.tsx` |
| A status | `RequestStatusBadge`, `TaskStatusBadge`, `InternalStatusBadge`, `InternalTypeBadge` | `components/status-badge.tsx` |
| Loading | `TableSkeleton`, `FilterBarSkeleton`, `StatRowSkeleton`, `CardSkeleton` | `components/skeletons.tsx` |
| Paging | `Pagination` + `resolvePage` / `resolvePageSize` / `pageWindow` | `components/pagination.tsx` |
| Logo | `BrandLockup` | `components/brand-lockup.tsx` |
| Nav data | `NAV_ITEMS` / `visibleNavItems` / `groupedNavItems` | `lib/navigation.ts` |

**Explicitly not in use:** TanStack Table and TanStack Query were removed from `package.json`. Do not reintroduce them.

---

## 4. Component rules

Every component must define all seven states: **default, hover, focus-visible, active, disabled, loading, error.** A component shipped without explicit state rules is incomplete.

### 4.1 Status pills

`components/status-badge.tsx` is **the only place a status maps to a colour.** A new status goes in its maps; it never gets a colour inline at a call site.

- The shared `PILL` constant is the shape, and the internal `Pill` component is the only thing that renders one. Every status in the app is `PILL` plus a tone from the `TONE` map.
- **It is a chip, not a pill.** 21px tall, `rounded-sm`, a hairline `border`, the `bg-chip` wash for a lit top edge, and a **leading 5px dot**. The old flat `rounded-full` fill made a neutral status nearly invisible on a white card — the label carried the state and the fill did nothing.
- **State is never conveyed by colour alone.** Every chip carries its label *and* its dot, so it survives greyscale, a screenshot, and a printed queue. The dot is `aria-hidden` — it duplicates the label for anyone reading the text.
- The label is human wording, not the enum. `PENDING_REVIEW` is a database value; "Awaiting review" is what a Team Leader reads. Labels come from `lib/schemas/*`, never restated locally.
- `COMPLETED` and `COMPLETED_NO_RESPONSE` **must render differently.** One means the client approved; the other means the clock ran out and nobody looked. Phase 6 reports that split, and a queue that renders them identically hides the thing worth reporting.
- Pills must be `shrink-0` and `whitespace-nowrap` — a wrapped pill in a table cell breaks the row rhythm.

### 4.2 Buttons

- Sizes: `xs`, `sm`, `default`, `lg` and the `icon-*` counterparts. Icon-only buttons require an accessible name.
- `loading` sets `aria-busy` and disables the button — the visual and the assistive-tech signal cannot drift apart. Any button that submits a form must use it; a spinner callers have to remember is a spinner that goes missing on the slow path, which is the only path where it matters.
- `disabled` must never be the sole explanation for why an action is unavailable. Pair it with visible text or a tooltip.
- Variant `default` uses plain `hover:` (not an `[a]:hover:` compound) so a caller's `className` override wins. Keep it that way.

### 4.3 Tables and dense surfaces

- Bound with the elevation ring token, never a raw `border`.
- Must scroll horizontally inside their own container — the page body must never scroll sideways.
- Long content truncates with `truncate` and keeps `min-w-0` on the flex parent; the full value must remain reachable (title attribute, detail page, or tooltip).
- Every table needs an `EmptyState`, and the copy must say *why* it is empty and what to do next. Most of ours are empty because a filter is too narrow or a form is unpublished — saying so is the difference between a dead end and a next step.
- Every list route needs a `loading.tsx` using the shared skeletons.

### 4.4 Forms

- Every input has a `<Label>` with `htmlFor`. Placeholders are never labels.
- Errors are text next to the field, plus `aria-invalid`. Never colour alone.
- **Validation is in the database too.** Required fields, the resolution gate, `field_key` immutability and the no-hard-delete guard are constraints and triggers. The front end will be bypassed; client validation is a convenience, not the rule.
- The zod schema in `lib/schemas/` is the contract between tracks and is agreed at the *start* of a phase.

### 4.5 Overlays

Dialog, popover, dropdown, sheet, tooltip all use `--shadow-overlay`. Focus must be trapped, `Escape` must close, and focus must return to the trigger. A dialog that can be dismissed must never be the only route to an action.

### 4.6 Client-facing surfaces (`/request/[slug]`, `/approve/[token]`, `/feedback/[token]`)

No session, no nav, no jargon. `BrandLockup` for identity, one clear primary action, and copy that assumes the reader has never seen the app. These carry the entire value of Gate 3.

---

## 5. Accessibility — testable criteria

Target **WCAG 2.2 AA**. Each of these is a pass/fail check, not a principle.

1. **Contrast** — body text at least 4.5:1; large text (18.66px bold or 24px) and UI boundaries at least 3:1. Every new colour pair is measured and recorded in `DESIGN.md`, not eyeballed.
2. **Focus** — `:focus-visible` is a 2px `--ring` outline at 2px offset, set globally in `@layer base`. It must never be removed, and it must be visible on muted *and* raised surfaces. Tab through sidebar, header, page, dialog and confirm the indicator is never lost.
3. **Keyboard** — every interactive element is reachable and operable by keyboard alone. Tab order follows visual order. No keyboard trap outside a modal.
4. **Names** — every icon-only control has an accessible name. Links carry it via `aria-label` on the link; buttons via `aria-label` or visible text.
5. **State without colour** — turn the screen greyscale. Every status, error, and selected state must still be identifiable.
6. **Live regions** — used only for genuinely live content. Static page content (`EmptyState`) must not be a live region; announcing it on every render interrupts a screen reader mid-task.
7. **Motion** — everything animated respects `prefers-reduced-motion`.
8. **Targets** — interactive targets at least 24 by 24 CSS px (WCAG 2.2 section 2.5.8), and at least 44px on the client-facing pages.
9. **Zoom and reflow** — usable at 200% zoom and at 390px width with no horizontal page scroll.
10. **Dark mode** — every rule above is re-checked in dark. `next-themes` with `attribute="class"`; both themes ship together or neither ships.

---

## 6. Content and tone

Concise, confident, implementation-focused. Say what happened and what to do next.

| Instead of | Write |
|---|---|
| "No results" | "No tasks match these filters. Clear them to see the full queue." |
| "Error" | "Could not save. The task moved to QA while you were editing — reload to see it." |
| "PENDING_REVIEW" | "Awaiting review" |
| "Submit" | "Send for approval" |
| "Are you sure?" | "Reject this request? The client is emailed and the request closes." |

Buttons name their action. Destructive confirmations state the consequence and who it reaches. Never expose an enum value, a table name, or a UUID to a user.

---

## 7. Anti-patterns — prohibited

- A raw hex or `oklch()` in a component. Tokens only.
- A bare `<button>`, `<input>`, `<select>` or `<textarea>` in a page. Use the primitive (§2).
- A grade utility named `bg-*` — tailwind-merge eats the colour beside it (§1.5).
- An inset shadow anywhere. Depth is outward only (§1.5).
- A new dependency for something twenty tested lines already do.
- `#5BC0DE` as text, or white on `#5BC0DE`.
- A hand-rolled status pill at a call site instead of `status-badge.tsx`.
- A hand-written `ring-1 ring-foreground/10` instead of the elevation token.
- A second copy of a map that already exists (`ROLE_LABELS`, `ROLE_ORDER`, and the five tone pairs have each been duplicated in this repo already — every one drifted).
- `<Button render={<Link/>}>` for navigation.
- A one-off spacing or type value because "this screen is special".
- Colour as the only carrier of state.
- Removing or hiding a focus indicator.
- A component with no empty state, no loading state, or no dark-mode check.
- Restating an RLS department filter in a query — the policy does it, and repeating it implies the policy is optional.

---

## 8. Authoring workflow

1. Restate the design intent in one sentence.
2. Confirm nothing in section 3 already does it.
3. Define foundations and tokens used — semantic names only.
4. Define anatomy, variants, and all seven states.
5. Add accessibility acceptance criteria from section 5, as pass/fail checks.
6. Note anti-patterns and any migration for existing call sites.
7. Finish with the QA checklist.

---

## 9. QA checklist

Run before calling any UI change done.

- [ ] `npm run verify` green (metadata guard + typecheck + lint + test).
- [ ] `PORT=3177 npm run dev` — **port 3000 is the HFSE SIS app, whose login page also says "Welcome back"**, so a smoke test on 3000 passes against the wrong application.
- [ ] Seen in **both themes**.
- [ ] Seen at **1280px and 390px**; no horizontal page scroll.
- [ ] All seven states exercised: default, hover, focus-visible, active, disabled, loading, error.
- [ ] Keyboard-only pass; focus never lost or invisible.
- [ ] Greyscale pass; no state readable by colour alone.
- [ ] Empty state present, and its copy says why and what next.
- [ ] `loading.tsx` present for the route.
- [ ] Long content: longest realistic title, longest department name, 3-digit counts.
- [ ] No new raw hex; `git grep` for `#4359A5`, `#5BC0DE`, `ring-foreground/10` shows no new hits.
- [ ] New colour pairs measured and recorded in `DESIGN.md`.
