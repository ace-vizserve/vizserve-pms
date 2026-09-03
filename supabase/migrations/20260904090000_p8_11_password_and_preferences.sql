-- ---------------------------------------------------------------------------
-- P8-11 / P8-12 — the person's own settings.
--
-- Two facts this schema has never held, and they arrive together because they
-- land on the same new screen:
--
--   1. `must_change_password` — whether this account is holding a credential
--      somebody else chose. Email password reset is withdrawn (P8-11): an owner
--      sets a temporary password and hands it over, and this flag is what stops
--      that being the end of the story.
--   2. `vizserve_pms_user_preferences` — the FIRST per-user preference row in
--      this product. docs/12-ui-and-notifications.md §3 rule 3 predicted it
--      ("preferences will be asked for eventually"); P8-12's clock-in and
--      clock-out reminders are the first thing that needs one.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor. After P8-01c.
--
-- ⚠️ THE CODE SHIPS BEFORE THIS IS PASTED, as always in this repo. Both readers
-- are written to degrade rather than deny in that window — `loadUserPreferences`
-- falls back to the defaults restated below, and `loadMustChangePassword`
-- answers false — so the app works, unimproved, until this runs. Nothing here
-- may become load-bearing for signing in.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The forced-change flag.
--
-- FALSE IS THE SAFE DEFAULT AND THE HONEST ONE. Every account that exists when
-- this runs chose its own password through the reset email that is being
-- removed, so none of them is holding a handed-over credential. Defaulting to
-- true would lock the entire company out behind a screen they did not need.
--
-- NOT self-writable: it appears in no policy `with check` below, and
-- `vizserve_pms_users` has no self-update policy at all — the two writers are
-- `setTemporaryPassword` and `changeOwnPassword`, both through the service role.
-- A person who could clear their own flag could keep the temporary password.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column if not exists must_change_password boolean not null default false;

comment on column vizserve_pms_users.must_change_password is
  'P8-11. True while the account holds a password an owner chose. '
  'requireAuthContext sends the holder to /change-password until they clear it.';

-- ---------------------------------------------------------------------------
-- 2. Per-user preferences.
--
-- TYPED COLUMNS, NOT A JSONB BAG, for exactly the reasons
-- 20260824130000_p7_37_app_settings.sql sets out at length: a `value jsonb`
-- moves the default, the type and the legal range out of the database and into
-- whichever TypeScript reader happens to parse it. The cost is one
-- `alter table add column` per preference, which is what this repo already does
-- for every new fact.
--
-- ONE ROW PER PERSON, AND MOST PEOPLE WILL NEVER HAVE ONE. There is no backfill
-- and no trigger creating rows alongside accounts: a missing row means "the
-- defaults", exactly as a missing `app_settings` row does. That keeps the table
-- proportional to the people who actually changed something, and it means this
-- migration cannot fail partway through a backfill on a live database.
-- ---------------------------------------------------------------------------
create table if not exists vizserve_pms_user_preferences (
  user_id uuid primary key references vizserve_pms_users (id) on delete cascade,

  -- P8-12. Which of the two reminders this person wants. Both default ON, which
  -- is a real decision rather than a shrug: a reminder nobody switched on is a
  -- reminder nobody discovers, and the whole point is to catch the punch you
  -- were about to forget. Switching one off is one click on /settings.
  clock_in_reminder  boolean not null default true,
  clock_out_reminder boolean not null default true,

  -- How far ahead of the scheduled time to fire. The default matches what was
  -- asked for.
  --
  -- The bounds are a typo guard, not a policy claim — the same reasoning as
  -- `grace_minutes`' 120 ceiling. Zero is excluded because a reminder that
  -- fires AT the scheduled minute is not a reminder, it is a report; 120 is
  -- excluded above because a two-hour warning about a shift is noise.
  reminder_lead_minutes integer not null default 15,

  -- 'default' is public/assets/default_ringtone.mp3, shipped with the app.
  -- 'custom' means `custom_sound_path` names an object in the `user-sounds`
  -- bucket. The CHECK below is what stops 'custom' with nothing to play.
  sound_key text not null default 'default',
  custom_sound_path text,

  -- Percent. Applied to HTMLMediaElement.volume, which is 0..1, so the reader
  -- divides. Stored as an integer because a slider emits integers and a float
  -- column invites 0.7000000000000001 in the audit of a settings change.
  sound_volume integer not null default 70,

  updated_at timestamptz not null default now(),

  constraint vizserve_pms_user_preferences_lead_range
    check (reminder_lead_minutes >= 1 and reminder_lead_minutes <= 120),

  constraint vizserve_pms_user_preferences_volume_range
    check (sound_volume >= 0 and sound_volume <= 100),

  constraint vizserve_pms_user_preferences_sound_key
    check (sound_key in ('default', 'custom')),

  -- ⚠️ THE PAIR CONSTRAINT. 'custom' with a null path is a silent no-sound
  -- reminder that looks configured, which is the worst of both. And a path left
  -- behind after switching back to 'default' is an object nothing will ever
  -- delete — the upload action removes the previous object on swap, and this
  -- constraint is what makes "there is no previous object" checkable.
  constraint vizserve_pms_user_preferences_custom_needs_path
    check (
      (sound_key = 'custom' and custom_sound_path is not null)
      or (sound_key = 'default' and custom_sound_path is null)
    )
);

comment on table vizserve_pms_user_preferences is
  'P8-12. One optional row per person. A MISSING ROW MEANS THE DEFAULTS — there '
  'is no backfill and no create trigger, and lib/preferences.ts restates every '
  'default above. If those ever drift, the migration wins.';

create trigger vizserve_pms_user_preferences_updated_at
  before update on vizserve_pms_user_preferences
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- ⚠️ `enable row level security` IS LOAD-BEARING AND ITS ABSENCE IS SILENT.
--
-- Same trap as P7-37: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES granting full DML on later tables to `authenticated`, so this
-- table arrives with every signed-in user already able to write it. Without the
-- line below, one person could rewrite another's preferences and nothing
-- anywhere would raise — there is no "permission denied" to go looking for,
-- because grants are not the missing gate this time.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_user_preferences enable row level security;
revoke all on vizserve_pms_user_preferences from anon;

-- YOUR OWN ROW, IN ALL THREE DIRECTIONS. No lead, HR or owner branch anywhere
-- below, and that is deliberate: a reminder sound is not a management concern,
-- and the only reason to read somebody else's would be to change it for them.
create policy "user preferences readable by owner"
  on vizserve_pms_user_preferences for select to authenticated
  using (user_id = auth.uid());

create policy "user preferences insertable by owner"
  on vizserve_pms_user_preferences for insert to authenticated
  with check (user_id = auth.uid());

create policy "user preferences updatable by owner"
  on vizserve_pms_user_preferences for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- NO DELETE POLICY, following the idiom this schema uses everywhere else:
-- restrict by declaring FEWER policies, not by adding guards. Deleting the row
-- is "go back to the defaults", and the settings form does that by writing the
-- defaults — which leaves the audit-visible `updated_at` intact rather than
-- erasing the fact that somebody chose them.

-- No explicit table grant: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- this one inherits. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one.

-- ---------------------------------------------------------------------------
-- 3. The bucket for uploaded sounds. PRIVATE.
--
-- ⚠️ A SEPARATE BUCKET, NOT A PREFIX INSIDE `request-attachments`, and the
-- reason is the allowlist rather than tidiness. That bucket's rules live in the
-- shared singleton `vizserve_pms_attachment_rules`, which the PUBLIC client form
-- reads — widening it to audio to let staff pick a ringtone would also let
-- anonymous submitters post audio through the public form. Two audiences, two
-- rule sets, two buckets.
--
-- No storage policy for `authenticated`, exactly as P1-09: uploads go through a
-- server action holding the service role, and playback is a short-lived signed
-- URL minted after the caller has been identified. Nothing reaches this bucket
-- with a user's own token.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('user-sounds', 'user-sounds', false)
on conflict (id) do nothing;
