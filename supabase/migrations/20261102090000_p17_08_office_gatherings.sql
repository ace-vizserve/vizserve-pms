-- P17-08 — lunch and the all-hands are the same for everybody in the virtual
-- office (2 Nov 2026).
--
-- From 12:00 to 13:00 the office seats everyone who is in at the canteen, and on
-- Fridays from 16:00 to 17:00 in the all-hands room. But P17-07 withheld
-- everything about other departments from a member, so a member saw only their
-- own department there while a team leader saw the whole company — and, at the
-- all-hands, possibly a different presenter. Those rooms are shared spaces; the
-- closed department rooms are the private part.
--
--   * During those hours, a member now also gets the NAME of anybody who is in,
--     and `in_shared_room` true. Their room still draws closed, `visible` stays
--     false.
--   * The TIMES and leave stay withheld, whatever the hour. Somebody who is not
--     in stays a department and nothing more.
--
-- ⚠️ THE CLOCK IS CHECKED HERE, NOT ONLY IN THE APP. Outside those hours this
-- function does not send the names at all, so the rule cannot be bypassed by
-- changing a browser's clock. The hours match `officeActivity()` in
-- lib/office.ts; change one and change the other.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. Until it is
-- there the app reads `in_shared_room` as false, and a member sees only their
-- own department in those rooms, as before.

-- The return type changes, so the function has to be dropped, and the drop takes
-- its grants with it — they are restated at the bottom.
drop function if exists vizserve_pms_office_presence();

create function vizserve_pms_office_presence()
returns table (
  user_id         uuid,
  full_name       text,
  department_id   uuid,
  department_name text,
  time_in         timestamptz,
  time_out        timestamptz,
  open_since      timestamptz,
  on_leave        boolean,
  visible         boolean,
  in_shared_room  boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select u.id,
           u.primary_department_id,
           vizserve_pms_has_role('team_leader') as sees_all
      from vizserve_pms_users u
     where u.id = auth.uid()
       and vizserve_pms_current_role() is not null
  ),
  clock as (
    select (now() at time zone 'Asia/Manila') as manila
  ),
  today as (
    select manila::date as day,
           (manila::time >= time '12:00' and manila::time < time '13:00')
             or (extract(isodow from manila) = 5 and manila::time >= time '16:00' and manila::time < time '17:00')
             as gathering
      from clock
  )
  select p.id,
         case when v.visible or s.in_shared_room then p.full_name end,
         dept.id,
         dept.name,
         case when v.visible then t.time_in end,
         case when v.visible then t.time_out end,
         case when v.visible then y.time_in end,
         v.visible and exists (
           select 1
             from vizserve_pms_internal_requests r
            where r.requester_id = p.id
              and r.request_type = 'LEAVE'
              and r.status = 'APPROVED'
              and r.start_date <= today.day
              and r.end_date >= today.day
         ),
         v.visible,
         s.in_shared_room
    from me
    cross join today
    join vizserve_pms_users p
      on p.is_active
     and 'vizserve-pms' = any(p.app_access)
    -- ⚠️ COALESCE, AND IT IS NOT DECORATION — see the note in P17-07.
    cross join lateral (
      select coalesce(
        me.sees_all
        or p.id = me.id
        or (me.primary_department_id is not null and p.primary_department_id = me.primary_department_id),
        false
      ) as visible
    ) v
    left join vizserve_pms_departments dept
      on dept.id = p.primary_department_id
     and dept.is_active
     and not dept.is_shared
    left join vizserve_pms_dtr_entries t
      on t.user_id = p.id
     and t.work_date = today.day
    -- A shift still open from yesterday: somebody who forgot to time out, or
    -- who works across midnight. Either way the office draws them in.
    left join vizserve_pms_dtr_entries y
      on y.user_id = p.id
     and y.work_date = today.day - 1
     and y.time_in is not null
     and y.time_out is null
    -- "In" the way `officeStatus()` reads it: an open shift, today's or yesterday's.
    cross join lateral (
      select today.gathering
             and ((t.time_in is not null and t.time_out is null) or y.time_in is not null) as in_shared_room
    ) s
$$;

comment on function vizserve_pms_office_presence() is
  'P17-07, P17-08. Presence for the virtual office. Everyone for team leader and '
  'above; for anybody else, their own department in full and everyone else as a '
  'department only (name, times and leave withheld), except that during lunch '
  '(12:00-13:00 Manila) and the Friday all-hands (16:00-17:00) the name of '
  'anybody who is in comes back too, for the shared rooms. Never the times of '
  'another department, and never the DTR detail.';

revoke all on function vizserve_pms_office_presence() from public, anon;
grant execute on function vizserve_pms_office_presence() to authenticated;
