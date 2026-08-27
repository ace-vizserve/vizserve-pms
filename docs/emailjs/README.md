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

Browser-readable keys need the **`NEXT_PUBLIC_` prefix** in Next.js. The
`VITE_EMAILJS_*` entries in `.env` use Vite's prefix and are invisible here —
leftovers from another project.

```
NEXT_PUBLIC_EMAILJS_PUBLIC_KEY=...
NEXT_PUBLIC_EMAILJS_SERVICE_ID=...
NEXT_PUBLIC_EMAILJS_TEMPLATE_ID=...
```

## ⚠️ The status-change send cannot come from the browser

Submission emails are fine client-side — the requester is on the page, so a
browser is open and it is theirs.

A status change is not. It happens when a Team Leader clicks Approve, or when
the Phase 4 auto-complete cron runs overnight. Fired from the browser:

- nothing sends if the Team Leader closes the tab first,
- nothing sends **at all** for the cron, because no browser is involved,
- your service and template IDs are readable in view-source, and the public key
  permits sending.

Call EmailJS's REST API from a server action with the private key, or use the
Resend outbox already in `lib/email/` — it retries, cannot roll back the
approval it reports on, and refuses to deliver to `@example.com` so a QA run
cannot mail a real client.
