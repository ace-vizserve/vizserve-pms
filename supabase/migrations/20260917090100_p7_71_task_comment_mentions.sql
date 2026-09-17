-- ---------------------------------------------------------------------------
-- P7-71 — `@` in a comment names somebody, and they hear about it.
--
-- P7-08 shipped the thread and wrote down what it was not: "No threads, no
-- replies, no reactions, no mentions." `comment-thread.tsx` records why this
-- one was held back — mentions "need a notification path and a scope question
-- about who may be mentioned". This file answers both.
--
-- THE SCOPE, IN AMIER'S WORDS (17 Sep): "if i am under vizbytes i can only
-- mention my team member, but if i am manager and admin role i can mention
-- everyone since i have access on each department".
--
-- So WHO MAY BE MENTIONED DEPENDS ON WHO IS DOING THE MENTIONING, and that one
-- sentence is the reason every function below carries an ACTOR. A plain member
-- reaches their own team; a lead reaches the departments they oversee; an admin
-- reaches everybody. On top of that, anybody in range of the TASK itself is
-- always available, whoever is typing — the PIC and the QA reviewer may sit
-- outside your department and they are the two people most likely to need
-- naming.
--
-- ⚠️ THE REACH IS BOUNDED BY WHAT THE ACTOR CAN ALREADY READ. Clause 5 of
-- `vizserve_pms_task_mention_candidates` mirrors the three general grants of the
-- `vizserve_pms_users` SELECT policy and goes no wider, so the picker discloses
-- no name its user could not already look up. See the full note on that
-- function, including what this does cost: somebody named through the actor's
-- reach may not be able to OPEN the task they were named on.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The ids a body names.
--
-- ⚠️ THE TWIN OF `taskImageIds` IN `lib/rich-text.ts`, AND FOR THE SAME REASON:
-- the markup is the only record of who was mentioned. There is no join table.
-- A mention is a `<span data-mention-id="…">` the sanitiser kept, so the body
-- IS the list, and this is how the database reads it.
--
-- ⚠️ THE PATTERN HERE AND THE ONE IN `lib/rich-text.ts` ARE ONE DECISION. The
-- editor writes the attribute, `sanitizeRichText` is the only thing that lets
-- it survive, and this reads it back. If you rename `data-mention-id`, rename
-- it in all three — the failure is silent and it looks like mentions simply not
-- notifying anybody.
--
-- A regex rather than a parse: this runs in a trigger, on a text column, with
-- no DOM. A uuid shape rather than `.+` so a hand-edited body cannot make this
-- cast throw and take the INSERT down with it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_mentioned_ids(p_body text)
returns setof uuid
language sql
immutable
as $fn$
  select distinct m[1]::uuid
    from regexp_matches(
           coalesce(p_body, ''),
           'data-mention-id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"',
           'gi'
         ) as m;
$fn$;

comment on function vizserve_pms_mentioned_ids(text) is
  'P7-71. The user ids a comment body names, read back out of the '
  'data-mention-id attributes the sanitiser kept. Twin of taskImageIds in '
  'lib/rich-text.ts: the markup is the only record of a mention.';

-- ---------------------------------------------------------------------------
-- Who ACTOR may mention on TASK. INTERNAL — no grants, deliberately.
--
-- ⚠️ IT TAKES THE ACTOR AS A PARAMETER RATHER THAN READING `auth.uid()`, and
-- that is what makes it usable twice. The picker asks it about the person
-- typing; the notify trigger asks it about `new.author_id`, which is the same
-- question asked later and possibly by a service-role insert with no session at
-- all. One definition, so the menu cannot offer a name the trigger would then
-- refuse to notify — and no `auth.uid()` inside means the trigger's answer does
-- not depend on how the comment got written.
--
-- ⚠️ AND BECAUSE IT ASKS ABOUT AN ARBITRARY ACTOR, NOBODY MAY CALL IT. Pointed
-- at somebody else it reports that person's reach, which is a way to enumerate
-- rosters. `revoke` below leaves it reachable only from the two SECURITY
-- DEFINER functions further down, which run as the owner: the wrapper, which
-- checks the caller is asking about themselves and can see the task, and the
-- trigger, which has no caller to check.
--
-- ---------------------------------------------------------------------------
-- THE RULE, IN AMIER'S WORDS (17 Sep): "if i am under vizbytes i can only
-- mention my team member, but if i am manager and admin role i can mention
-- everyone since i have access on each department".
--
-- So there are TWO ways onto this list, and they answer different questions.
--
-- A. IN RANGE OF THE TASK — clauses 1-4. Anybody who can already open the task,
--    regardless of who is doing the mentioning. This is the part that makes a
--    mention useful: the person can follow the link.
--
--      1. the PIC and the QA reviewer        `assignee_id` / `qa_assignee_id`
--      2. everybody else working on it       `vizserve_pms_task_assignees`
--      3. the task's own department          P11-03: the task is the
--                                            department's, not the PIC's
--      4. whoever manages that department    admins and owners always, a
--                                            team_leader-or-above with this
--                                            department in their managed set
--
-- B. WITHIN THE ACTOR'S REACH — clause 5. Anybody the ACTOR can already see,
--    which for a member is their own team and for an admin is everybody. This
--    is the half Amier is describing, and it is what lets a manager pull in
--    somebody from another department they oversee.
--
-- ⚠️ CLAUSE 5 MIRRORS THE `vizserve_pms_users` SELECT POLICY AND MUST NOT GO
-- WIDER THAN IT. Its three general grants are: your own department (p7_17),
-- any department you manage, and everything for an admin. Mirroring means the
-- picker discloses no name the actor could not already read, so the widening
-- costs nothing in identity terms. It is deliberately NARROWER than that policy
-- in one respect — the feature-specific widenings (HR scope p7_54, hand-overs
-- p9_08, relievers p11_11) are not mirrored, because none of them is about
-- being able to address somebody.
--
-- ⚠️ WHAT CLAUSE 5 DOES COST: a person mentioned through it may not be able to
-- OPEN the task. They get the inbox row — which carries the task title and the
-- first 200 characters of the comment — and the link 404s for them, because RLS
-- on `vizserve_pms_tasks` is untouched by any of this. That is the accepted
-- trade of the rule as stated: an admin who deliberately names somebody is
-- taken at their word. If a mention should GRANT access, that is a table of
-- mentions and a new clause on the task SELECT policy — the policy that caused
-- the statement-timeout outage in p12_04 — and it is its own decision.
--
-- Active people only on both halves, exactly as `users read own department` has
-- it: a leaver who keeps appearing in pickers is the bug that rule was written
-- against.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_mention_candidates(
  p_task_id  uuid,
  p_actor_id uuid
)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select u.id, u.full_name
    from vizserve_pms_users u
   where u.is_active
     and (
       -- A. in range of the task
       exists (
         select 1
           from vizserve_pms_tasks t
          where t.id = p_task_id
            and (
              -- 1. on the task by name
              u.id = t.assignee_id
              or u.id = t.qa_assignee_id

              -- 2. on the task by the join table (P7-13)
              or exists (
                select 1 from vizserve_pms_task_assignees a
                 where a.task_id = t.id and a.user_id = u.id
              )

              -- 3. in the task's department (P11-03)
              or (
                t.department_id is not null
                and u.primary_department_id = t.department_id
              )

              -- 4. managing the task's department. Spelled out rather than
              --    calling vizserve_pms_manages_department, which answers about
              --    `auth.uid()` and this asks about `u`.
              or u.role >= 'admin'
              or (
                u.role >= 'team_leader'
                and t.department_id is not null
                and exists (
                  select 1 from vizserve_pms_user_managed_departments md
                   where md.user_id = u.id
                     and md.department_id = t.department_id
                )
              )
            )
       )

       -- B. 5. within the actor's reach — the three general clauses of the
       --       users SELECT policy, asked about `p_actor_id` rather than about
       --       `auth.uid()`. An inactive actor reaches nobody, which is the
       --       same gate `vizserve_pms_current_role` applies.
       or exists (
         select 1
           from vizserve_pms_users actor
          where actor.id = p_actor_id
            and actor.is_active
            and (
              -- an admin or owner sees everybody, so may address everybody
              actor.role >= 'admin'

              -- your own team
              or (
                actor.primary_department_id is not null
                and u.primary_department_id = actor.primary_department_id
              )

              -- any department you lead or oversee
              or (
                actor.role >= 'team_leader'
                and exists (
                  select 1 from vizserve_pms_user_managed_departments md
                   where md.user_id = actor.id
                     and md.department_id = u.primary_department_id
                )
              )
            )
       )
     );
$fn$;

revoke all on function vizserve_pms_task_mention_candidates(uuid, uuid) from public, anon, authenticated;

comment on function vizserve_pms_task_mention_candidates(uuid, uuid) is
  'P7-71. Who p_actor_id may mention on p_task_id: anybody in range of the task, '
  'plus anybody within the actor''s own reach (own department, departments they '
  'manage, everybody for an admin). NO GRANTS -- it answers about an arbitrary '
  'actor, so it is reachable only from the definer wrapper that checks the '
  'caller, and from the notify trigger, which has no caller.';

-- ---------------------------------------------------------------------------
-- The picker's list. THE SAME SET, asked about the caller, once the caller has
-- proved they may see the task at all.
--
-- ⚠️ THE GUARD BELOW IS ABOUT THE TASK, NOT ABOUT THE REACH. It answers "may
-- you comment here at all" — an admin who cannot see a task has no business
-- getting a roster for it, whatever their reach would otherwise be. The reach
-- is applied inside the candidate function; these two are different questions
-- and collapsing them would let a task id be used to enumerate people.
--
-- ⚠️ THE GUARD IS A SUBSET OF THE TASK SELECT POLICY, CHOSEN OVER RESTATING IT.
-- That policy runs to sixty lines (p12_04) with a personal-list carve-out and a
-- reliever branch, and a second copy of it here would drift from the original
-- in a way nothing would catch. Three existing helpers instead:
--
--   `vizserve_pms_is_on_task`  covers PIC, QA, second assignees AND relievers
--   the department test        p7_17's clause, `not is_personal` and all
--   `vizserve_pms_manages_department`  the lead's clause
--
-- What it gives up against the real policy is a lead reaching a PERSONAL task
-- that happens to be on a timesheet. That task has one person on it and nobody
-- to mention, and the cost of the gap is an empty dropdown rather than a leak.
-- Narrow on purpose. Do not "fix" it by widening without reading p11_08.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_mentionable_for_task(p_task_id uuid)
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_task vizserve_pms_tasks;
begin
  select * into v_task from vizserve_pms_tasks t where t.id = p_task_id;
  if v_task.id is null then return; end if;

  if not (
    vizserve_pms_is_on_task(p_task_id, auth.uid())
    or (
      not v_task.is_personal
      and (
        vizserve_pms_manages_department(v_task.department_id)
        or v_task.department_id = vizserve_pms_my_department()
      )
    )
  ) then
    return;
  end if;

  return query
    -- The caller is the actor. There is no form of this that lets somebody ask
    -- about anybody else's reach — that is the whole reason the function below
    -- takes an actor and this one does not.
    select c.id, c.full_name
      from vizserve_pms_task_mention_candidates(p_task_id, auth.uid()) c
     -- Not yourself. Mentioning the person typing is a notification nobody
     -- needs, and a name in the list that does nothing reads as a bug.
     where c.id is distinct from auth.uid()
     order by c.full_name;
end;
$fn$;

revoke all on function vizserve_pms_mentionable_for_task(uuid) from public, anon;
grant execute on function vizserve_pms_mentionable_for_task(uuid) to authenticated;

comment on function vizserve_pms_mentionable_for_task(uuid) is
  'P7-71. The @ picker''s list: the mention candidates for a task, minus the '
  'caller, and only once the caller has proved they can see the task. A '
  'deliberate subset of the task SELECT policy -- narrow costs a dropdown '
  'entry, wide costs a department its privacy.';

-- ---------------------------------------------------------------------------
-- Telling them.
--
-- Replaces the P7-08 trigger function rather than adding a second one: both
-- read the same comment and both decide who hears about it, and two triggers on
-- one table would have to agree about the author and about who was already
-- notified. They cannot disagree if there is one of them.
--
-- ⚠️ A MENTION SUPPRESSES THE PLAIN `commented` FOR THAT PERSON. The PIC named
-- in a comment would otherwise get two inbox rows about one comment, which is
-- exactly the wallpaper P7-08 was avoiding when it refused to notify the whole
-- department. Mentions are collected first and the `commented` loop subtracts
-- them.
--
-- ⚠️ AND IT NOW FIRES ON UPDATE TOO, FOR MENTIONS ONLY. "Sorry — @Amier, see
-- above" typed thirty seconds after posting is the ordinary way people use
-- this, and an insert-only trigger notifies nobody for it. Only ids that were
-- not in the OLD body are notified, so editing a typo in a comment that already
-- named somebody does not tell them twice. The `commented` half stays
-- insert-only: an edited comment is not a new comment.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_notify_task_comment()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_task      vizserve_pms_tasks;
  v_author    text;
  v_recipient uuid;
  v_mentioned uuid[];
  /*
   * ⚠️ NOT `old.body` INLINE, AND NOT A STYLE CHOICE. `OLD` is an UNASSIGNED
   * record in an INSERT trigger, and plpgsql raises `record "old" is not
   * assigned yet` on any field reference to it — including one inside a `case`
   * branch that is not taken, because the expression is still planned. Reading
   * it behind a `tg_op` guard, into a variable that defaults to empty, is what
   * lets one function serve both events.
   */
  v_old_body  text := '';
begin
  if tg_op = 'UPDATE' then v_old_body := old.body; end if;

  select * into v_task from vizserve_pms_tasks where id = new.task_id;
  if v_task.id is null then return new; end if;

  select full_name into v_author from vizserve_pms_users where id = new.author_id;

  /*
   * Who the body names, intersected with who may be named.
   *
   * ⚠️ THE INTERSECTION IS THE SECURITY CHECK, and it is here rather than in
   * the server action because the front end will be bypassed. The picker only
   * offers names the author may address, but a body is just text: a
   * hand-written `data-mention-id` would otherwise post the task title and 200
   * characters of the comment to anybody at all. An id that is not a candidate
   * is dropped silently — the mention still renders as a name in the comment,
   * it simply notifies nobody.
   *
   * ⚠️ `new.author_id`, NOT `auth.uid()`, AND THAT IS THE POINT OF THE ACTOR
   * PARAMETER. The reach is the AUTHOR'S, so a member cannot widen their own by
   * hand-editing a body, and a comment written by the service role — with no
   * session and therefore no `auth.uid()` — is still judged against the person
   * whose name is on it rather than against nobody.
   *
   * On UPDATE, minus whoever the old body already named.
   */
  select coalesce(array_agg(m.id), '{}')
    into v_mentioned
    from (
      select named.id from vizserve_pms_mentioned_ids(new.body) as named(id)
      intersect
      select c.id from vizserve_pms_task_mention_candidates(new.task_id, new.author_id) c
      except
      select new.author_id
      except
      select already.id from vizserve_pms_mentioned_ids(v_old_body) as already(id)
    ) m;

  foreach v_recipient in array v_mentioned loop
    perform vizserve_pms_notify(
      v_recipient,
      'mentioned',
      coalesce(v_author, 'Somebody') || ' mentioned you on ' || v_task.title,
      left(new.body, 200),
      'task',
      new.task_id,
      '/tasks/' || new.task_id::text
    );
  end loop;

  -- An edited comment is not a new comment. Everything below is P7-08's, and it
  -- runs on INSERT only.
  if tg_op <> 'INSERT' then return new; end if;

  -- The PIC and the QA reviewer, never the author, never twice, and never
  -- somebody who was just told by name. A lead who is neither is not notified:
  -- they have the department view, and a comment on every task in the
  -- department is how an inbox becomes wallpaper.
  for v_recipient in
    select unnest(array[v_task.assignee_id, v_task.qa_assignee_id])
    except
    select new.author_id
    except
    select unnest(v_mentioned)
  loop
    if v_recipient is not null then
      perform vizserve_pms_notify(
        v_recipient,
        'commented',
        coalesce(v_author, 'Somebody') || ' commented on ' || v_task.title,
        left(new.body, 200),
        'task',
        new.task_id,
        '/tasks/' || new.task_id::text
      );
    end if;
  end loop;

  return new;
end;
$fn$;

-- The P7-08 trigger was `after insert`. Dropped and recreated rather than left
-- alongside a second one — see the note above on why there is exactly one.
drop trigger if exists vizserve_pms_task_comments_notify on vizserve_pms_task_comments;

create trigger vizserve_pms_task_comments_notify
  after insert or update of body on vizserve_pms_task_comments
  for each row execute function vizserve_pms_notify_task_comment();

-- ---------------------------------------------------------------------------
-- Inbox only, like `commented`.
--
-- ⚠️ THIS IS A SETTINGS ROW, NOT A RULE IN CODE — one UPDATE flips it if the
-- team decides otherwise, and `vizserve_pms_notify` reads it per call.
--
-- Off because of what a mention actually adds. Docs/12 spends the email budget
-- on things that cross a boundary or block somebody, and the people a mention
-- reaches who would NOT otherwise hear anything are department colleagues who
-- get no notification about this task at all today. For them the inbox row IS
-- the new signal; it does not need an email behind it. The PIC and the QA
-- reviewer were already getting `commented`, so for them a mention changes the
-- wording, not the interruption.
-- ---------------------------------------------------------------------------
insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('mentioned', false, 'Somebody named you in a comment with @. Inbox only -- see the note in 20260917090100.')
on conflict (type) do nothing;
