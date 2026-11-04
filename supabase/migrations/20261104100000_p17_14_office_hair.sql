-- P17-14 — the virtual office draws hair from the staff record (4 Nov 2026).
--
-- The user asked for men's hair on men and long hair on women. The record already
-- says which: `vizserve_pms_users.gender` (P7-32), which the admin form requires
-- and which is NULL on any account nobody has saved since. Nothing here guesses
-- from a name, for the reason P7-32 gives.
--
--   * New column `long_hair`: true for FEMALE, false for MALE, null for not set.
--     Null keeps the hair everybody has today.
--   * It travels ONLY where the name already does. A desk in a closed room gets
--     neither. Anybody who can see the figure can see the hair, which is the point,
--     but this is the first time gender reaches other staff, so it is worth knowing.
--   * A boolean rather than the gender itself, because hair is all the office needs.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after 20261104090000. Never `db:push`. Safe
-- to paste twice. Until it is there the app reads `long_hair` as null, and hair
-- stays as it is.

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
  in_shared_room  boolean,
  roams           boolean,
  long_hair       boolean
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
         case when v.visible or s.in_shared_room or r.roams then p.full_name end,
         dept.id,
         dept.name,
         case when v.visible then t.time_in end,
         case when v.visible then t.time_out end,
         case when v.visible then y.time_in end,
         v.visible and l.on_leave,
         v.visible,
         s.in_shared_room,
         r.roams,
         case
           when v.visible or s.in_shared_room or r.roams then
             case p.gender when 'FEMALE' then true when 'MALE' then false end
         end
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
    cross join lateral (
      select exists (
        select 1
          from vizserve_pms_internal_requests lr
         where lr.requester_id = p.id
           and lr.request_type = 'LEAVE'
           and lr.status = 'APPROVED'
           and lr.start_date <= today.day
           and lr.end_date >= today.day
      ) as on_leave
    ) l
    -- P17-13. COALESCE for the same reason as `visible`: a NULL here would fail
    -- the zod read's meaning of the column, and the name case above.
    cross join lateral (
      select coalesce(
        not l.on_leave
        and (
          p.is_business_manager
          or exists (
            select 1
              from vizserve_pms_user_roles ur
             where ur.user_id = p.id
               and ur.role in ('manager', 'business_manager')
          )
        ),
        false
      ) as roams
    ) r
$$;

comment on function vizserve_pms_office_presence() is
  'P17-07, P17-08, P17-13, P17-14. Presence for the virtual office. Everyone for team leader '
  'and above; for anybody else, their own department in full and everyone else as a '
  'department only (name, times and leave withheld), except that during lunch '
  '(12:00-13:00 Manila) and the Friday all-hands (16:00-17:00) the name of '
  'anybody who is in comes back too, for the shared rooms, and the name of a '
  'Manager or Business Manager not on leave always does, because they walk the '
  'floor. long_hair goes with the name and is null without it. Never the times of '
  'another department, and never the DTR detail.';

revoke all on function vizserve_pms_office_presence() from public, anon;
grant execute on function vizserve_pms_office_presence() to authenticated;
