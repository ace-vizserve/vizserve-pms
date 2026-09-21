-- ---------------------------------------------------------------------------
-- P13-02 — WHO YOU MAY PUT ON COMPANY-WIDE WORK.
--
-- Amier, 21 Sep, standing in the Company-wide list with the assignee picker
-- open: "i cant still see all members in here — take note this is for the
-- company wide".
--
-- ⚠️ P13-01 WIDENED THE RULES AND LEFT THE ROSTER BEHIND, WHICH IS THIS REPO'S
-- SINGLE MOST REPEATED FAILURE (docs/13-implementation-status.md records it four
-- times in two days): the migration lands, and the layer that reaches it does
-- not. `vizserve_pms_create_task` and `vizserve_pms_add_task_assignee` will both
-- accept ANY active person on a collaboration task. The picker offering them
-- simply could not name anybody outside the reader's own department.
--
-- ---------------------------------------------------------------------------
-- WHY, AND IT IS NOT THE POLICY P13-01 TOUCHED. Every screen builds its people
-- list with an ordinary read through the CALLER'S OWN client:
--
--     supabase.from("vizserve_pms_users").select("id, full_name, …")
--
-- and SELECT on `vizserve_pms_users` is a stack of additive, department-scoped
-- policies — your own team (p7_17), the teams you lead, everybody for an admin,
-- plus two narrow extras for handovers and relievers. So `everyone` in the
-- TypeScript was never everyone. It was "everyone I could already see", which
-- for a member is their own department, which is exactly the six names in the
-- screenshot.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE FIX IS A DEFINER FUNCTION, NOT A WIDER POLICY ON `vizserve_pms_users`,
-- AND THAT IS THE WHOLE POINT OF THIS FILE.
--
-- An additive policy would read `using (a shared department exists)` — and
-- because permissive policies are OR-ed, that one clause would make EVERY user
-- row readable by EVERY signed-in person in EVERY query in the app, for good,
-- the moment one collaboration space exists. The DTR filter, the HR screens,
-- the reports, the department pickers: all of them would silently start
-- returning the whole company. That is not "the company-wide space is shared".
-- That is "department scoping on people is over".
--
-- Amier, same message: "i said onylt the company wide not all focus on that".
--
-- A function has a call site. It answers this one question, the screens that
-- ask it are the ones building a collaboration picker, and every other query in
-- the product keeps the scoping it has. P7-71 set this precedent for exactly
-- the same problem — `vizserve_pms_task_mention_candidates` is definer for this
-- reason — and this is the same shape one level out.
--
-- ⚠️ SO: @ MENTIONS NEEDED NO CHANGE HERE. P13-01 §8 widened the candidate
-- function itself, and that function was ALREADY definer, so it reads past RLS
-- and already returns the whole company on a shared task. Mentions worked;
-- assignment did not. Stated because the two look like one feature and are not.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS EXPOSES, PLAINLY: the id and display name of every active person
-- with a department, to every active person — but only through this function,
-- and the screens only call it when the destination is a collaboration space.
-- A name and nothing else: no email, no role, no department, no status. That is
-- the minimum a picker needs to offer somebody, and offering somebody is the
-- feature that was asked for.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, as `postgres`. P13-01 must be
-- applied first — this leans on `vizserve_pms_shared_department_ids()`.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_collaborators()
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  /*
   * ⚠️ THE GUARD IS THE FIRST CLAUSE AND IT IS TWO CONDITIONS, NOT ONE.
   *
   *   1. THERE IS A COLLABORATION SPACE. With none, this returns nothing at
   *      all — so the function cannot be used as a general "list the company"
   *      endpoint, and before P13-01's space exists it is inert.
   *   2. THE CALLER IS ACTIVE. Same gate `vizserve_pms_may_collaborate` applies,
   *      and it is the one that matters here: this is `security definer`, so
   *      nothing else is standing behind it. A deactivated account holds a
   *      valid token until it expires, and without this clause it would still
   *      get the roster.
   *
   * Both are EXISTS against tiny sets, hoisted once per statement.
   */
  select u.id, u.full_name
    from vizserve_pms_users u
   where exists (select 1 from vizserve_pms_shared_department_ids())
     and exists (
           select 1 from vizserve_pms_users me
            where me.id = (select auth.uid()) and me.is_active
         )
     and u.is_active
     /*
      * ⚠️ A PERSON WITH NO DEPARTMENT IS NOT ASSIGNABLE, HERE OR ANYWHERE.
      *
      * Not squeamishness — `vizserve_pms_create_task` and
      * `vizserve_pms_add_task_assignee` both test `u.is_active` and, outside a
      * shared space, `u.primary_department_id = …`. Inside one they test only
      * activity, so a department-less account WOULD be accepted. It still must
      * not be offered: that is the state a freshly provisioned SSO account sits
      * in before anybody maps them, and work handed to them appears on no
      * lead's timesheet review and in no department's tree. The same test every
      * other picker in this app applies.
      */
     and u.primary_department_id is not null
   order by u.full_name;
$fn$;

comment on function vizserve_pms_collaborators() is
  'P13-02. Every active person with a department, id and display name only, for the '
  'assignee pickers on COLLABORATION work. ⚠️ A DEFINER FUNCTION RATHER THAN A WIDER '
  'POLICY ON vizserve_pms_users: a permissive policy would be OR-ed into every query '
  'in the app and end department scoping on people everywhere. Returns nothing when '
  'no shared department exists, or to an inactive caller. Callers must use it ONLY '
  'when the destination is a shared department -- see the migration header.';

/*
 * ⚠️ GRANTED TO `authenticated`, UNLIKE `vizserve_pms_task_mention_candidates`.
 *
 * p7_71 revokes that one from `authenticated` because it takes an ARBITRARY
 * ACTOR — it can be asked "what would SOMEBODY ELSE be allowed to see", which is
 * an enumeration primitive, so it is reachable only from a wrapper that checks
 * the caller. This function takes no arguments and answers only about
 * `auth.uid()`. There is no version of it that can be asked about anybody else,
 * so there is nothing for a wrapper to add.
 */
grant execute on function vizserve_pms_collaborators() to authenticated;


-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO, deliberately:
--
--   IT DOES NOT WIDEN EDITING, ANYWHERE. Not one policy is touched. This is a
--   roster for a picker; who may actually be assigned is still decided by
--   `vizserve_pms_create_task` and `vizserve_pms_add_task_assignee`, both of
--   which relax their department test ONLY when
--   `vizserve_pms_may_collaborate()` is true — that is, only inside a
--   department flagged `is_shared`. Offering a name here cannot make the server
--   accept one it would otherwise refuse: pick somebody from another department
--   while filing into an ORDINARY list and the function still answers "That
--   assignee is not an active member of this department."
--
--   IT DOES NOT MAKE ANYBODY A MEMBER OF ANYTHING. `primary_department_id` is
--   untouched, and P13-01 §2 still refuses a shared department as anybody's.
-- ---------------------------------------------------------------------------
