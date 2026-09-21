-- P8-18 — a mention reaches you, a comment does not.
--
-- `mentioned` shipped with `send_email = false` (20260917090100, P7-71), under
-- the same reasoning as `commented`: docs/12 §3 spends the email budget on
-- boundaries, and a mailbox copy of every remark on a shared task is the
-- fastest way to teach people to filter this system into a folder they never
-- open.
--
-- A MENTION IS THE OTHER CASE, and the distinction is the whole argument.
-- `commented` fires for everyone already on the task — it is discussion, and
-- discussion is not an interruption. A mention fires because somebody typed
-- your name, which they do when they are waiting on YOU. That is the same test
-- docs/12 applies to an assignment or a QA hand-off, both of which email.
--
-- It sends from `notifications@`, not `approvals@`: nothing is being decided.
--
-- ⚠️ `commented` STAYS OFF. If this ends up feeling like noise, the fault will
-- be mentions being typed where a plain comment would do — a people problem
-- with a per-user preference as its fix (`vizserve_pms_user_preferences`, still
-- owed a notification section) — not a reason to email every comment as well.
--
-- Reversible in one statement, from the same table, with no deploy:
--   update vizserve_pms_notification_type_settings
--      set send_email = false where type = 'mentioned';
-- ---------------------------------------------------------------------------

update vizserve_pms_notification_type_settings
   set send_email = true,
       description = 'Somebody named you in a comment with @. Emailed: a mention '
                     || 'is addressed to you, unlike `commented`, which is discussion '
                     || 'among everyone already on the task.',
       updated_at = now()
 where type = 'mentioned';

-- The row is seeded by 20260917090100, so a miss here means that migration did
-- not run — which would leave `vizserve_pms_notify` resolving `send_email` to
-- `coalesce(null, false)` and silently emailing nobody. Worth failing loudly at
-- migration time rather than discovering it when a mention goes unanswered.
do $$
begin
  if not exists (
    select 1 from vizserve_pms_notification_type_settings where type = 'mentioned'
  ) then
    raise exception
      'vizserve_pms_notification_type_settings has no row for `mentioned` — 20260917090100 has not run';
  end if;
end;
$$;
