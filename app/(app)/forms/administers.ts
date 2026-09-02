import { canAccessDepartment, roleAtLeast, type AuthContext } from "@/lib/auth/authorization";

/**
 * P7-66 Phase 4b — ⚠️ "MAY I ADMINISTER THIS FORM?", asked in the query layer
 * because RLS can no longer answer it on its own.
 *
 * ⚠️ WHY THIS EXISTS AT ALL, since restating a department filter in a query is
 * something CLAUDE.md forbids outright ("List queries carry no department
 * filter — the policy does it").
 *
 * `vizserve_pms_forms` now serves TWO DIFFERENT READERS through one set of
 * policies:
 *
 *   ADMINISTERING  /forms and /forms/[id] — the builder. Admin, or the lead of
 *                  the owning department, or the author of a form that has no
 *                  department yet. That is what the four P1 policies say and
 *                  what `assertCanEditForm` enforces on every write.
 *   FILLING IN     /respond and /respond/[slug]. ANY active staff member, on a
 *                  published EMPLOYEE_ENGAGEMENT form. That is
 *                  `published engagement forms readable by staff`
 *                  (20260902110000_p7_66_form_responses.sql), and a member has
 *                  to hold it or /respond renders nothing.
 *
 * Policies are OR'd, so the second one widens the first: after it, a team
 * leader of VizMedia can SELECT VizBytes' published engagement forms. Correct
 * for /respond — they may answer that survey — and wrong for /forms, which
 * would list somebody else's forms as theirs to edit and render the whole
 * question schema at /forms/[id].
 *
 * ⚠️ AND NO POLICY CAN TELL THE TWO APART, because the difference is not in the
 * ROWS — it is in WHICH QUESTION IS BEING ASKED, and a row-level policy is
 * never told that. The row is legitimately readable by that person; it is
 * simply not theirs to administer. So the administrative scope moves to the two
 * builder call sites, and this is the one place that decides it, derived from
 * `canAccessDepartment` so there is still a single authority on what a role
 * reaches (CLAUDE.md).
 *
 * ⚠️ THIS IS NOT THE ENFORCEMENT AND MUST NEVER BE READ AS IT. Every WRITE
 * still goes through `assertCanEditForm` and then through
 * `forms updatable in scope`, which never widened. This decides what a SCREEN
 * is about.
 *
 * The two clauses mirror `assertCanEditForm` exactly, deliberately: a form the
 * builder lists must be a form the builder can save.
 */
export type AdministrableForm = {
  department_id: string | null;
  created_by: string | null;
};

export function administersForm(context: AuthContext, form: AdministrableForm): boolean {
  // The role floor FIRST, exactly as `assertCanEditForm` applies
  // `requireRole("team_leader")` before it looks at the row. Without it the
  // author carve-out below would answer `true` for a member — a state the
  // policies make unreachable (`forms insertable by team leaders`) and which a
  // predicate should still refuse rather than rely on.
  if (!roleAtLeast(context.role, "team_leader")) return false;

  // An unrouted draft belongs to its author until a department is chosen — the
  // same carve-out `assertCanEditForm` makes, and the reason this cannot simply
  // BE `canAccessDepartment`, which is false on a null for anyone but an admin.
  if (form.department_id === null && form.created_by === context.userId) return true;

  return canAccessDepartment(context, form.department_id);
}
