-- ---------------------------------------------------------------------------
-- P7-45 — a leave type can apply to one gender.
--
-- Amier, 25 Aug 2026: a man should not be offered Maternity Leave, Special Leave
-- for Women or VAWC leave; a woman should not be offered Paternity Leave. All
-- four are statutory entitlements with a statutory eligibility, so this is not
-- the app inventing a rule — it is the app stopping people filing something that
-- would be refused anyway.
--
-- A COLUMN ON THE TYPE, NOT A CONDITION IN CODE, for the third time in this
-- schema and for the reason P7-12 gave: a leave type is POLICY DATA. Which
-- entitlements attach to whom changes when the statutes change, and a rule
-- written as `if code in ('MATERNITY', 'SPECIAL_WOMEN', 'VAWC')` would be
-- scattered across the picker, the allocation panel and the audit report, and
-- would go stale in three places on the day HR adds a tenth type.
--
-- NULL MEANS EVERYONE, and that is the default — Vacation, Sick, Service
-- Incentive, Birthday and Solo Parent are not gendered. Only the four that carry
-- a statutory eligibility get a value, and Solo Parent deliberately does not:
-- RA 8972 covers solo parents of either sex.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_leave_types
  add column applies_to_gender vizserve_pms_gender;

comment on column vizserve_pms_leave_types.applies_to_gender is
  'P7-45. NULL means the type applies to everyone, which is the default and the '
  'common case. A value restricts it, and is enforced by '
  'vizserve_pms_leave_type_applies_check on insert as well as filtered in the UI.';

-- Amier's four. Matched on `code` rather than id, because `code` is the stable
-- identifier — the same reason nothing in this app joins on `label` (P7-12).
update vizserve_pms_leave_types
   set applies_to_gender = 'FEMALE'
 where code in ('MATERNITY', 'SPECIAL_WOMEN', 'VAWC');

update vizserve_pms_leave_types
   set applies_to_gender = 'MALE'
 where code = 'PATERNITY';

-- ---------------------------------------------------------------------------
-- The enforcement.
--
-- A TRIGGER, NOT AN EDIT TO `vizserve_pms_submit_internal_request`, and the
-- choice is deliberate on two counts.
--
--   1. That function is 150 lines that P7-39 has just rewritten. Reproducing it
--      here to add six lines to its LEAVE branch means hand-copying a body
--      somebody else is still working on, and the merge that produced this file
--      already showed what that costs.
--   2. A trigger covers EVERY path into the table, not just the one function.
--      The seed script, a hand-run INSERT in the SQL editor and any future
--      submission function all pass through it.
--
-- It cannot be a CHECK constraint: the rule spans three tables — the request,
-- the type it points at and the requester's own row — and a CHECK may only look
-- at the row it is on.
--
-- BOTH NULLS PASS, and each for its own reason:
--
--   `applies_to_gender is null`  the type is not gendered. Nothing to check.
--   `gender is null`             the person's gender was never recorded (P7-32
--                                left the column nullable so the auth trigger
--                                could create rows). Refusing here would block
--                                somebody from filing leave because an ADMIN has
--                                not finished their profile, which punishes the
--                                wrong person for the wrong thing.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_type_applies_check()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_applies vizserve_pms_gender;
  v_gender  vizserve_pms_gender;
  v_label   text;
begin
  if new.request_type <> 'LEAVE' or new.leave_type_id is null then
    return new;
  end if;

  select lt.applies_to_gender, lt.label
    into v_applies, v_label
    from vizserve_pms_leave_types lt
   where lt.id = new.leave_type_id;

  if v_applies is null then
    return new;
  end if;

  select u.gender into v_gender
    from vizserve_pms_users u
   where u.id = new.requester_id;

  if v_gender is null or v_gender = v_applies then
    return new;
  end if;

  -- Names the type rather than the rule. "That leave type does not apply to
  -- you" reads as a system opinion about somebody; naming the entitlement makes
  -- it obvious that this is the statute and not the app.
  raise exception '% is not available to you.', v_label
    using errcode = 'check_violation';
end;
$$;

create trigger vizserve_pms_internal_requests_leave_type_applies
  before insert on vizserve_pms_internal_requests
  for each row execute function vizserve_pms_leave_type_applies_check();

-- ---------------------------------------------------------------------------
-- BEFORE INSERT ONLY, and not on UPDATE.
--
-- An UPDATE trigger would re-run this rule every time a lead approves or rejects
-- a request, which is the one moment it must not fire: a request filed before
-- somebody's gender was recorded, or before the statute changed, would suddenly
-- become undecidable and sit in the queue with an error nobody can clear. The
-- same reasoning P7-12 and P7-16 used for leaving their constraints NOT VALID —
-- enforce on the way in, leave history alone.
--
-- Nothing is backfilled or checked against existing rows for the same reason.
-- ---------------------------------------------------------------------------
