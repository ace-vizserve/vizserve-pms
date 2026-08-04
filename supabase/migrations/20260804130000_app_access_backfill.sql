-- App access gate (fix) — the backfill never ran.
--
-- 20260804120000 ended with:
--
--   update vizserve_pms_users set updated_at = updated_at;
--
-- …intending to fire the sync trigger for every existing user and populate the
-- `raw_app_meta_data` mirror. It fired for nobody.
--
-- The trigger is declared `after insert or update OF role, app_access,
-- is_active`, and a column-scoped trigger fires only when one of those columns
-- appears in the UPDATE's SET list — not when the row is merely written. The
-- backfill set `updated_at`, which is on no such list, so Postgres skipped it
-- silently and correctly.
--
-- Nothing was insecure: the gate reads `vizserve_pms_users`, so it worked from
-- the moment the column existed. What was empty was the JWT copy the proxy is
-- meant to lean on for a cheap redirect — a performance path, not a decision
-- path. Caught by the test asserting the mirror exists, which is exactly the
-- assertion that felt redundant while writing it.
--
-- Written against `auth.users` directly rather than by poking the trigger
-- again. A backfill whose correctness depends on trigger-firing semantics is
-- how this went wrong once already, and this way says plainly what it does.

update auth.users a
   set raw_app_meta_data =
         coalesce(a.raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object(
              'role', u.role::text,
              'app_access', to_jsonb(u.app_access),
              'is_active', u.is_active
            )
  from vizserve_pms_users u
 where u.id = a.id;

-- The user-writable display copy, kept in step for the same reason it exists at
-- all: the Supabase dashboard reads it, and a stale role there is a confusing
-- thing to look at while debugging something else.
update auth.users a
   set raw_user_meta_data =
         coalesce(a.raw_user_meta_data, '{}'::jsonb)
         || jsonb_build_object(
              'role', u.role::text,
              'app_access', to_jsonb(u.app_access)
            )
  from vizserve_pms_users u
 where u.id = a.id;
