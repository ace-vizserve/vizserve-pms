-- ---------------------------------------------------------------------------
-- P7-25 — a lead may create a list inside Client Requests.
--
-- THE RULE, as Amier stated it: every client request is a task, and at approval
-- the TL/TM either adds it to an existing list or CREATES A LIST FOR IT. The
-- list is what separates one piece of client work from another.
--
-- P7-18 made that impossible. `vizserve_pms_lists_group_guard` refuses a
-- hand-made list in the reserved folder:
--
--   'The Client Requests folder holds one list per form, filled automatically.
--    Put this list in another folder.'
--
-- That was a defensible reading at the time — the folder was conceived as an
-- inbox, one list per form, entirely automatic. It is the wrong reading now. A
-- lead approving a website rebuild wants a list for it, and "client work" is
-- exactly the folder it belongs in. Sending them to another folder means client
-- work lives in two places and the folder named after it holds only the inbox.
--
-- WHAT THE FOLDER MEANS FROM HERE:
--
--   before  "one list per form, filled automatically"
--   after   "where client work lives — the per-form inboxes, plus any list a
--            lead made for a particular piece of client work"
--
-- WHAT DOES NOT CHANGE, and this is the half that must survive:
--
--   * a form's inbox list (`form_id` set) still CANNOT leave Client Requests,
--     and still cannot exist in any other folder. That is the guard's original
--     purpose and the reason `default_list_id` can be trusted.
--   * the folder itself still cannot be renamed, moved, archived while forms
--     file into it, deleted, or turned into an ordinary folder — all of that
--     lives in `vizserve_pms_task_groups_system_guard` and is untouched.
--   * one system folder per department, still enforced by the partial unique
--     index on (department_id) where is_system.
--
-- So the only thing being relaxed is: an ORDINARY list may now sit in the
-- reserved folder. Nothing that protects routing is loosened.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_lists_group_guard()
returns trigger
language plpgsql
as $$
declare
  v_group record;
begin
  if new.group_id is null then
    -- A folderless list is legal (ClickUp's own rule), but a form's inbox list
    -- is not allowed to become one — that is the "dragged out" case.
    if new.form_id is not null then
      raise exception 'A form''s list belongs in its department''s Client Requests folder and cannot be moved out of it.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select department_id, is_system, name into v_group
    from vizserve_pms_task_groups
   where id = new.group_id;

  if v_group is null then
    raise exception 'That folder does not exist.' using errcode = 'foreign_key_violation';
  end if;

  if v_group.department_id <> new.department_id then
    raise exception 'That folder belongs to another department.' using errcode = 'check_violation';
  end if;

  -- ---- P7-25: the clause that used to be here is GONE ---------------------
  --
  -- It read:
  --
  --   if v_group.is_system and new.form_id is null then
  --     raise exception 'The Client Requests folder holds one list per form,
  --                      filled automatically. Put this list in another folder.'
  --
  -- Removed deliberately, not overlooked. See the header: a lead creating a
  -- list for a particular piece of client work belongs in the client-work
  -- folder, and refusing that pushed client work into folders named after
  -- something else.

  -- UNCHANGED, and load-bearing. A form's inbox list must live in Client
  -- Requests and nowhere else — this is what lets `default_list_id`, the
  -- approval path and the sidebar all agree about where a form's work lands.
  if not v_group.is_system and new.form_id is not null then
    raise exception 'A form''s list belongs in its department''s Client Requests folder.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- The trigger is unchanged and is NOT recreated: `create or replace function`
-- keeps the existing binding, and dropping the trigger to re-add it identically
-- would open a window where the guard is not enforced at all.

comment on function vizserve_pms_lists_group_guard() is
  'P7-18, relaxed by P7-25. A form''s inbox list must stay in its department''s '
  'Client Requests folder; every list must sit in a folder of its own '
  'department. An ordinary list MAY now live in Client Requests — that is where '
  'a lead makes a list for a particular piece of client work.';
