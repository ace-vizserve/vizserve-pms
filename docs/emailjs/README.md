# EmailJS template

One template — [`template.html`](template.html) — for every request email: the
staff notification, the requester's acknowledgement, and every later status
change. Kept here because EmailJS stores it in a web UI and nowhere else.

**Paste `template.html` into the Content tab** (Edit Content → code view).

## Settings

| Field | Value |
|---|---|
| Subject | `{{reference_no}} — {{status_label}}` |
| To Email | `{{to_email}}` |
| From Name | `VizServe PMS` |
| Reply To | `{{reply_to}}` |

**`To Email` is a variable, and that is what makes one template enough.** The
caller decides who receives it, so the same markup serves a staff notification
and a client update. Hardcode it and you need one template per recipient, and
they drift.

`Reply To` is a variable for the same reason: staff mail should reply to the
client, client mail should reply to a monitored mailbox. Point both at the
client and a client's question about their own request arrives back at
themselves.

## Variables

Every one must be a key in the object passed to `emailjs.send()`. **EmailJS
renders a missing variable as empty, never as an error** — so a typo ships as a
blank row in a client's email and nothing says why. Always pass a fallback:
`target_date: request.target_date ?? "Not specified"`.

| Variable | Example |
|---|---|
| `to_email` | who receives it |
| `reply_to` | where a reply should go |
| `intro` | one sentence at the top — differs per send, see below |
| `status_label` | `Received` · `Approved and under way` |
| `status_note` | what it means, or the Team Leader's reason |
| `reference_no` | `VB-2026-0042` — the client's only handle on the request |
| `requester_name` | `Maria Santos` |
| `requester_email` | `maria@hfse.edu.sg` |
| `requester_org` | `HFSE` (`D13` — plain text, HFSE is the only client at launch) |
| `title` | `Quarterly newsletter layout` |
| `description` | the brief. Line breaks survive — the cell is `white-space: pre-wrap` |
| `form_name` | `Design Request` |
| `target_date` | the date the client **asked for**, not one anybody agreed to |
| `submitted_at` | format it yourself; EmailJS does no date formatting |
| `status_url` | P7-51 tracking page. **Optional** — see the section block below |
| `progress_title` | `Progress so far`, or `""` when there is no trail to head |
| `timeline` | **An array**, not a string — the progress trail. See below |

### The progress trail

`timeline` is the only non-string variable, and the only loop:

```html
{{#timeline}}  …a row using {{label}}, {{detail}} and {{at}}…  {{/timeline}}
```

Inside the block those three resolve against **each item**, not the top-level
bag. It repeats once per stage and renders nothing when the array is empty, so
it needs no guard — `progress_title` carries the heading precisely because a
heading inside the loop would repeat once per stage.

⚠️ **The wording is mirrored from `vizserve_pms_get_request_status`**
(`20260825150000_p7_51_request_status_page.sql`), which is the source of truth —
it is what `/status/[token]` renders. An email and a page describing the same
stage in different words is how a client ends up asking which one is right.
`tests/unit/emailjs-template.test.ts` pins both sides.

### The one conditional block

`status_url` is the only variable the template guards:

```html
{{#status_url}}  …the "Track this request" button…  {{/status_url}}
```

`{{#var}}…{{/var}}` is EmailJS's section syntax: the block renders only when the
variable is truthy, and **an empty string is not truthy**. That is why
`lib/emailjs.ts` passes `status_url: ""` rather than omitting the key — both
behave the same, and passing the empty string keeps the params bag one shape.

Without the guard the button ships as a full-size blue call to action with
`href=""`. A dead CTA in a client's inbox is worse than no button, and nothing
in EmailJS warns you: an unresolved variable is an empty string, never an error.

### ⚠️ Never write `{{…}}` inside an HTML comment in `template.html`

**An HTML comment is not a template comment.** EmailJS parses the whole file, so
a section marker written in a comment *as an example* opens a real block — and
everything down to the next matching close tag is swallowed. It cost the entire
progress trail once already. Describe the syntax in prose; the test suite fails
the build if a `{{` reappears in a comment.

`{{like_this}}` is HTML-escaped by EmailJS, so a description containing `<` is
safe. Do not switch to `{{{triple}}}` — that disables escaping and lets a
submitted brief inject markup into an email going to your own staff.

## What to send, when

### On submission — two sends, one template

```js
const base = {
  reference_no: result.reference_no,
  requester_name: values.requester_name,
  requester_email: values.requester_email,
  requester_org: values.requester_org || "HFSE",
  title: values.title,
  description: values.description,
  form_name: form.name,
  target_date: values.target_date || "Not specified",
  submitted_at: new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
};

// 1. the team
await emailjs.send(SERVICE, TEMPLATE, {
  ...base,
  to_email: "kurt.vizserve@gmail.com, ace.guevarra@vizserve.hfse.edu.sg",
  reply_to: values.requester_email,
  intro: `${values.requester_name} submitted a request. It is in the queue waiting for a Team Leader.`,
  status_label: "New request",
  status_note: "Nobody has picked this up yet.",
}, { publicKey: PUBLIC_KEY });

// 2. the requester
await emailjs.send(SERVICE, TEMPLATE, {
  ...base,
  to_email: values.requester_email,
  reply_to: "hello@vizserve.com",
  intro: `Hi ${values.requester_name.split(" ")[0]}, thanks for sending this through.`,
  status_label: "Received",
  status_note:
    "It has reached the team and somebody will review it shortly. You do not need to do anything else for now.",
}, { publicKey: PUBLIC_KEY });
```

That second send is what prevents the duplicate submission: a client who hears
nothing assumes the form failed and sends the same job again the next day.

### On a status change — one send

`status_label` is a **human phrase, never the enum**. The client has never seen
your status values, and a screaming-caps token in a subject line reads as a
system error.

| Status | `status_label` | `status_note` |
|---|---|---|
| APPROVED | Approved and under way | A designer has picked this up. We will let you know as soon as there is something to review. |
| RETURNED | We need a bit more before we start | the Team Leader's reason, verbatim |
| REJECTED | We are not able to take this on | the reason, verbatim |
| COMPLETED | Completed | what was delivered and where to find it |

## Keys

```
VITE_EMAILJS_PUBLIC_KEY=...     # not a credential; safe in a bundle
VITE_EMAILJS_SERVICE_ID=...     # not a credential
VITE_EMAILJS_TEMPLATE_ID=...    # not a credential
EMAILJS_PRIVATE_KEY=...         # ⚠️ IS a credential. No prefix, server only.
```

The first three keep Vite's prefix, which means nothing to Next and is exactly
why they were safe to hand to a browser back when the browser did the sending.
The private key never was, and the missing prefix is the guard: `lib/email/config.ts`
is `server-only`, so nothing can read it from a component that ships.

### ⚠️ Setting the keys is necessary but NOT sufficient

EmailJS **disables API requests from non-browser applications by default**. Turn
them on in the dashboard under **Account → Security**, or every server-side send
is rejected and nothing arrives.

The REST endpoint is also rate-limited to **one request per second**. The
adapter serialises sends behind that limit itself, so a cron sweep of several
reminders cannot trip it — do not add a second throttle at a call site.

## The status-change send cannot come from the browser — and no longer does

Submission emails were fine client-side: the requester is on the page, so a
browser is open and it is theirs.

A status change is not. It happens when a Team Leader clicks Approve, or when
the Phase 4 auto-complete cron runs overnight. Fired from the browser:

- nothing sends if the Team Leader closes the tab first,
- nothing sends **at all** for the cron, because no browser is involved,
- your service and template IDs are readable in view-source, and the public key
  permits sending.

**P8-10 fixed this.** Every send is now server-side, through one port with two
adapters:

```
sendEmail({ to, subject, body })            lib/email/send.ts   ← the port
  ├─ EmailBody → renderEmail() → HTML       transports/resend.ts
  └─ EmailBody → template params → REST     transports/emailjs.ts
```

`lib/emailjs-client.ts` and `lib/emailjs.ts` are **gone**, along with the
`@emailjs/browser` dependency and the two browser sends in `public-form.tsx` and
`review-panel.tsx` — which, once the server path was live, would have delivered
two of each to a real client.

### Switching to Resend later

Set `EMAIL_TRANSPORT=resend` and supply `RESEND_API_KEY` + `EMAIL_FROM`. Nothing
else changes: no call site names a transport, and both adapters render the same
seven emails from the same `EmailBody`. That property is the whole reason the
template below is generic rather than request-shaped.

⚠️ `NEXT_PUBLIC_SITE_URL` is transport-independent and still required. Without
it `appUrl()` falls back to `http://localhost:3177`, so the Gate 3 approval
button is a dead link in a real inbox. On Vercel, `VERCEL_URL` covers it.
