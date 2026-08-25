-- import_06 — the 2 ClickUp comments.
--
-- Last of six. See `20260825110000_import_01_vizbytes_folder.sql` for the shape
-- of the whole slice, the fixed-UUID scheme, and the D21 note.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, after 05.
--
-- Two comments in 24 tasks, both Kurt's, both a one-line pointer at a thing to
-- replicate. Small enough to be worth doing properly rather than dropping, and
-- that is the point of importing them at all: this is the file that proves the
-- comment path works before the full export, where the count is not two.
--
-- ⚠️ `vizserve_pms_task_comments_notify` IS AN AFTER-INSERT TRIGGER. It notifies
-- the PIC and the QA reviewer, never the author. Author is Kurt, PIC is Ace,
-- there is no QA — so this file writes EXACTLY TWO inbox notices, both to Ace.
-- No email: docs/12 seeds `commented` with `send_email = false`, because a
-- colleague adding a note to a shared task neither crosses a boundary nor blocks
-- anybody.
--
-- FOR THE FULL 3,877-ROW IMPORT THAT IS A NOTIFICATION STORM, and the trigger
-- must be disabled around the load (`alter table … disable trigger …`, restored
-- in the same transaction). Two is fine. Two thousand is an inbox nobody opens
-- again, which costs more than it saves.
--
-- TIMESTAMPS ARE THE CLICKUP ONES, not now(). A comment carries a date the way a
-- letter does; stamping all of them with the import time would turn a July
-- conversation into a August one and quietly destroy the only ordering the
-- thread has. `+08` is written into the literal — this is SQL doing the
-- conversion, so the no-date-library rule in CLAUDE.md is not in play.
--
-- `updated_at` is set equal to `created_at` rather than left to default. The
-- table's trigger is BEFORE UPDATE only, so an insert would otherwise leave it
-- at now() and every imported comment would read as edited on arrival.
--
-- BODIES ARE TRIMMED. The second ends with a newline in the export, and
-- `vizserve_pms_task_comments_body_present` is `length(btrim(body)) > 0` — so it
-- would pass either way. Trimming is for the reader, not the constraint.

do $$
declare
  v_list constant uuid := 'b2000000-0000-4000-8000-000000000001';  -- the list, from 02
  v_kurt      uuid;
  v_inserted  integer;
begin
  -- ClickUp records the author by ADDRESS in the comment payload, which is the
  -- one identifier that needs no override map — unlike the assignee columns,
  -- where "Kurt Steven Arciga" had to be translated to "Kurt Arciga" by email.
  select id into v_kurt
    from vizserve_pms_users
   where email = 'kurt.arciaga@vizserve.hfse.edu.sg' and is_active;

  if v_kurt is null then
    raise notice 'import_06 SKIPPED — no active profile for kurt.arciaga@vizserve.hfse.edu.sg.';
    return;
  end if;

  if (select count(*) from vizserve_pms_tasks where list_id = v_list) <> 24 then
    raise exception 'import_06: expected 24 tasks on the list. Apply import_03 and import_04 first.'
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_task_comments
    (id, task_id, author_id, body, created_at, updated_at)
  select v.id, v.task_id, v_kurt, v.body, v.at, v.at
  from (values
    -- on 'Attendance' (…023)
    ('d1000000-0000-4000-8000-000000000001'::uuid,
     'c1000000-0000-4000-8000-000000000023'::uuid,
     'replicate https://www.team.vizserve.com/',
     '2026-07-28 16:59:44+08'::timestamptz),
    -- on 'PMS (Click Up)' (…024)
    ('d1000000-0000-4000-8000-000000000002'::uuid,
     'c1000000-0000-4000-8000-000000000024'::uuid,
     'replicate https://app.clickup.com/',
     '2026-07-28 16:59:58+08'::timestamptz)
  ) as v (id, task_id, body, at)
  on conflict (id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'import_06 — % of 2 comments inserted (0 on a re-run). Expect % inbox notices for Ace.',
    v_inserted, v_inserted;
end $$;
