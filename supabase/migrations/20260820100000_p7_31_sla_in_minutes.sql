-- ---------------------------------------------------------------------------
-- P7-31 — the SLA stops being a whole number of days.
--
-- THE ASK, from the meeting: express the SLA the way ClickUp does, `8d / 8h /
-- 8m`, so a form whose work turns around in half a day can say so. D21 permits
-- exactly this — the SHAPE of a feature people already know, never its data.
--
-- WHY THIS IS CHEAP. `sla_days` feeds nothing. It is written in form settings,
-- selected into two page queries, and never once used in a calculation. The
-- task's deadline comes from the client instead:
--
--     v_due := coalesce(p_approved_target_date, v_request.target_date)
--     (p7_23:167)
--
-- and `sla_started_at` is stamped at submission and never read. So no function,
-- policy, view or trigger references this column, and changing its unit cannot
-- break anything downstream. That will stop being true the day the SLA grows
-- teeth; this migration is the cheap moment to do it.
--
-- 1d IS 480 MINUTES, NOT 1440. A working day, not a calendar one — which is
-- what "five days" has always meant on this field. 480 is already the working
-- day this schema assumes: D24 caps overtime at 960 because that is exactly
-- `1440 - 480`. So the default 5 becomes 2400, not 7200.
--
-- The ceiling stays in zod (365 working days) rather than moving into a CHECK,
-- so this constraint keeps the same shape it had as `sla_days_positive` — a
-- rename, not a redefinition.
--
-- NOT IN SCOPE, deliberately:
--   * `client_approval_days` keeps whole business days. It is live, the hourly
--     Gate 3 cron enforces it through vizserve_pms_add_business_days, and hours
--     there would need working-HOURS arithmetic (workday start/end, lunch)
--     rather than the business-DAY calendar that already exists.
--   * the SLA still does nothing. Notation only. Whether it grows a clock, a
--     breach state, or a line on the Gate 1 review panel is a separate decision.
--   * it stays invisible to the client. vizserve_pms_get_public_form does not
--     return it and a test locks that shut — "Department, SLA and author are
--     internal. A public endpoint that leaks the org chart is a small thing
--     that compounds."
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_forms
  rename column sla_days to sla_minutes;

-- Renamed rather than dropped and re-added: the constraint's definition follows
-- the column automatically, and a drop/add would leave the table briefly
-- unguarded for no gain.
alter table vizserve_pms_forms
  rename constraint vizserve_pms_forms_sla_days_positive
                 to vizserve_pms_forms_sla_minutes_positive;

-- Existing rows still hold days. Convert before the new default lands, so a row
-- written mid-migration cannot pick up 2400 and then be multiplied again.
update vizserve_pms_forms
   set sla_minutes = sla_minutes * 480;

alter table vizserve_pms_forms
  alter column sla_minutes set default 2400;

comment on column vizserve_pms_forms.sla_minutes is
  'Turnaround standard for this form''s work, in minutes. 1 day = 480 minutes '
  '(a WORKING day, matching D24''s 1440-480 overtime cap). Parsed from and '
  'rendered as 8d/8h/8m by lib/schemas/duration.ts. Internal only — never '
  'returned by vizserve_pms_get_public_form. Nothing consumes it yet.';
