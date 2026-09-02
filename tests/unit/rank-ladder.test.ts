import { describe, expect, it } from "vitest";

import {
  LOWEST_RANK,
  offeredRank,
  rankBelow,
  rankImplied,
  rankLocked,
  rankTicked,
  RANK_LADDER,
} from "@/app/(app)/admin/users/rank-ladder";
import { ROLE_ORDER, type Role } from "@/lib/auth/roles";

/**
 * P8-01 — the rank ladder in `/admin/users`, asserted rather than eyeballed.
 *
 * Both bugs these cases pin were invisible in review and silent in use:
 *
 *   1. the Member checkbox rendered ENABLED, because `0 < 0` is false, and
 *      unticking it snapped straight back;
 *   2. a row still holding the dead `admin` rung could be promoted to Owner and
 *      never demoted — every offered rank was strictly below `admin`, so every
 *      one of them locked — while the form displayed "Manager" and saved
 *      `admin` straight back.
 *
 * The invariants below are written over EVERY stored role rather than the four
 * the picker offers, because a legacy `admin` row is exactly the input nobody
 * thinks to try.
 */

/** Every value the enum can hold, including the retired one. */
const STORED_ROLES: readonly Role[] = ROLE_ORDER;

describe("RANK_LADDER — what the form offers", () => {
  it("is the enum most-senior-first, with the dead rung removed", () => {
    expect([...RANK_LADDER]).toEqual(["owner", "manager", "team_leader", "member"]);
  });

  it("does not offer `admin`, which grants nothing", () => {
    expect(RANK_LADDER).not.toContain("admin");
    // …while the ORDER it is derived from still declares it. Removing it there
    // would shift every index against a `>=` in SQL that did not move.
    expect(ROLE_ORDER).toContain("admin");
  });

  it("bottoms out at member", () => {
    expect(LOWEST_RANK).toBe("member");
  });
});

describe("offeredRank — what a stored role opens as", () => {
  it("is the identity for every rank the form offers", () => {
    for (const rank of RANK_LADDER) {
      expect(offeredRank(rank)).toBe(rank);
    }
  });

  it("⚠️ normalises the dead `admin` rung to manager", () => {
    // Which is what the ticks ALREADY showed — `roleAtLeast("admin", "manager")`
    // is true — while the form went on holding and saving `admin`. This is the
    // line that makes displayed and saved the same value.
    expect(offeredRank("admin")).toBe("manager");
  });

  it("never returns a rank the form does not offer", () => {
    for (const role of STORED_ROLES) {
      expect(RANK_LADDER).toContain(offeredRank(role));
    }
  });
});

describe("⚠️ FIX 5 — the lowest rank is ALWAYS ticked and ALWAYS locked", () => {
  it("holds for every stored role, including the dead rung", () => {
    // The invariant the screen states in words ("everyone is at least a
    // member") and used not to honour: `rankLocked("member")` was
    // `index("member") < index("member")`, which is false, so the checkbox
    // rendered enabled for every member in the company.
    for (const role of STORED_ROLES) {
      expect(rankTicked(role, LOWEST_RANK)).toBe(true);
      expect(rankLocked(role, LOWEST_RANK)).toBe(true);
    }
  });

  it("means unticking it cannot move the role — which is why it must be locked", () => {
    // The snap-back, shown: the control offered a change and then produced the
    // value it started from. A disabled control is the honest version.
    expect(rankBelow(LOWEST_RANK)).toBe(LOWEST_RANK);
  });
});

describe("⚠️ FIX 4 — a stored `admin` row is demotable, and shows what it saves", () => {
  it("leaves Manager UNLOCKED so the row can be demoted", () => {
    // The bug: every offered rank was strictly below `admin` in ROLE_ORDER, so
    // Manager, Team Leader and Member all locked and Owner was the only thing
    // the form would accept. A dead rung that can only be promoted out of is a
    // one-way door.
    expect(rankLocked("admin", "manager")).toBe(false);
    expect(rankLocked("admin", "owner")).toBe(false);
  });

  it("unticking Manager lands on Team Leader, not on the dead rung", () => {
    expect(rankBelow("manager")).toBe("team_leader");
    expect(rankBelow("owner")).toBe("manager");
    expect(rankBelow("team_leader")).toBe("member");
  });

  it("never demotes INTO the retired value", () => {
    // `ROLE_ORDER.indexOf(owner) - 1` is `admin`. Stepping through RANK_LADDER
    // instead is what stops an owner meant to become a manager landing on a
    // rank that grants nothing and renders as "Admin (retired)".
    for (const rank of ROLE_ORDER) {
      expect(rankBelow(rank)).not.toBe("admin");
    }
  });

  it("shows Manager as the held rank rather than as an implied one", () => {
    // `rankImplied` is what the "Included in …" hint asserts. For a normalised
    // `admin` row the held rank is Manager, so Manager is ticked and NOT
    // implied — which is exactly what makes its checkbox operable.
    const held = offeredRank("admin");
    expect(held).toBe("manager");
    expect(rankImplied(held, "manager")).toBe(false);
    expect(rankImplied(held, "team_leader")).toBe(true);
  });
});

describe("the lock invariants, over every stored role", () => {
  /*
   * The property rather than a table of cases: for the rank a person actually
   * holds, the box must be ticked and OPERABLE (that is the demotion control);
   * for everything below it, ticked and locked; for everything above it,
   * unticked and operable (that is the promotion control). The bottom rung is
   * the single exception, and it is locked in every one of them.
   */
  for (const role of STORED_ROLES) {
    it(`holds for a stored \`${role}\``, () => {
      const held = offeredRank(role);

      for (const rank of RANK_LADDER) {
        const above = ROLE_ORDER.indexOf(rank) > ROLE_ORDER.indexOf(held);
        const below = ROLE_ORDER.indexOf(rank) < ROLE_ORDER.indexOf(held);

        expect(rankTicked(held, rank)).toBe(!above);
        expect(rankImplied(held, rank)).toBe(below);
        expect(rankLocked(held, rank)).toBe(below || rank === LOWEST_RANK);
      }
    });
  }

  it("leaves exactly one operable ticked rank for every role above member", () => {
    // The demotion control. Without it a record can only ever go up, which is
    // how the legacy `admin` row got stuck.
    for (const role of STORED_ROLES) {
      const held = offeredRank(role);
      if (held === LOWEST_RANK) continue;

      const operableTicked = RANK_LADDER.filter(
        (rank) => rankTicked(held, rank) && !rankLocked(held, rank),
      );
      expect(operableTicked).toEqual([held]);
    }
  });

  it("gives a stored `member` no operable checkbox below member", () => {
    // The other end of the same rule: a member has nothing to demote to, so
    // every ticked box they see is locked.
    const operableTicked = RANK_LADDER.filter(
      (rank) => rankTicked("member", rank) && !rankLocked("member", rank),
    );
    expect(operableTicked).toEqual([]);
  });
});
