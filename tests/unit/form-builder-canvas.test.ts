import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  addsFieldOnKey,
  applyEntityMoves,
  planEntityDrop,
  rootIndexForSlot,
  sameFormSchema,
  showsInsertGuide,
  splitCanvasFields,
} from "@/lib/form-builder/canvas";
import { planEntityReorder, schemaFromFields, type FormFieldRow } from "@/lib/form-builder/schema";

/**
 * P7-66 Phase 4a — the drag-and-drop builder's DECISIONS.
 *
 * ⚠️ NOTHING HERE FAKES A DRAG, DELIBERATELY. A drag is a pointer gesture over
 * real geometry — dnd-kit measures the cards, decides which one the pointer is
 * over and hands back an `over.id`. Synthesising that in jsdom, where every
 * element has a zero-sized bounding box, tests the synthesiser and nothing else.
 *
 * So the gesture is split. `lib/form-builder/dnd.tsx` reports the browser's
 * answer and is checked BY HAND IN A BROWSER — see the note at the end of this
 * file for exactly what that means. `lib/form-builder/canvas.ts` decides what
 * follows from the answer, is pure, and is checked here.
 *
 * The claim these tests exist to hold up is the one in the brief: DRAG AND THE
 * UP/DOWN BUTTONS ARE ONE ORDERING RULE. `planEntityDrop` is a loop over
 * `planEntityReorder`, so a drag of n places is n presses of the arrow — and
 * `describe("drag and the buttons agree")` asserts that against the buttons
 * themselves rather than against a restatement of what they do.
 */

const NAME_ID = "d1000000-0000-4000-8000-000000000001";
const BRIEF_ID = "d1000000-0000-4000-8000-000000000002";
const BUDGET_ID = "d1000000-0000-4000-8000-000000000003";
const DEADLINE_ID = "d1000000-0000-4000-8000-000000000004";
const RETIRED_ID = "d1000000-0000-4000-8000-0000000000aa";
const ABSENT_ID = "d1000000-0000-4000-8000-0000000000ff";

function row(overrides: Partial<FormFieldRow> & { id: string; field_key: string }): FormFieldRow {
  return {
    label: overrides.field_key,
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    is_active: true,
    sort_order: 0,
    created_at: "2026-09-02T10:00:00Z",
    ...overrides,
  };
}

/** Four questions, in order, none archived. */
const FLAT = schemaFromFields([
  row({ id: NAME_ID, field_key: "name", sort_order: 0 }),
  row({ id: BRIEF_ID, field_key: "brief", sort_order: 1 }),
  row({ id: BUDGET_ID, field_key: "budget", sort_order: 2 }),
  row({ id: DEADLINE_ID, field_key: "deadline", sort_order: 3 }),
]);

/**
 * The same form with a RETIRED field sitting between the second and third.
 *
 * This is the shape every ordering bug in this area has been about: the archived
 * field holds a place in `root` and appears nowhere on the canvas, so "the row
 * below" and "the next id" are different fields.
 */
const WITH_ARCHIVED = schemaFromFields([
  row({ id: NAME_ID, field_key: "name", sort_order: 0 }),
  row({ id: BRIEF_ID, field_key: "brief", sort_order: 1 }),
  row({ id: RETIRED_ID, field_key: "retired", sort_order: 2, is_active: false }),
  row({ id: BUDGET_ID, field_key: "budget", sort_order: 3 }),
  row({ id: DEADLINE_ID, field_key: "deadline", sort_order: 4 }),
]);

/** The order somebody is looking at, after a plan is applied. */
function visibleAfter(schema: FormSchema, moves: ReturnType<typeof planEntityDrop>): string[] {
  const root = applyEntityMoves(schema.root, moves);
  return splitCanvasFields({ ...schema, root }).active.map((field) => field.id);
}

/** Pressing one arrow button n times, which is what a drag has to equal. */
function pressArrow(schema: FormSchema, entityId: string, direction: "up" | "down", times: number) {
  let working = schema;

  for (let step = 0; step < times; step += 1) {
    const moves = planEntityReorder(working, entityId, direction);
    if (moves.length === 0) break;
    working = { ...working, root: applyEntityMoves(working.root, moves) };
  }

  return working.root;
}

describe("splitCanvasFields", () => {
  it("keeps root order within each list", () => {
    const { active, archived } = splitCanvasFields(WITH_ARCHIVED);

    expect(active.map((field) => field.id)).toEqual([NAME_ID, BRIEF_ID, BUDGET_ID, DEADLINE_ID]);
    expect(archived.map((field) => field.id)).toEqual([RETIRED_ID]);
  });

  it("drops a root id with no entity behind it", () => {
    // The builder store cannot produce one. It is dropped rather than rendered
    // because there is no component to render for an entity that is not there —
    // note this is the OPPOSITE of `planEntityReorder`, which keeps it, because
    // that function decides an order and must not silently edit the schema.
    const broken: FormSchema = { ...FLAT, root: [...FLAT.root, ABSENT_ID] };

    expect(splitCanvasFields(broken).active.map((field) => field.id)).toEqual([
      NAME_ID,
      BRIEF_ID,
      BUDGET_ID,
      DEADLINE_ID,
    ]);
  });
});

describe("rootIndexForSlot — where a palette drop inserts", () => {
  it("inserts before the card it was dropped on", () => {
    expect(rootIndexForSlot(FLAT, 0)).toBe(0);
    expect(rootIndexForSlot(FLAT, 2)).toBe(2);
  });

  it("appends at the end of the list", () => {
    expect(rootIndexForSlot(FLAT, 4)).toBe(4);
  });

  it("translates a VISIBLE slot into a root index across an archived field", () => {
    /*
     * ⚠️ THE BUG THIS FUNCTION EXISTS TO PREVENT. `budget` is the THIRD card on
     * the canvas and the FOURTH id in `root`, because the retired field sits
     * between them. Dropping a new field onto `budget` has to insert at root
     * index 3 — passing the visible slot straight to `addEntity` would insert it
     * at 2, in front of the retired field and BEHIND `brief` on screen: one
     * position off, and only ever on forms that have archived something.
     */
    expect(rootIndexForSlot(WITH_ARCHIVED, 2)).toBe(3);
    expect(rootIndexForSlot(WITH_ARCHIVED, 3)).toBe(4);
  });

  it("appends past the archived tail rather than in front of it", () => {
    expect(rootIndexForSlot(WITH_ARCHIVED, 4)).toBe(5);
  });

  it("clamps a slot that is out of range", () => {
    expect(rootIndexForSlot(FLAT, -3)).toBe(0);
    expect(rootIndexForSlot(FLAT, 99)).toBe(4);
  });
});

describe("planEntityDrop", () => {
  it("moves a card down two places", () => {
    expect(visibleAfter(FLAT, planEntityDrop(FLAT, NAME_ID, 2))).toEqual([
      BRIEF_ID,
      BUDGET_ID,
      NAME_ID,
      DEADLINE_ID,
    ]);
  });

  it("moves a card up as well as down", () => {
    expect(visibleAfter(FLAT, planEntityDrop(FLAT, DEADLINE_ID, 1))).toEqual([
      NAME_ID,
      DEADLINE_ID,
      BRIEF_ID,
      BUDGET_ID,
    ]);
  });

  it("plans nothing for a drop onto its own position", () => {
    expect(planEntityDrop(FLAT, BRIEF_ID, 1)).toEqual([]);
  });

  it("plans nothing for an id that is not on this form", () => {
    expect(planEntityDrop(FLAT, ABSENT_ID, 2)).toEqual([]);
  });

  it("clamps a target past the end of the visible list", () => {
    expect(visibleAfter(FLAT, planEntityDrop(FLAT, NAME_ID, 99))).toEqual([
      BRIEF_ID,
      BUDGET_ID,
      DEADLINE_ID,
      NAME_ID,
    ]);
  });

  it("steps over an archived field, which keeps its place in root", () => {
    // `brief` dragged one card down lands after `budget` on screen. The retired
    // field is not a position anybody can drop into, and it does not move.
    const moves = planEntityDrop(WITH_ARCHIVED, BRIEF_ID, 2);
    const root = applyEntityMoves(WITH_ARCHIVED.root, moves);

    expect(splitCanvasFields({ ...WITH_ARCHIVED, root }).active.map((f) => f.id)).toEqual([
      NAME_ID,
      BUDGET_ID,
      BRIEF_ID,
      DEADLINE_ID,
    ]);
    expect(root).toContain(RETIRED_ID);
    expect(root).toHaveLength(5);
  });
});

/**
 * ⚠️ THE CLAIM THE WHOLE PHASE RESTS ON.
 *
 * Drag is a pointer-only enhancement over a keyboard path that has to keep
 * working (WCAG 2.2 AA 2.1.1). If the two produced different orders, the
 * accessible route would be the WRONG one — a worse failure than not shipping
 * drag at all, because it would be invisible to whoever built it.
 *
 * These do not compare `planEntityDrop` to a restatement of the arrow rule. They
 * compare it to the arrow BUTTONS, driven through `planEntityReorder` exactly as
 * `FieldCard`'s `onMove` drives them.
 */
describe("drag and the buttons agree", () => {
  it.each([
    { name: "one place down", id: NAME_ID, to: 1, direction: "down" as const, presses: 1 },
    { name: "two places down", id: NAME_ID, to: 2, direction: "down" as const, presses: 2 },
    { name: "to the end", id: NAME_ID, to: 3, direction: "down" as const, presses: 3 },
    { name: "two places up", id: DEADLINE_ID, to: 1, direction: "up" as const, presses: 2 },
    { name: "to the top", id: DEADLINE_ID, to: 0, direction: "up" as const, presses: 3 },
  ])("$name is the same as pressing the arrow $presses times", ({ id, to, direction, presses }) => {
    expect(applyEntityMoves(FLAT.root, planEntityDrop(FLAT, id, to))).toEqual(
      pressArrow(FLAT, id, direction, presses),
    );
  });

  it("agrees across an archived field too", () => {
    // The case the rule was got wrong on twice. Both routes must step over the
    // retired field and leave it where it is.
    expect(applyEntityMoves(WITH_ARCHIVED.root, planEntityDrop(WITH_ARCHIVED, NAME_ID, 3))).toEqual(
      pressArrow(WITH_ARCHIVED, NAME_ID, "down", 3),
    );
  });
});

describe("sameFormSchema — the reason the list locks", () => {
  it("calls an untouched document unchanged", () => {
    expect(sameFormSchema(FLAT, schemaFromFields([...FLAT.root].map((id) => rowFor(id))))).toBe(
      true,
    );
  });

  it("ignores the order of the entities record", () => {
    // `setEntityIndex` and `addEntity` are free to rewrite it, and two forms
    // differing only in that are the same form. `root` is what carries order.
    const reversed: FormSchema = {
      root: FLAT.root,
      entities: Object.fromEntries(Object.entries(FLAT.entities).reverse()),
    };

    expect(sameFormSchema(FLAT, reversed)).toBe(true);
  });

  it("sees a reordered form as changed", () => {
    const moved: FormSchema = {
      ...FLAT,
      root: applyEntityMoves(FLAT.root, planEntityDrop(FLAT, NAME_ID, 2)),
    };

    expect(sameFormSchema(FLAT, moved)).toBe(false);
  });

  it("sees a retyped label as changed", () => {
    const edited: FormSchema = {
      root: FLAT.root,
      entities: {
        ...FLAT.entities,
        [BRIEF_ID]: {
          ...FLAT.entities[BRIEF_ID]!,
          attributes: { ...FLAT.entities[BRIEF_ID]!.attributes, label: "What do you need?" },
        },
      },
    };

    expect(sameFormSchema(FLAT, edited)).toBe(false);
  });

  it("sees an edited option list as changed", () => {
    const edited: FormSchema = {
      root: FLAT.root,
      entities: {
        ...FLAT.entities,
        [BUDGET_ID]: {
          ...FLAT.entities[BUDGET_ID]!,
          attributes: { ...FLAT.entities[BUDGET_ID]!.attributes, options: ["Under 5k"] },
        },
      },
    };

    expect(sameFormSchema(FLAT, edited)).toBe(false);
  });

  it("sees an archived field as changed", () => {
    const edited: FormSchema = {
      root: FLAT.root,
      entities: {
        ...FLAT.entities,
        [BUDGET_ID]: {
          ...FLAT.entities[BUDGET_ID]!,
          attributes: { ...FLAT.entities[BUDGET_ID]!.attributes, archived: true },
        },
      },
    };

    expect(sameFormSchema(FLAT, edited)).toBe(false);
  });

  it("sees an added field as changed", () => {
    expect(sameFormSchema(FLAT, WITH_ARCHIVED)).toBe(false);
  });
});

/**
 * ⚠️ ADDING A FIELD WITHOUT A MOUSE. The palette was unusable by keyboard: both
 * keys a `<button>` responds to were being taken by dnd-kit's `KeyboardSensor`
 * activator, which `preventDefault()`s them to begin a keyboard drag — a drag
 * that could then never move, because `sortableKeyboardCoordinates` returns
 * `undefined` for an `active.id` that is not a droppable container and a
 * palette entry is `useDraggable` only. Enter did nothing; Escape was the exit.
 *
 * `PaletteDragButton` now answers both keys itself. This is the decision it
 * asks, and BOTH KEYS ARE ASSERTED HERE because "Enter works" was true of the
 * intent and false of the code.
 */
describe("addsFieldOnKey — the palette's keyboard path", () => {
  it("adds on Enter AND on Space", () => {
    // `event.key` for the space bar is a single space, not "Space" — writing
    // the wrong one is how this fix would silently only half-land.
    expect(addsFieldOnKey("Enter")).toBe(true);
    expect(addsFieldOnKey(" ")).toBe(true);
  });

  it("leaves every other key alone", () => {
    for (const key of ["Escape", "Tab", "ArrowDown", "ArrowUp", "a", "Space", "Spacebar", ""]) {
      expect(addsFieldOnKey(key)).toBe(false);
    }
  });
});

/**
 * ⚠️ THE PREVIEW HAS TO MEAN WHAT THE DROP DOES.
 *
 * dnd-kit draws no preview at all for a palette drag: `SortableContext` sets
 * `disableTransforms` whenever `overIndex !== -1 && activeIndex === -1`, which
 * is every drag whose active item is not in `itemIds` — and a palette entry
 * never is. So the person hovered a card and nothing moved.
 *
 * The rule is drawn ABOVE the hovered card. These tests hold that against
 * `rootIndexForSlot` rather than against a restatement of it, so the two cannot
 * drift into disagreeing about which side the field lands on.
 */
describe("showsInsertGuide — where a palette drop says it will land", () => {
  it("marks the hovered card, and only the hovered card", () => {
    const drag = { kind: "new" } as const;

    expect(showsInsertGuide(drag, BUDGET_ID, BUDGET_ID)).toBe(true);
    expect(showsInsertGuide(drag, BUDGET_ID, BRIEF_ID)).toBe(false);
    expect(showsInsertGuide(drag, BUDGET_ID, DEADLINE_ID)).toBe(false);
  });

  it("draws nothing for a reorder drag — dnd-kit already previews that one", () => {
    expect(showsInsertGuide({ kind: "move" }, BUDGET_ID, BUDGET_ID)).toBe(false);
  });

  it("draws nothing when there is no drag, and nothing over the end zone", () => {
    expect(showsInsertGuide(null, BUDGET_ID, BUDGET_ID)).toBe(false);
    // Past the last card the end zone lights up instead, which is its own hover
    // state and not a card's business.
    expect(showsInsertGuide({ kind: "new" }, null, BUDGET_ID)).toBe(false);
  });

  it("marks the card the field is inserted ABOVE, at every visible slot", () => {
    // The agreement that matters. For each visible card, the guide is on it and
    // `rootIndexForSlot` returns THAT card's own root index — i.e. the new
    // field takes its place and pushes it down. A guide below the hovered card
    // would be the opposite of what the drop does.
    const { active } = splitCanvasFields(WITH_ARCHIVED);

    active.forEach((field, slot) => {
      expect(showsInsertGuide({ kind: "new" }, field.id, field.id)).toBe(true);
      expect(rootIndexForSlot(WITH_ARCHIVED, slot)).toBe(WITH_ARCHIVED.root.indexOf(field.id));
    });
  });
});

const KEYS: Record<string, string> = {
  [NAME_ID]: "name",
  [BRIEF_ID]: "brief",
  [BUDGET_ID]: "budget",
  [DEADLINE_ID]: "deadline",
};

/** The same row `FLAT` was built from, rebuilt — a second, equal document. */
function rowFor(id: string): FormFieldRow {
  return row({ id, field_key: KEYS[id]!, sort_order: FLAT.root.indexOf(id) });
}

/*
 * ⚠️ WHAT ONLY A BROWSER CAN CONFIRM. None of it is covered above, and saying so
 * is more useful than a test that pretends to.
 *
 *   1. That a drag STARTS at all — dnd-kit's pointer sensor has an 8px
 *      activation distance, so a grip that is too small or a `touch-action` that
 *      is wrong produces a scroll instead of a drag.
 *   2. That `over.id` is the card the person believes they are on. Collision
 *      detection is geometry; jsdom gives every element a zero-sized rect.
 *   3. That clicking a card still SELECTS it rather than beginning a drag, and
 *      that the three buttons on a card still fire.
 *   4. That the sortable transform previews the new order, and that the overlay
 *      follows the cursor without a second copy of the card moving with it.
 *   5. The drop zone past the last card lighting up, and the empty-canvas
 *      version of it accepting the first field.
 *   6. dnd-kit's keyboard sensor off the grip, and that it does not fight the
 *      up/down buttons.
 *   6a. That Enter and Space on a PALETTE entry add a field — the pure decision
 *      is `addsFieldOnKey` above, but that the key actually reaches it, that
 *      `preventDefault` stops dnd-kit's activator, and that Space does not also
 *      synthesise a second click, are all real-DOM facts. Tab to a palette
 *      entry, press Enter, then Space; expect exactly one new field each time
 *      and the panel opening on it.
 *   6b. That the grip is skipped by Tab while the list is locked — it now
 *      carries the real `disabled` attribute rather than only `aria-disabled`.
 *   6c. That clicking a card mid-save does nothing at all: start a reorder
 *      save, click another card before the toast, and confirm the canvas order
 *      is the saved one and the next save writes it.
 *   6d. That the insertion rule appears ABOVE the hovered card during a palette
 *      drag, in the 8px gap, in both themes.
 *   7. The three-column layout at 1280px and 390px, in both themes, and the
 *      panel's sticky offset under the 56px header.
 *   8. That `toast` still appears — this route left the `(app)` shell, and the
 *      `Toaster` it depends on is mounted in the ROOT layout rather than the one
 *      it left. That reasoning is in `app/(builder)/layout.tsx`; only the
 *      browser proves it.
 */
