-- P0-09 — Audit log primitive.
--
-- "One function, called from every mutation. Wire it now or it never gets
-- wired." Phase 1 already needs it (request created), Phase 2 depends on it for
-- the negotiation evidence, and Phase 4 for disputed auto-completes.

create table vizserve_pms_audit_logs (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  action       text not null,
  -- Null actor = the system: the Phase 4 auto-complete cron, or a client acting
  -- through a token with no account. Both are real and neither has a user row.
  actor_id     uuid references vizserve_pms_users (id) on delete set null,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

create index vizserve_pms_audit_logs_entity_idx
  on vizserve_pms_audit_logs (entity_type, entity_id, created_at desc);
create index vizserve_pms_audit_logs_actor_idx
  on vizserve_pms_audit_logs (actor_id, created_at desc);

-- Single write helper. SECURITY DEFINER so it can record an entry even where
-- the caller has no direct insert grant — the audit trail is not optional and
-- must not be defeatable by a narrow policy.
create or replace function vizserve_pms_write_audit_log(
  p_entity_type text,
  p_entity_id   uuid,
  p_action      text,
  p_actor_id    uuid default null,
  p_before      jsonb default null,
  p_after       jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  insert into vizserve_pms_audit_logs (entity_type, entity_id, action, actor_id, before, after)
  values (p_entity_type, p_entity_id, p_action, coalesce(p_actor_id, auth.uid()), p_before, p_after)
  returning id into v_id;

  return v_id;
end;
$$;
