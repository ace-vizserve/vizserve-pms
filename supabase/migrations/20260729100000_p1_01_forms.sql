-- P1-01 — Forms and form fields.
--
-- Forms are DYNAMIC (D20): VizServe builds them in the app and shares them by
-- public URL, so the field list is configuration, not schema. Two consequences
-- are encoded here rather than left as later cleanup, because R5 stops being
-- hypothetical the moment a form is designed to evolve:
--
--   * `field_key` is immutable once the form has a submission. Historical
--     `field_values` blobs are keyed to it; renaming the label must not follow.
--   * fields are SOFT-ARCHIVED via `is_active`, never hard-deleted while they
--     hold data.

create type vizserve_pms_field_type as enum (
  'text',
  'textarea',
  'date',
  'select',
  'multiselect',
  'file',
  'email',
  'number'
);

create table vizserve_pms_forms (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  description         text not null default '',
  -- Which Team Leader the request lands on. Null means the form cannot route,
  -- so publishing is blocked below until it is set.
  department_id       uuid references vizserve_pms_departments (id) on delete restrict,
  -- Drives the reference number: <PREFIX>-<YEAR>-<SEQ>, e.g. COL-2026-0142.
  -- Clients quote this in email, so it is short, upper-case and stable.
  reference_prefix    text not null,
  -- true for client forms, false for internal. The whole auth model hangs off
  -- this flag: a public form is reachable with no session at all.
  is_public           boolean not null default true,
  is_active           boolean not null default false,
  requires_attachment boolean not null default false,
  sla_days            integer not null default 5,
  created_by          uuid references vizserve_pms_users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint vizserve_pms_forms_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint vizserve_pms_forms_reference_prefix_format
    check (reference_prefix ~ '^[A-Z][A-Z0-9]{1,7}$'),
  constraint vizserve_pms_forms_sla_days_positive
    check (sla_days > 0),
  -- A live form with no department has nowhere to send its requests. Better to
  -- refuse activation than to collect submissions into a queue nobody owns.
  constraint vizserve_pms_forms_active_requires_department
    check (not is_active or department_id is not null)
);

create index vizserve_pms_forms_department_idx on vizserve_pms_forms (department_id);
create index vizserve_pms_forms_public_active_idx
  on vizserve_pms_forms (slug) where is_public and is_active;

create trigger vizserve_pms_forms_updated_at
  before update on vizserve_pms_forms
  for each row execute function vizserve_pms_set_updated_at();

create table vizserve_pms_form_fields (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references vizserve_pms_forms (id) on delete cascade,
  label       text not null,
  -- Stable key for task column mapping and for every historical field_values
  -- blob. Immutable after first submission — enforced by trigger below.
  field_key   text not null,
  field_type  vizserve_pms_field_type not null default 'text',
  help_text   text not null default '',
  -- Options for select / multiselect: ["Poster", "Banner", ...]
  options     jsonb not null default '[]'::jsonb,
  -- DEFAULTS TRUE. Staff must consciously make a field optional — layer 1 of
  -- the completeness rule (docs/02-data-model.md §Completeness).
  is_required boolean not null default true,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint vizserve_pms_form_fields_key_format
    check (field_key ~ '^[a-z][a-z0-9_]*$'),
  constraint vizserve_pms_form_fields_options_is_array
    check (jsonb_typeof(options) = 'array'),
  -- A select with no options is an unanswerable required question.
  constraint vizserve_pms_form_fields_select_has_options
    check (
      field_type not in ('select', 'multiselect')
      or jsonb_array_length(options) > 0
    ),
  unique (form_id, field_key)
);

create index vizserve_pms_form_fields_form_idx
  on vizserve_pms_form_fields (form_id, sort_order);

create trigger vizserve_pms_form_fields_updated_at
  before update on vizserve_pms_form_fields
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- R5 guards.
--
-- These are the difference between "forms are editable" and "editing a form
-- silently destroys history". Both are database-level because the form builder
-- will not be the only thing writing here forever.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_form_field_protect()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_has_data boolean;
begin
  select exists (
    select 1
      from vizserve_pms_requests r
     where r.form_id = coalesce(old.form_id, new.form_id)
       and r.field_values ? coalesce(old.field_key, new.field_key)
  ) into v_has_data;

  if tg_op = 'DELETE' then
    if v_has_data then
      raise exception
        'Field "%" has data on existing requests and cannot be deleted. Set is_active = false instead.',
        old.field_key
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and new.field_key is distinct from old.field_key and v_has_data then
    raise exception
      'field_key "%" is immutable once the form has submissions. Change the label instead.',
      old.field_key
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- Attached after vizserve_pms_requests exists (see the requests migration).
