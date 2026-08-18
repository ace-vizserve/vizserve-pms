-- P7-10 — the shared leave calendar: who is out, without why.
--
-- THE PROBLEM THIS SOLVES
--
-- `vizserve_pms_internal_requests` is readable by the requester and by leads of
-- that department:
--
--   requester_id = auth.uid() or vizserve_pms_manages_department(department_id)
--
-- That is correct for the request itself — a leave request carries `reason`,
-- which is somebody's medical appointment or family emergency, and that is
-- nobody's business but theirs and the person deciding it. But it means an
-- "out of office" widget shows a member ONLY THEMSELVES, which is not a
-- calendar, it is a mirror. Everyone needs to know who is out; nobody needs to
-- know why.
--
-- RLS CANNOT EXPRESS THAT, and this is the whole reason for a function. A
-- policy grants or withholds a ROW; it has no column granularity. Any policy
-- permissive enough to show the dates would also show `reason`. Column-level
-- GRANTs are per-role, not per-policy, so they cannot say "this column to the
-- requester, not to everyone else" either.
--
-- So the safe columns are projected through a SECURITY DEFINER function, which
-- is the same shape the public form and the Gate 3 approval page already use to
-- reach data their caller has no direct privilege on.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN
--
--   reason          the private part, and the only reason this function exists
--   id              nothing may be looked up or acted on from a calendar cell
--   department_id   single-tenant; everyone shares one calendar
--   decision_reason a rejection note is between the requester and the approver
--
-- APPROVED ONLY, and that is a privacy rule rather than a display one. A
-- PENDING request is not yet a fact, and surfacing it would tell the whole
-- company that someone has ASKED for time off before their own team leader has
-- seen it — which is how people learn to stop filing requests in the system.
-- Your own pending leave still reaches you through the ordinary policy above,
-- so the widget can show it to you and to nobody else.
--
-- LEAVE ONLY. The other four internal request types are reimbursements,
-- overtime and the two time corrections. None of them means "this person is not
-- at work", so none belongs on a calendar of who is out.

create or replace function vizserve_pms_leave_calendar(
  p_from date,
  p_to   date
)
returns table (
  user_id    uuid,
  full_name  text,
  start_date date,
  end_date   date
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    r.requester_id as user_id,
    u.full_name,
    r.start_date,
    r.end_date
  from vizserve_pms_internal_requests r
  join vizserve_pms_users u on u.id = r.requester_id
  where r.request_type = 'LEAVE'
    and r.status = 'APPROVED'
    -- OVERLAP, not containment. Leave running 28 Aug – 3 Sep belongs on both
    -- months' calendars; `start_date between p_from and p_to` would drop it
    -- from September, where the person is actually away.
    and r.start_date <= p_to
    and r.end_date   >= p_from
    -- A deactivated account's history stays in the table and should stay out of
    -- next month's calendar.
    and u.is_active
  order by r.start_date, u.full_name;
$$;

-- SECURITY DEFINER runs as the owner, so anyone who can EXECUTE this reads
-- every approved leave row. That is the intent — it is an out-of-office
-- calendar — and it is why the function projects four columns rather than
-- `select *`. `anon` is not granted: this is staff-facing, and the client
-- surfaces have no business knowing who is on leave.
revoke all on function vizserve_pms_leave_calendar(date, date) from public, anon;
grant execute on function vizserve_pms_leave_calendar(date, date) to authenticated;

comment on function vizserve_pms_leave_calendar(date, date) is
  'P7-10. Approved LEAVE overlapping [p_from, p_to], for every active user, as '
  'name and dates only. SECURITY DEFINER because RLS cannot withhold a single '
  'column: the reason stays private, the absence does not.';
