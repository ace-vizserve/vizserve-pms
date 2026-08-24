-- ---------------------------------------------------------------------------
-- P7-37 — the settings table this app has never had.
--
-- P7-36 gives people a scheduled start. The question it immediately raises is
-- how far past it counts as late, and the answer is policy, not code: five
-- minutes today, three next quarter, and whoever decides that should not need a
-- deploy to say so. `vizserve_pms_notification_type_settings` already
-- established the shape — a table the admin UI writes and the app reads on
-- every request — and this is the second thing that wants it.
--
-- A SINGLETON ROW WITH TYPED COLUMNS, not a key/value bag. The bag is the
-- obvious generic answer and it is wrong for this codebase: `value jsonb` moves
-- the default, the type and the legal range out of the database and into
-- whichever TypeScript reader happens to parse it, and there is never a second
-- reader to disagree with because there is only ever one. CLAUDE.md's "rules
-- live in the database, not just the UI" lands on this side, and so does P7-12's
-- enum-versus-table argument. The cost is one `alter table add column` per new
-- setting, which is what this repo already does for every new fact — `gender`,
-- `overtime_minutes`, `leave_type_id`, `start_half`. The one honest argument for
-- key/value, that a new setting needs no migration, is false here: a new setting
-- always needs a reader, a form field and a zod member anyway. The migration is
-- not the expensive part.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor. After P7-36.
-- ---------------------------------------------------------------------------

create table vizserve_pms_app_settings (
  -- The singleton key. `check (id)` admits exactly one value, so a second
  -- INSERT collides on the primary key rather than quietly creating a second
  -- truth that half the app reads and the other half does not.
  id boolean primary key default true check (id),

  -- How far either side of a scheduled time a punch may land before the DTR
  -- treats it as a deviation. Applies to BOTH ends — a grace that forgives
  -- arriving five minutes late but not leaving five minutes early is two
  -- policies wearing one name, and nobody could explain which was in force.
  --
  -- Zero is legal and means exact. The 120 ceiling is not a policy claim, it is
  -- a typo guard: 480 in this column silently switches lateness off for the
  -- whole company, and a fat-fingered zero on the end should be refused rather
  -- than obeyed.
  grace_minutes integer not null default 5,

  updated_at timestamptz not null default now(),
  updated_by uuid references vizserve_pms_users (id) on delete set null,

  constraint vizserve_pms_app_settings_grace_range
    check (grace_minutes >= 0 and grace_minutes <= 120)
);

comment on table vizserve_pms_app_settings is
  'P7-37. One row, always. Company-wide settings an admin changes without a '
  'deploy. Add a setting as a typed column, never as a key/value pair.';

create trigger vizserve_pms_app_settings_updated_at
  before update on vizserve_pms_app_settings
  for each row execute function vizserve_pms_set_updated_at();

-- ⚠️ THE ROW IS SEEDED HERE, and this line is not housekeeping. Without it the
-- reader's `.single()` returns PGRST116 and the grace period is not five — it is
-- an error page on /dtr, /dashboard and /, which are the three screens that read
-- it. `on conflict do nothing` because this file is pasted by hand and a
-- half-applied paste gets re-pasted.
insert into vizserve_pms_app_settings (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- ⚠️ `enable row level security` IS LOAD-BEARING AND ITS ABSENCE IS SILENT.
--
-- This is the inverse of the usual failure in this repo. 20260729110000_p0_06_
-- grants.sql sets ALTER DEFAULT PRIVILEGES granting select/insert/update/delete
-- on later tables to `authenticated`, so this table arrives with full DML
-- already granted to every signed-in user. RLS is the only thing between a
-- member and `update vizserve_pms_app_settings set grace_minutes = 480`.
--
-- Omit the line below and nothing anywhere raises. The feature works, the admin
-- form works, and any member can rewrite company policy. There is no "permission
-- denied" to go looking for, because grants are not the missing gate this time.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_app_settings enable row level security;
revoke all on vizserve_pms_app_settings from anon;

create policy "app settings readable by active users"
  on vizserve_pms_app_settings for select to authenticated
  using (vizserve_pms_current_role() is not null);

-- ---------------------------------------------------------------------------
-- SEPARATE INSERT AND UPDATE POLICIES, deliberately NOT the `for all` that
-- vizserve_pms_notification_type_settings uses.
--
-- `for all` includes DELETE, and a deleted row here is not a degraded state, it
-- is an outage: the grace period becomes unknown and the three screens that read
-- it stop rendering. The notification settings table has the same hole and gets
-- away with it because vizserve_pms_notify wraps its lookup in
-- `coalesce(v_send_email, false)` (p0_10:89-96) — a missing row there degrades
-- to "no email", which is quiet but survivable. There is no equivalent safe
-- default for a policy number, and inventing one in TypeScript would put the
-- default in two places.
--
-- Writing it as two policies rather than a delete-blocking trigger follows the
-- idiom already in this schema: vizserve_pms_dtr_entries and
-- vizserve_pms_internal_requests both restrict by declaring FEWER policies, not
-- by adding guards. No DELETE policy exists, so no DELETE is possible, by
-- anyone, including an admin.
-- ---------------------------------------------------------------------------
create policy "app settings insertable by admin"
  on vizserve_pms_app_settings for insert to authenticated
  with check (vizserve_pms_is_admin());

create policy "app settings updatable by admin"
  on vizserve_pms_app_settings for update to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- No explicit table grant: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- this one inherits. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one, and the next person to see it should not have
-- to rediscover that.

-- ---------------------------------------------------------------------------
-- NO SECURITY DEFINER READER FUNCTION, on purpose. Nothing in SQL needs this
-- value: lateness is computed on read, in TypeScript, from a timestamptz and a
-- wall-clock `time`. Adding vizserve_pms_grace_minutes() now would be a function
-- with no caller, and the first caller is the one that should decide its shape.
--
-- A PER-USER OVERRIDE LATER IS CHEAP and this shape does not block it: add
-- vizserve_pms_users.grace_minutes and read coalesce(u.grace_minutes,
-- s.grace_minutes). Recorded so nobody argues for key/value on the grounds that
-- typed columns cannot flex.
-- ---------------------------------------------------------------------------
