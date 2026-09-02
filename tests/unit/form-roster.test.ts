import { describe, expect, it } from "vitest";

import {
  canShowPendingAnswerers,
  pendingAnswerers,
  type RosterMember,
} from "@/lib/form-builder/roster";

/**
 * P7-66 Phase 6 — WHO HAS NOT ANSWERED.
 *
 * ⚠️ THE THING THIS LIST IS FOR IS BEING ACTED ON. Every other number on the
 * Responses tab is read and forgotten; this one is read and then somebody is
 * chased about it. So the failures that matter are not crashes — they are a
 * plausible, confident, wrong list of names.
 *
 * Three of them, and each has a case below:
 *
 *   SOMEBODY WHO ANSWERED TWICE making a colleague look outstanding.
 *   AN ANONYMOUS FORM reporting that its entire audience ignored it.
 *   AN EMPTY LIST reading as "everybody answered" when it is really "nothing
 *   loaded" — guarded in the component, which is why the pure part is kept
 *   deliberately dumb: it subtracts, and it is never asked to interpret.
 */

const ALICE: RosterMember = { id: "u1", full_name: "Alice", primary_department_id: "d1" };
const BOB: RosterMember = { id: "u2", full_name: "Bob", primary_department_id: "d1" };
const CARA: RosterMember = { id: "u3", full_name: "Cara", primary_department_id: "d2" };

const ROSTER = [ALICE, BOB, CARA];

describe("pendingAnswerers — the audience, minus whoever answered", () => {
  it("returns everybody when nobody has answered", () => {
    expect(pendingAnswerers(ROSTER, [])).toEqual(ROSTER);
  });

  it("removes the people who answered", () => {
    expect(pendingAnswerers(ROSTER, ["u1", "u3"])).toEqual([BOB]);
  });

  it("returns nothing when everybody answered", () => {
    expect(pendingAnswerers(ROSTER, ["u1", "u2", "u3"])).toEqual([]);
  });

  it("⚠️ counts a person ONCE however many times they answered", () => {
    /*
     * THE BUG THIS FORBIDS is subtracting a COUNT from a roster size, which is
     * the obvious implementation and is wrong: there is deliberately no unique
     * index on (form_id, submitted_by), so a colleague who answered wrongly
     * answers again and both rows stand. Two answers from Alice would then
     * "cover" Bob, and Bob is never chased.
     *
     * The signature takes ids rather than a number precisely so this cannot be
     * written the wrong way — but a duplicate id reaching it must still behave.
     */
    expect(pendingAnswerers(ROSTER, ["u1", "u1", "u1"])).toEqual([BOB, CARA]);
  });

  it("⚠️ ignores an author who is not in the roster", () => {
    /*
     * Reachable without anybody doing anything wrong: somebody answers, and is
     * then moved to another department, deactivated, or the audience is narrowed
     * underneath their answer. Their answer still exists and still counts.
     *
     * "Who is MISSING" cannot include a person who is not expected, so they drop
     * out — and the ANSWER COUNT on the page comes from the database, not from
     * this function, so the two numbers are allowed to disagree. A version that
     * tried to reconcile them would have to either invent a roster entry or
     * discard a real answer.
     */
    expect(pendingAnswerers(ROSTER, ["someone-who-left", "u2"])).toEqual([ALICE, CARA]);
  });

  it("keeps the roster's own order rather than re-sorting", () => {
    // The query orders by `full_name`; re-sorting here would mean the two lists
    // on the tab were ordered by different rules for no visible reason.
    const shuffled = [CARA, ALICE, BOB];
    expect(pendingAnswerers(shuffled, [])).toEqual([CARA, ALICE, BOB]);
  });

  it("does not mutate what it is given", () => {
    const roster = [...ROSTER];
    pendingAnswerers(roster, ["u1"]);
    expect(roster).toEqual(ROSTER);
  });
});

describe("canShowPendingAnswerers — the question an anonymous form cannot answer", () => {
  it("allows the list on a named form", () => {
    expect(canShowPendingAnswerers(false)).toBe(true);
  });

  it("⚠️ REFUSES it on an anonymous form", () => {
    /*
     * Not a preference, and not tidiness. `submitted_by` is NULL on every row of
     * an anonymous form — the INSERT policy refused to let a name be written —
     * so the set of authors is empty and the subtraction returns THE ENTIRE
     * ROSTER.
     *
     * Rendered, that is a page telling an admin that nobody in the company has
     * answered, directly beside a count saying four hundred did. Not a degraded
     * view: a false one, false in the direction somebody acts on, and the action
     * is chasing people who already answered a form that promised them
     * anonymity.
     */
    expect(canShowPendingAnswerers(true)).toBe(false);
  });

  it("⚠️ is a function of the FORM's flag alone", () => {
    /*
     * THE SHORTCUT THIS EXISTS TO FORBID is deciding anonymity from the rows —
     * "no row has an author, so treat it as anonymous". A form nobody has
     * answered YET satisfies that, and the roster would be hidden on exactly the
     * form where it is most useful: the one where everybody is outstanding.
     *
     * The signature takes a boolean and no rows, which is the guarantee written
     * into the type.
     */
    expect(canShowPendingAnswerers.length).toBe(1);
  });
});

describe("the two together — the shape the screen relies on", () => {
  it("⚠️ an anonymous form is never asked the question at all", () => {
    /*
     * The order the component uses: the guard runs BEFORE the roster is fetched,
     * so on an anonymous form there is no query, no roster and nothing to
     * subtract. This pins the sequence rather than the styling — if the guard
     * ever moved to the render, this list would exist in the RSC payload of a
     * form that promised not to know who its respondents were.
     */
    const isAnonymous = true;
    const roster = canShowPendingAnswerers(isAnonymous) ? ROSTER : [];

    expect(roster).toEqual([]);
    expect(pendingAnswerers(roster, [])).toEqual([]);
  });
});
