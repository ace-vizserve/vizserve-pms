-- import_02 — the Project Management System Portal list.
--
-- Second of six. See `20260825110000_import_01_vizbytes_folder.sql` for the
-- shape of the whole slice, the fixed-UUID scheme, and the D21 note.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, after 01.
--
-- ClickUp calls this level a List and so does this schema, so the mapping is a
-- straight one. The only thing that needs saying is what `form_id` is NOT:
--
--   P7-18 gave `vizserve_pms_lists` a `form_id`, set ONLY on the auto-created
--   inbox list for a client form, which must live in that department's reserved
--   "Client Requests" folder. This list is ordinary internal work with no form
--   behind it, so `form_id` stays null and the list sits in VIZSERVE.
--
-- That is not a detail — `vizserve_pms_lists_group_guard` enforces all three of
-- these on insert, and applying this file is what proves the guard agrees with
-- the mapping:
--
--   * a list must belong to the same department as its folder
--   * a form's inbox list may not leave the Client Requests folder
--   * an ordinary list may not enter it

do $$
declare
  v_dept  constant uuid := 'a1000000-0000-4000-8000-000000000001';  -- VizBytes
  v_group constant uuid := 'b1000000-0000-4000-8000-000000000001';  -- VIZSERVE, from 01
  v_list  constant uuid := 'b2000000-0000-4000-8000-000000000001';
  v_name  constant text := 'Project Management System Portal';
  v_pic         uuid;
  v_existing_id uuid;
begin
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null then
    raise notice 'import_02 SKIPPED — no active profile for ace.guevarra@vizserve.hfse.edu.sg.';
    return;
  end if;

  -- Ace exists, so 01 was not skipped for the same reason — which makes a
  -- missing folder an ordering mistake rather than a fresh environment.
  if not exists (
    select 1 from vizserve_pms_task_groups where id = v_group and department_id = v_dept
  ) then
    raise exception 'import_02: the VIZSERVE folder is missing. Apply import_01 first.'
      using errcode = 'no_data_found';
  end if;

  select id into v_existing_id
    from vizserve_pms_lists
   where department_id = v_dept and name = v_name;

  if v_existing_id is not null then
    -- Files 03–06 address this list by its FIXED id.
    if v_existing_id <> v_list then
      raise exception 'import_02: % already exists as % — expected %.',
        v_name, v_existing_id, v_list
        using errcode = 'unique_violation';
    end if;

    raise notice 'import_02 — list % already present. Nothing to do.', v_name;
    return;
  end if;

  insert into vizserve_pms_lists
    (id, department_id, group_id, form_id, name, description, is_active, sort_order, created_by)
  values
    (v_list, v_dept, v_group,
     null,                      -- ordinary internal work, not a form inbox
     v_name,
     'The build of this application. Imported from ClickUp.',
     true, 10, v_pic)
  on conflict (id) do nothing;

  raise notice 'import_02 — list % created as %.', v_name, v_list;
end $$;
