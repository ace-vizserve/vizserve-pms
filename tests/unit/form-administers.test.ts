import { describe, expect, it } from "vitest";

import { administersForm } from "@/app/(app)/forms/administers";
import type { AuthContext, Role } from "@/lib/auth/authorization";

/**
 * P7-66 Phase 4b — ⚠️ THE BUILDER'S SCOPE, NOW THAT RLS ALONE CANNOT STATE IT.
 *
 * `published internal forms readable by their audience`
 * (20260902110000_p7_66_form_responses.sql) had to be company-wide: a member
 * cannot answer a survey they cannot read, and it is the only policy that shows
 * a form row to a member at all. Policies are OR'd, so it also widened the
 * BUILDER's read — /forms listed every other department's published internal
 * forms, and /forms/[id] rendered their whole question schema.
 *
 * No policy can separate the two: the readers differ in which QUESTION they are
 * asking, not in which rows exist. So the administrative half moved here, and
 * these cases are what stop it drifting from `assertCanEditForm`, which is the
 * rule the WRITE path applies. A form the builder lists must be a form the
 * builder can save.
 */

const DEPT_A = "a1000000-0000-4000-8000-000000000001";
const DEPT_B = "a1000000-0000-4000-8000-000000000002";
const ME = "00000000-0000-4000-8000-000000000001";
const SOMEBODY_ELSE = "00000000-0000-4000-8000-000000000002";

function context(overrides: Partial<AuthContext> & { role: Role }): AuthContext {
  return {
    userId: ME,
    email: "test.someone@example.com",
    fullName: "Test Someone",
    gender: null,
    isHr: false,
    // P8-01. The department-admin tick — orthogonal to `role`, exactly as
    // `isHr` is, and false unless a test says otherwise.
    isDeptAdmin: false,
    primaryDepartmentId: null,
    managedDepartmentIds: [],
    ...overrides,
  };
}

const lead = context({ role: "team_leader", managedDepartmentIds: [DEPT_A] });
/*
 * ⚠️ `owner`, NOT `admin`. P8-01 retired `admin` to a dead rung that grants
 * nothing, and `administersForm` asks for `>= owner` on both of its wide
 * branches. Left as `admin` every case below would assert the opposite of the
 * rule — a rank with no capability administering everything.
 */
const owner = context({ role: "owner" });

/**
 * A client form, which is what every case below the first block is about.
 *
 * ⚠️ NAMED RATHER THAN DEFAULTED. `purpose` is REQUIRED on `AdministrableForm`
 * precisely so a caller cannot omit it and silently get the old, wider answer —
 * a default here would put that hole straight back, in the file whose job is to
 * notice it.
 */
const clientForm = (department_id: string | null, created_by: string | null) => ({
  department_id,
  created_by,
  purpose: "CLIENT_REQUEST",
});

const internalForm = (department_id: string | null, created_by: string | null) => ({
  department_id,
  created_by,
  purpose: "INTERNAL",
});

describe("administersForm — the builder's scope, not the fill-in scope", () => {
  it("lets a lead administer a form in a department they lead", () => {
    expect(administersForm(lead, clientForm(DEPT_A, SOMEBODY_ELSE))).toBe(true);
  });

  it("⚠️ REFUSES another department's form, which the staff policy now lets them READ", () => {
    // The finding, exactly: after the new SELECT policy the row comes back from
    // Postgres for this person. It is still not theirs to edit, and /forms must
    // not list it or open its question schema.
    expect(administersForm(lead, clientForm(DEPT_B, SOMEBODY_ELSE))).toBe(false);
  });

  it("lets an owner administer everything, including an unrouted draft", () => {
    expect(administersForm(owner, clientForm(DEPT_B, SOMEBODY_ELSE))).toBe(true);
    expect(administersForm(owner, clientForm(null, SOMEBODY_ELSE))).toBe(true);
  });

  it("keeps the unrouted-author carve-out `assertCanEditForm` makes", () => {
    // Without this the builder would hide a form from the person who has just
    // created it — `canAccessDepartment(_, null)` is false for everyone but an
    // admin, which is why this cannot simply BE `canAccessDepartment`.
    expect(administersForm(lead, clientForm(null, ME))).toBe(true);
  });

  it("does NOT extend that carve-out to somebody else's unrouted draft", () => {
    expect(administersForm(lead, clientForm(null, SOMEBODY_ELSE))).toBe(false);
  });

  it("refuses a member outright — holding no lead role reaches no form", () => {
    // A member never reaches /forms (it is `requireRole("team_leader")`), but a
    // predicate that answered `true` here would be one refactor away from
    // mattering.
    const member = context({ role: "member" });
    expect(administersForm(member, clientForm(DEPT_A, SOMEBODY_ELSE))).toBe(
      false,
    );
    // Not even their own unrouted draft, which they cannot create in the first
    // place (`forms insertable by team leaders`). The role floor is checked
    // BEFORE the author carve-out, so the exception stays "the team leader who
    // started this draft" rather than becoming "anyone whose id is on the row".
    expect(administersForm(member, clientForm(null, ME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P7-66 Phase 5 — AN INTERNAL FORM IS AN ADMIN INSTRUMENT.
// ---------------------------------------------------------------------------

describe("administersForm — internal forms are owner only", () => {
  it("lets an owner administer one in any department", () => {
    expect(administersForm(owner, internalForm(DEPT_B, SOMEBODY_ELSE))).toBe(true);
    expect(administersForm(owner, internalForm(null, SOMEBODY_ELSE))).toBe(true);
  });

  it("⚠️ refuses a lead OF THE OWNING DEPARTMENT", () => {
    /*
     * The case that separates this rule from every other one in this file. On a
     * CLIENT form this exact shape is `true` — it is their department, and the
     * assertion two blocks up says so. Internal forms are not scoped by
     * department at all: they are scoped by role, because their answers are read
     * across departments and Phase 6's roster needs every targeted department's
     * members.
     */
    expect(administersForm(lead, clientForm(DEPT_A, SOMEBODY_ELSE))).toBe(true);
    expect(administersForm(lead, internalForm(DEPT_A, SOMEBODY_ELSE))).toBe(false);
  });

  it("⚠️ refuses the lead who CREATED it, unrouted", () => {
    /*
     * THE ORDERING TEST, and the reason the purpose clause is first in the
     * function.
     *
     * The author carve-out below it answers `true` for an unrouted draft its
     * author started — correct on a client form, and on an internal form it
     * would hand the builder to a team leader whose every save Postgres now
     * refuses (`forms updatable in scope`, `form fields follow their form`,
     * 20260902140000). An editor that cannot save is worse than no editor.
     *
     * Reachable, not hypothetical: any internal form created before that
     * migration has a non-admin in `created_by`.
     */
    expect(administersForm(lead, clientForm(null, ME))).toBe(true);
    expect(administersForm(lead, internalForm(null, ME))).toBe(false);
  });

  it("refuses a member, as it does everywhere else", () => {
    const member = context({ role: "member" });
    expect(administersForm(member, internalForm(DEPT_A, SOMEBODY_ELSE))).toBe(false);
    expect(administersForm(member, internalForm(null, ME))).toBe(false);
  });
});
