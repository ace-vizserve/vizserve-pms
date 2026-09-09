import {
  canAdminDepartmentScope,
  canShapeDepartmentScope,
  roleAtLeast,
  type ShapeScope,
} from "@/lib/auth/roles";

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
 *                  published INTERNAL form. That is
 *                  `published internal forms readable by their audience`
 *                  (20260902110000_p7_66_form_responses.sql), and a member has
 *                  to hold it or /respond renders nothing.
 *
 * Policies are OR'd, so the second one widens the first: after it, a team
 * leader of VizMedia can SELECT VizBytes' published internal forms. Correct
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
/**
 * ⚠️ P12-22 — THE SEAT, STRUCTURALLY, RATHER THAN `AuthContext`.
 *
 * This file was `server-only` by inheritance: it imported `canAdminDepartment`
 * and `canShapeDepartment` from `lib/auth/authorization.ts`, which is
 * `server-only` by design. Phase 6 moved `/forms` onto the query cache, and the
 * rows arrive in a CLIENT component — so this filter had to run there, beside
 * them. Importing it as it stood would have pulled `server-only` into the
 * browser bundle: a build failure `tsc`, eslint and vitest are all blind to.
 *
 * The two predicates now live in `lib/auth/roles.ts`, which has no server
 * import and holds the role ordering for the same reason. `AuthContext`
 * SATISFIES this type structurally, so every existing server call site —
 * `/forms/page.tsx`, `/forms/[id]/page.tsx` — passes its context exactly as
 * before and nothing about the rule changed.
 *
 * ⚠️ ONLY THE FIELDS THE RULE READS. Narrower than `AuthContext` on purpose: a
 * client component is handed precisely these five values and no session, no
 * email, no HR flag. What it cannot see it cannot leak into a bundle.
 */
export type FormAdminScope = ShapeScope & { userId: string };

export type AdministrableForm = {
  department_id: string | null;
  created_by: string | null;
  /**
   * P7-66 Phase 5 — REQUIRED, so a caller cannot forget to select it and get the
   * old, wider answer by omission. See the admin clause below.
   */
  purpose: string;
};

export function administersForm(context: FormAdminScope, form: AdministrableForm): boolean {
  /*
   * ⚠️ P7-66 Phase 5 — AN INTERNAL FORM IS AN ADMIN INSTRUMENT, AND THIS IS THE
   * SCREEN'S HALF OF THAT.
   *
   * Ace, 2 Sep 2026: a team leader cannot read the members of a department they
   * do not lead, so Phase 6's "who has not answered" roster would be half-blank
   * on exactly the company-wide survey it is most wanted for. Widening the two
   * people policies to fix that would have made the whole app's people data
   * wider; an admin already reads every department, so this costs nothing.
   *
   * FIRST, before the author carve-out below. A team leader who CREATED an
   * internal form before this rule existed must not keep the builder on it
   * through `created_by` — the policies took the write away
   * (20260902140000), so the screen would offer them an editor whose every save
   * Postgres refuses.
   *
   * ⚠️ AND IT IS NOT THE ENFORCEMENT. `forms updatable in scope` and `form
   * fields follow their form` both carry the same rule, and the second is the
   * one that matters: `vizserve_pms_save_form_schema` is SECURITY INVOKER and
   * writes the field rows directly, so a lock on the form row alone would leave
   * every question editable. This decides what a SCREEN is about.
   */
  // P8-01: `roleAtLeast`, not `=== "admin"` — the top rung is now `owner`.
  if (form.purpose === "INTERNAL") return roleAtLeast(context.role, "owner");

  /*
   * ⚠️ P8-01c — THE ROLE FLOOR IS NO LONGER THE WHOLE OF THE FLOOR.
   *
   * It used to be `roleAtLeast(context.role, "team_leader")` alone, applied
   * first, "exactly as `assertCanEditForm` applies `requireRole('team_leader')`
   * before it looks at the row". That gate is now `requireDepartmentShape()`,
   * which also admits a DEPARTMENT ADMIN of any rank — so a bare rank test here
   * would list nothing for the member the tick was built for, on a screen they
   * can now open. The migration would have landed and the layer that reaches it
   * would not.
   *
   * The floor still exists and still comes FIRST, for its original reason: the
   * author carve-out below would otherwise answer `true` for a plain member who
   * happens to have created a draft.
   */
  if (
    !roleAtLeast(context.role, "team_leader") &&
    !canAdminDepartmentScope(context, context.primaryDepartmentId)
  ) {
    return false;
  }

  // An unrouted draft belongs to its author until a department is chosen — the
  // same carve-out `assertCanEditForm` makes, and the reason this cannot simply
  // BE `canShapeDepartment`, which is false on a null for anyone but an owner.
  //
  // ⚠️ A DEPARTMENT ADMIN NEVER REACHES THIS BRANCH IN PRACTICE, and that is by
  // construction rather than luck: `forms creatable by department admin`
  // requires a department on the row, so the tick cannot produce a
  // department-less draft in the first place. It stays a shared line because a
  // team leader still can.
  if (form.department_id === null && form.created_by === context.userId) return true;

  /*
   * P8-01c: `canShapeDepartment` — "leads it OR holds the Admin tick on it" —
   * where this read `canAccessDepartment`.
   *
   * ⚠️ AND `canAccessDepartmentScope` MUST NOT ITSELF BE WIDENED to make this
   * work.
   * It mirrors `vizserve_pms_manages_department`, which is what decides who may
   * APPROVE; the tick confers no approval rights at all. Two predicates, so the
   * two questions can never be answered by one edit.
   */
  return canShapeDepartmentScope(context, form.department_id);
}
