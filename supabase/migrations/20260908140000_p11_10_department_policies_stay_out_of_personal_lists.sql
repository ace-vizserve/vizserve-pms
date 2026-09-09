-- P11-10 — the department's list policies stop at a personal list.
--
-- P11-07 opened creating and deleting a department's lists to any active member
-- of it. It was written the same afternoon `owner_id` arrived on this table, and
-- against the version without it, so neither policy asks whose list it is.
--
-- ⚠️ POLICIES ARE OR'd, SO THE OTHER FILE'S GUARD DOES NOT HELP. Every policy
-- `p11_06_personal_lists` wrote carries `owner_id is null`, and that is exactly
-- why it works: a department policy that does not mention `owner_id` is a
-- SECOND route to the same row, and permissive policies are unioned. Two
-- consequences, both reachable with a direct PostgREST call and neither through
-- any screen:
--
--   * INSERT with `owner_id` set to a COLLEAGUE. `vizserve_pms_lists_owner_guard`
--     then files it in that colleague's department — which is the caller's own,
--     so the check passes. A private list appears in somebody else's space.
--   * DELETE of a colleague's personal list, by the same arithmetic.
--
-- "The front end will be bypassed" is a standing rule here, and this is what it
-- looks like: `saveList` never sends `owner_id`, and that protects nobody.
--
-- Both policies are recreated with the clause they should have had. Nothing else
-- changes — a member keeps create, rename, archive and delete on the
-- DEPARTMENT's lists, which is the whole of P11-07.


drop policy if exists "lists creatable by the department" on vizserve_pms_lists;

create policy "lists creatable by the department"
  on vizserve_pms_lists for insert to authenticated
  with check (
    -- P11-10. A personal list is created through "personal lists belong to
    -- their owner", which is the only policy that may set `owner_id` — and it
    -- can only set it to the caller.
    owner_id is null
    and (
      vizserve_pms_is_dept_admin(department_id)
      or exists (
        select 1 from vizserve_pms_users u
         where u.id = auth.uid()
           and u.is_active
           and u.primary_department_id = vizserve_pms_lists.department_id
      )
    )
  );


drop policy if exists "lists deletable by the department" on vizserve_pms_lists;

create policy "lists deletable by the department"
  on vizserve_pms_lists for delete to authenticated
  using (
    owner_id is null
    and (
      vizserve_pms_is_dept_admin(department_id)
      or exists (
        select 1 from vizserve_pms_users u
         where u.id = auth.uid()
           and u.is_active
           and u.primary_department_id = vizserve_pms_lists.department_id
      )
    )
  );
