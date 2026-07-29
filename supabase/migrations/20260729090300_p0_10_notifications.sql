-- P0-10 — Notification / inbox primitive.
--
-- Policy (docs/12-ui-and-notifications.md): the in-app inbox is the default and
-- email is reserved for boundaries. The reason is Phase 4 — if this domain
-- fires status noise all week, the approval email the whole build depends on
-- gets filtered.
--
-- Two structural consequences, both encoded here rather than in application
-- code:
--   1. Every emailed event ALSO writes a notification row. Email is a nudge
--      toward the inbox, never a separate truth.
--   2. Whether a type emails is a per-type SETTING from day one, not a
--      hardcoded `if`. Preferences get asked for eventually and retrofitting
--      them into scattered send calls is tedious.

create type vizserve_pms_notification_type as enum (
  'pending_approval',
  'assigned',
  'status_changed',
  'qa_requested',
  'client_decision'
);

-- The per-type email switch. One row per type, editable without a deploy.
create table vizserve_pms_notification_type_settings (
  type        vizserve_pms_notification_type primary key,
  send_email  boolean not null default false,
  description text not null default '',
  updated_at  timestamptz not null default now()
);

create trigger vizserve_pms_notification_type_settings_updated_at
  before update on vizserve_pms_notification_type_settings
  for each row execute function vizserve_pms_set_updated_at();

-- Defaults follow the email budget in docs/12 §3 exactly.
insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('pending_approval', true,  'Request submitted / awaiting your approval. Crosses from a client into the team.'),
  ('assigned',         true,  'Task assigned to you as PIC. Starts someone''s work; missing it stalls the ticket.'),
  ('qa_requested',     true,  'You are QA on a task that has reached FOR_QA.'),
  ('client_decision',  true,  'Client approved / rejected / auto-completed. Rejection means work resumes.'),
  ('status_changed',   false, 'Ordinary status movement. Inbox only — this is the noise that would poison Phase 4.');

create table vizserve_pms_notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references vizserve_pms_users (id) on delete cascade,
  type         vizserve_pms_notification_type not null,
  -- Denormalised from the settings table at write time so history stays honest:
  -- flipping the switch later must not rewrite what already happened.
  send_email   boolean not null default false,
  entity_type  text,
  entity_id    uuid,
  title        text not null,
  body         text not null default '',
  -- Every notification links to the exact record, never to a dashboard the
  -- recipient then has to search (docs/12 §3 rule 2).
  link_path    text,
  read_at      timestamptz,
  emailed_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index vizserve_pms_notifications_user_idx
  on vizserve_pms_notifications (user_id, created_at desc);
create index vizserve_pms_notifications_unread_idx
  on vizserve_pms_notifications (user_id) where read_at is null;

-- Single insert helper. Resolves send_email from the type settings so no call
-- site gets to decide, and returns the row so the caller can hand it to the
-- mailer without a second round trip.
create or replace function vizserve_pms_notify(
  p_user_id     uuid,
  p_type        vizserve_pms_notification_type,
  p_title       text,
  p_body        text default '',
  p_entity_type text default null,
  p_entity_id   uuid default null,
  p_link_path   text default null
)
returns vizserve_pms_notifications
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_send_email boolean;
  v_row vizserve_pms_notifications;
begin
  select s.send_email into v_send_email
    from vizserve_pms_notification_type_settings s
   where s.type = p_type;

  insert into vizserve_pms_notifications
    (user_id, type, send_email, title, body, entity_type, entity_id, link_path)
  values
    (p_user_id, p_type, coalesce(v_send_email, false), p_title, p_body,
     p_entity_type, p_entity_id, p_link_path)
  returning * into v_row;

  return v_row;
end;
$$;
