-- P0-06 — Row Level Security for the Phase 0 tables.
--
-- RLS is the enforcement layer. The app is never the only thing checking scope
-- (docs/02-data-model.md §RLS strategy). A wrong-role query must return ZERO
-- ROWS, not an error — which is what a restrictive SELECT policy does by
-- construction, and is why the P0-12 scope tests assert on row counts.
--
-- `anon` gets nothing here. The only anonymous surfaces in this system are the
-- public form (P1-07) and the client approval page (Phase 4), and both go
-- through SECURITY DEFINER functions rather than table access.

alter table vizserve_pms_departments                enable row level security;
alter table vizserve_pms_users                      enable row level security;
alter table vizserve_pms_user_managed_departments   enable row level security;
alter table vizserve_pms_audit_logs                 enable row level security;
alter table vizserve_pms_notifications              enable row level security;
alter table vizserve_pms_notification_type_settings enable row level security;

revoke all on vizserve_pms_departments                from anon;
revoke all on vizserve_pms_users                      from anon;
revoke all on vizserve_pms_user_managed_departments   from anon;
revoke all on vizserve_pms_audit_logs                 from anon;
revoke all on vizserve_pms_notifications              from anon;
revoke all on vizserve_pms_notification_type_settings from anon;

-- ---------------------------------------------------------------------------
-- Departments — readable by anyone with an active profile (nav, form settings,
-- assignee pickers all need the list). Written by admins only.
-- ---------------------------------------------------------------------------
create policy "departments readable by active users"
  on vizserve_pms_departments for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "departments writable by admin"
  on vizserve_pms_departments for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Users — self, plus anyone in a department you manage, plus everything for an
-- admin. This is also what makes the Phase 2 PIC/QA pickers work without a
-- second, looser rule.
-- ---------------------------------------------------------------------------
create policy "users read own profile"
  on vizserve_pms_users for select to authenticated
  using (id = auth.uid());

create policy "users read managed departments"
  on vizserve_pms_users for select to authenticated
  using (vizserve_pms_manages_department(primary_department_id));

-- Admin CRUD is P0-04. Ordinary users do not edit their own row in Phase 0 —
-- role and department are exactly the fields that must not be self-serve, and
-- RLS cannot restrict an UPDATE to a single column.
create policy "users writable by admin"
  on vizserve_pms_users for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Managed departments
-- ---------------------------------------------------------------------------
create policy "managed departments read own"
  on vizserve_pms_user_managed_departments for select to authenticated
  using (user_id = auth.uid() or vizserve_pms_is_admin());

create policy "managed departments writable by admin"
  on vizserve_pms_user_managed_departments for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Audit logs — admin read only, and NO insert policy at all. Entries are
-- written exclusively through vizserve_pms_write_audit_log(), which is
-- SECURITY DEFINER. That means an actor cannot forge or suppress their own
-- trail by holding a table grant.
-- ---------------------------------------------------------------------------
create policy "audit logs readable by admin"
  on vizserve_pms_audit_logs for select to authenticated
  using (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Notifications — strictly your own inbox.
-- ---------------------------------------------------------------------------
create policy "notifications read own"
  on vizserve_pms_notifications for select to authenticated
  using (user_id = auth.uid());

-- Marking read. RLS has no column-level restriction, so this technically allows
-- editing the title of your own notification. That rewrites a message only you
-- can see, so the blast radius is your own inbox; writes that matter go through
-- vizserve_pms_notify().
create policy "notifications update own"
  on vizserve_pms_notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "notifications delete own"
  on vizserve_pms_notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Notification type settings — readable by all active users so the UI can show
-- which events email; only admins flip a switch.
-- ---------------------------------------------------------------------------
create policy "notification settings readable by active users"
  on vizserve_pms_notification_type_settings for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "notification settings writable by admin"
  on vizserve_pms_notification_type_settings for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());
