import { describe, expect, it } from "vitest";

import { assignableInList, type AssignablePerson } from "@/lib/assignable";

/**
 * P13-02 — THE LIST YOU ARE STANDING IN DECIDES WHO THE PICKER MAY OFFER.
 *
 * Amier, 21 Sep, after the collaboration space landed: "i can only search all
 * member UNDER THE COMPANY WIDE. IF I AM VIZBYTES AND IT WAS UNDER VIZBYTES I
 * CANT SEARCH ALL, ONLY THE MEMBER OF THAT DEPARTMENT".
 *
 * ⚠️ THE OWNER CASE IS THE ONE THAT WAS ACTUALLY BROKEN, and it predates the
 * collaboration space. The filter read `roleAtLeast(role, "owner") || …`, so an
 * owner standing in a VizBytes list was offered every active person in the
 * company — and `quickAddTask` derives a task's department from its ASSIGNEE,
 * so picking one of them built a VizMedia task filed into a VizBytes list,
 * which `vizserve_pms_create_task` then refused by name. The picker was
 * offering a guaranteed error message, and it looked exactly like the new
 * feature leaking.
 */

const VIZBYTES = "a1000000-0000-4000-8000-000000000001";
const VIZMEDIA = "a1000000-0000-4000-8000-000000000004";
const SHARED = "a1000000-0000-4000-8000-000000000005";

const ME = "00000000-0000-4000-8000-000000000001";

function person(
  id: string,
  full_name: string,
  primary_department_id: string | null,
  is_active = true,
): AssignablePerson {
  return { id, full_name, primary_department_id, is_active };
}

const ACE = person("11111111-0000-4000-8000-000000000001", "Ace Guevarra", VIZBYTES);
const RAIZA = person("11111111-0000-4000-8000-000000000002", "Raiza Mondina", VIZBYTES);
const HAZEL = person("22222222-0000-4000-8000-000000000001", "Hazel Amoranto", VIZMEDIA);
const NERI = person("22222222-0000-4000-8000-000000000002", "Neri Lopez", VIZMEDIA);
const SELF = person(ME, "Test Owner", VIZBYTES);

/** Everybody the RLS read returned. For an owner that really is everybody. */
const EVERYONE = [SELF, ACE, RAIZA, HAZEL, NERI];

/** What `vizserve_pms_collaborators()` hands back — id and name only. */
const ROSTER = EVERYONE.map((p) => ({ id: p.id, full_name: p.full_name }));

function call(overrides: Partial<Parameters<typeof assignableInList>[0]> = {}) {
  return assignableInList({
    people: EVERYONE,
    collaborators: ROSTER,
    listDepartmentId: null,
    sharedDepartmentIds: [SHARED],
    role: "member",
    managedDepartmentIds: [],
    primaryDepartmentId: VIZBYTES,
    selfId: ME,
    ...overrides,
  });
}

const names = (result: { full_name: string }[]) => result.map((p) => p.full_name).sort();

describe("assignableInList — a department list offers that department, and only it", () => {
  it("offers VizBytes people in a VizBytes list", () => {
    expect(names(call({ listDepartmentId: VIZBYTES }))).toEqual(["Ace Guevarra", "Raiza Mondina"]);
  });

  it("⚠️ offers VizBytes people in a VizBytes list TO AN OWNER TOO", () => {
    // The regression this file exists for. `roleAtLeast(role, "owner")` used to
    // short-circuit the department test and hand back the whole company.
    const result = call({ listDepartmentId: VIZBYTES, role: "owner" });

    expect(names(result)).toEqual(["Ace Guevarra", "Raiza Mondina"]);
    expect(names(result)).not.toContain("Hazel Amoranto");
  });

  it("⚠️ does not leak a SECOND department to a lead who leads both", () => {
    // A lead of VizBytes and VizMedia standing in a VizBytes list gets
    // VizBytes. Their scope decides which lists they can open, not who is in
    // one once they are there.
    const result = call({
      listDepartmentId: VIZBYTES,
      role: "team_leader",
      managedDepartmentIds: [VIZBYTES, VIZMEDIA],
    });

    expect(names(result)).toEqual(["Ace Guevarra", "Raiza Mondina"]);
  });

  it("offers VizMedia people in a VizMedia list, whoever is asking", () => {
    expect(names(call({ listDepartmentId: VIZMEDIA, role: "owner" }))).toEqual([
      "Hazel Amoranto",
      "Neri Lopez",
    ]);
  });
});

describe("assignableInList — the company-wide list is the one that offers everybody", () => {
  it("offers the whole roster in a collaboration list", () => {
    expect(names(call({ listDepartmentId: SHARED }))).toEqual([
      "Ace Guevarra",
      "Hazel Amoranto",
      "Neri Lopez",
      "Raiza Mondina",
    ]);
  });

  it("⚠️ takes the roster from `collaborators`, NEVER from `people`", () => {
    // `people` is an RLS-scoped read: for a member it holds their own
    // department only, so filtering it could never produce somebody outside.
    // Passing a member's narrow `people` beside a full roster proves which one
    // the shared branch reads.
    const result = call({
      listDepartmentId: SHARED,
      people: [SELF, ACE, RAIZA],
    });

    expect(names(result)).toContain("Hazel Amoranto");
  });

  it("offers nobody extra when the roster is empty", () => {
    // The pre-migration state: `vizserve_pms_collaborators()` does not exist,
    // `loadCollaborators` degrades to `[]`. An empty picker is the honest
    // answer, and it must not fall back to the department branch.
    expect(call({ listDepartmentId: SHARED, collaborators: [] })).toEqual([]);
  });

  it("⚠️ is not triggered by a department that merely looks shared", () => {
    // Membership of `sharedDepartmentIds` is the only test. A department id
    // that is not in that set takes the department branch however it is named.
    expect(names(call({ listDepartmentId: SHARED, sharedDepartmentIds: [] }))).toEqual([]);
  });
});

describe("assignableInList — with no list, the caller's own scope is all there is", () => {
  it("gives a member their own department", () => {
    expect(names(call({ listDepartmentId: null }))).toEqual(["Ace Guevarra", "Raiza Mondina"]);
  });

  it("gives an owner everybody — `?view=mine` spans every list", () => {
    // Deliberately NOT narrowed. There is no list department to scope to here,
    // and this is the rule that was already in place for the cross-list views.
    expect(names(call({ listDepartmentId: null, role: "owner" }))).toEqual([
      "Ace Guevarra",
      "Hazel Amoranto",
      "Neri Lopez",
      "Raiza Mondina",
    ]);
  });

  it("gives a lead both of the departments they lead", () => {
    expect(
      names(
        call({
          listDepartmentId: null,
          role: "team_leader",
          managedDepartmentIds: [VIZBYTES, VIZMEDIA],
        }),
      ),
    ).toEqual(["Ace Guevarra", "Hazel Amoranto", "Neri Lopez", "Raiza Mondina"]);
  });
});

describe("assignableInList — the exclusions that hold in every branch", () => {
  it("never offers the reader themselves", () => {
    // "Myself" is the composer's default, not a row: picking it calls a
    // different function and produces a different KIND of task.
    for (const listDepartmentId of [null, VIZBYTES, SHARED]) {
      expect(call({ listDepartmentId, role: "owner" }).map((p) => p.id)).not.toContain(ME);
    }
  });

  it("never offers a deactivated person", () => {
    const gone = person("33333333-0000-4000-8000-000000000001", "Gone Person", VIZBYTES, false);

    expect(names(call({ listDepartmentId: VIZBYTES, people: [...EVERYONE, gone] }))).not.toContain(
      "Gone Person",
    );
  });

  it("never offers somebody with no department", () => {
    // The state a freshly provisioned SSO account sits in. Work handed to them
    // appears on no lead's timesheet review and in no department's tree.
    const stray = person("44444444-0000-4000-8000-000000000001", "Unmapped Person", null);

    expect(
      names(call({ listDepartmentId: null, role: "owner", people: [...EVERYONE, stray] })),
    ).not.toContain("Unmapped Person");
  });
});
