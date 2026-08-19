-- ---------------------------------------------------------------------------
-- P7-24 — a form must never file its requests into ANOTHER form's inbox.
--
-- THE BUG, as reported: "I accepted a test client request as TL, it created a
-- list inside Client Requests, but when I open that list the task isn't there."
--
-- What was actually true in the live database:
--
--   form  "Test Client Request"  (50a9231e)
--     its own inbox list         "Test Client Request"  (fc265c63)  ← EMPTY
--     its default_list_id        "Testing ni Sir ace"   (5688d29b)  ← another
--                                                                    form's inbox
--   task  "Blog Post"            filed into 5688d29b
--
-- So the list was correctly named, correctly filed in Client Requests, and
-- permanently empty, while every approved request went somewhere else. Nothing
-- on any screen said so, which is what made it take an afternoon to find.
--
-- WHY IT HAPPENED. `vizserve_pms_ensure_form_list` (P7-18) ends with:
--
--   update vizserve_pms_forms
--      set default_list_id = v_list
--    where id = p_form_id and default_list_id is null;
--
-- `and default_list_id is null` is deliberate and stays: a team leader who has
-- pointed a form at a list of their own choosing has made a decision, and no
-- migration is entitled to overrule it. But it has a hole. If the default
-- ALREADY pointed at another form's inbox list, the trigger created this form's
-- list and then never pointed the form at it.
--
-- THE RULE THIS ADDS, and it is narrow on purpose:
--
--   pointing a form at an ORDINARY list        — a real choice, left alone
--   pointing a form at ANOTHER FORM'S inbox    — never intentional, repaired
--
-- A form's inbox list is created by trigger, named after that form, and carries
-- `form_id`. Two forms sharing one cannot be what anybody meant: the second
-- form's own inbox sits empty forever while its work lands under the first
-- form's name.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_ensure_form_list(p_form_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form   record;
  v_folder uuid;
  v_list   uuid;
  v_name   text;
begin
  select id, name, department_id, reference_prefix into v_form
    from vizserve_pms_forms
   where id = p_form_id;

  -- A form with no department cannot route yet (p1_01:29-31 blocks activation
  -- for exactly this reason), so there is nowhere to put its list. The trigger
  -- fires again when a department is set.
  if v_form is null or v_form.department_id is null then
    return null;
  end if;

  v_folder := vizserve_pms_ensure_client_folder(v_form.department_id);

  select id into v_list from vizserve_pms_lists where form_id = p_form_id;

  if v_list is null then
    -- Lists are unique on (department_id, name) and form names are not unique,
    -- so a collision is a question of when. The reference prefix disambiguates
    -- and is already the thing clients quote, which makes it the least
    -- surprising suffix available.
    v_name := v_form.name;

    if exists (
      select 1 from vizserve_pms_lists
       where department_id = v_form.department_id and name = v_name
    ) then
      v_name := v_form.name || ' (' || v_form.reference_prefix || ')';
    end if;

    insert into vizserve_pms_lists (department_id, name, description, group_id, form_id, sort_order)
    values (
      v_form.department_id,
      v_name,
      'Requests submitted through the ' || v_form.name || ' form.',
      v_folder,
      p_form_id,
      0
    )
    returning id into v_list;
  end if;

  -- ---- P7-24: the second arm of the update -------------------------------
  --
  -- Unchanged first arm: an unset default is filled in.
  --
  -- New second arm: a default pointing at a list that belongs to a DIFFERENT
  -- form is repaired. `l.form_id is not null` is what keeps this narrow — an
  -- ordinary project list has a null `form_id` and is never touched, so a lead
  -- who deliberately routes a form into "VizServe Website" keeps that routing.
  update vizserve_pms_forms f
     set default_list_id = v_list
   where f.id = p_form_id
     and (
       f.default_list_id is null
       or exists (
         select 1
           from vizserve_pms_lists l
          where l.id = f.default_list_id
            and l.form_id is not null
            and l.form_id <> p_form_id
       )
     );

  return v_list;
end;
$$;

-- Unchanged, but DROP took nothing here — `create or replace` on the same
-- signature keeps the grant. Restated only so a hand-applied paste that ran
-- against a database missing the grant still ends up correct.
grant execute on function vizserve_pms_ensure_form_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The one-time repair.
--
-- The function above only runs when a form is inserted or updated, so without
-- this the live misrouting stays until somebody happens to edit the form. This
-- is the same rule expressed as a single statement over the existing rows.
--
-- Deliberately NOT touching forms whose default is null: those are handled by
-- the trigger the next time the form is saved, and a form with no department
-- has no list to point at yet.
-- ---------------------------------------------------------------------------
update vizserve_pms_forms f
   set default_list_id = own.id
  from vizserve_pms_lists own
 where own.form_id = f.id
   and f.default_list_id is distinct from own.id
   and exists (
     select 1
       from vizserve_pms_lists wrong
      where wrong.id = f.default_list_id
        and wrong.form_id is not null
        and wrong.form_id <> f.id
   );

comment on function vizserve_pms_ensure_form_list(uuid) is
  'P7-18, repaired by P7-24. Creates the form''s inbox list in its department''s '
  'Client Requests folder and points forms.default_list_id at it — when unset, '
  'and when it wrongly points at a different form''s inbox. A form routed to an '
  'ordinary project list is left alone: that is a decision, not a mistake.';
