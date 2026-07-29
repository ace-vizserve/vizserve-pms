-- P1-02 — Requests and request attachments.

create type vizserve_pms_request_status as enum (
  -- DRAFT and SUBMITTED are unreachable in Phase 1 and that is deliberate:
  -- public submission is session-less, so there is nothing to save a draft
  -- against, and a request is pending review the instant it arrives. They stay
  -- in the enum because the canonical status set is fixed
  -- (docs/01-updated-workflow.md §3) and inventing variants later is worse than
  -- carrying two unused values.
  'DRAFT',
  'SUBMITTED',
  'PENDING_REVIEW',
  'APPROVED',
  'RETURNED',
  'REJECTED'
);

create table vizserve_pms_requests (
  id                    uuid primary key default gen_random_uuid(),
  form_id               uuid not null references vizserve_pms_forms (id) on delete restrict,
  reference_no          text not null unique,

  requester_name        text not null,
  -- The identity used at the Phase 4 client approval gate. Without this,
  -- "only the requestor may approve" is unenforceable, which is why it is
  -- mandatory on every public form and not editable by staff afterwards.
  requester_email       extensions.citext not null,
  requester_org         text not null default 'HFSE',

  title                 text not null,
  description           text not null,
  target_date           date,
  -- What the TL negotiated to. Kept SEPARATE from target_date on purpose: the
  -- negotiation feature is only measurable if both survive, and that delta is
  -- the metric proving Gate 1 is working rather than rubber-stamping.
  approved_target_date  date,

  -- Keyed by vizserve_pms_form_fields.field_key.
  field_values          jsonb not null default '{}'::jsonb,

  status                vizserve_pms_request_status not null default 'PENDING_REVIEW',
  decision_reason       text,
  reviewed_by           uuid references vizserve_pms_users (id) on delete set null,
  reviewed_at           timestamptz,

  sla_started_at        timestamptz,
  submitted_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint vizserve_pms_requests_field_values_is_object
    check (jsonb_typeof(field_values) = 'object'),
  -- Rejection is a last resort and returning is negotiation; both are useless
  -- to the requester without a reason. Enforced here, not just in the UI.
  constraint vizserve_pms_requests_decision_reason_required
    check (
      status not in ('RETURNED', 'REJECTED')
      or (decision_reason is not null and length(btrim(decision_reason)) > 0)
    )
);

create index vizserve_pms_requests_form_idx on vizserve_pms_requests (form_id);
create index vizserve_pms_requests_status_idx
  on vizserve_pms_requests (status, submitted_at desc);
create index vizserve_pms_requests_requester_email_idx
  on vizserve_pms_requests (requester_email);
create index vizserve_pms_requests_field_values_idx
  on vizserve_pms_requests using gin (field_values);

create trigger vizserve_pms_requests_updated_at
  before update on vizserve_pms_requests
  for each row execute function vizserve_pms_set_updated_at();

-- Now that requests exist, the R5 guards can be attached.
create trigger vizserve_pms_form_fields_protect
  before update or delete on vizserve_pms_form_fields
  for each row execute function vizserve_pms_form_field_protect();

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
create table vizserve_pms_request_attachments (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references vizserve_pms_requests (id) on delete cascade,
  -- Which form field this file answered, when it answered one.
  field_key    text,
  storage_path text not null,
  filename     text not null,
  mime_type    text not null,
  size_bytes   bigint not null,
  -- Null when uploaded by a client, who has no account by design.
  uploaded_by  uuid references vizserve_pms_users (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint vizserve_pms_request_attachments_size_positive check (size_bytes > 0)
);

create index vizserve_pms_request_attachments_request_idx
  on vizserve_pms_request_attachments (request_id);

-- ---------------------------------------------------------------------------
-- P1-10 — Reference numbers.
--
-- <PREFIX>-<YEAR>-<SEQ>, sequential per form per year, no gaps. A Postgres
-- SEQUENCE would be concurrency-safe but leaves holes on rollback, and a client
-- quoting "COL-2026-0142" to a colleague who sees 0141 then 0143 asks why.
-- The upsert below takes a row lock per (form, year), which is the right
-- granularity: two forms never contend, and submissions to one form are not
-- frequent enough for the lock to matter.
-- ---------------------------------------------------------------------------
create table vizserve_pms_reference_counters (
  form_id    uuid not null references vizserve_pms_forms (id) on delete cascade,
  year       integer not null,
  last_value integer not null default 0,
  primary key (form_id, year)
);

create or replace function vizserve_pms_next_reference_no(p_form_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prefix text;
  v_year   integer := extract(year from (now() at time zone 'Asia/Manila'))::integer;
  v_next   integer;
begin
  select reference_prefix into v_prefix
    from vizserve_pms_forms
   where id = p_form_id;

  if v_prefix is null then
    raise exception 'Unknown form %', p_form_id using errcode = 'foreign_key_violation';
  end if;

  insert into vizserve_pms_reference_counters (form_id, year, last_value)
  values (p_form_id, v_year, 1)
  on conflict (form_id, year)
    do update set last_value = vizserve_pms_reference_counters.last_value + 1
  returning last_value into v_next;

  return v_prefix || '-' || v_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;
