import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  applyEntityMoves,
  deriveFieldKeys,
  nextOptionLabel,
  planEntityDrop,
  rootIndexForSlot,
  sameFormSchema,
  splitCanvasFields,
  unsavableReason,
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

/**
 * ⚠️ STILL THE ARITHMETIC A NEW QUESTION LANDS BY, though what calls it
 * changed. It was written for a palette drop; the palette is gone and Add
 * question now inserts DIRECTLY BELOW the question being edited. Both ask the
 * same thing — turn a position in the list somebody is LOOKING at into an
 * index in `root` — and the archived-field case below is the reason that is not
 * the same number.
 */
describe("rootIndexForSlot — where a new question lands", () => {
  it("inserts at the slot, pushing the card there down", () => {
    expect(rootIndexForSlot(FLAT, 0)).toBe(0);
    expect(rootIndexForSlot(FLAT, 2)).toBe(2);
  });

  it("appends at the end of the list", () => {
    expect(rootIndexForSlot(FLAT, 4)).toBe(4);
  });

  it("translates a VISIBLE slot into a root index across an archived field", () => {
    /*
     * ⚠️ THE BUG THIS FUNCTION EXISTS TO PREVENT. `budget` is the THIRD
     * question on the form and the FOURTH id in `root`, because the retired
     * field sits between them. Adding a question at `budget`'s slot has to
     * insert at root index 3 — passing the visible slot straight to `addEntity`
     * would insert it at 2, in front of the retired field and BEHIND `brief` on
     * screen: one position off, and only ever on forms that have archived
     * something.
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

// ---------------------------------------------------------------------------
// P7-66 — THE FIELD KEY IS GENERATED NOW, AND THERE IS NO BOX TO TYPE IT IN.
// ---------------------------------------------------------------------------

/** A schema built by hand, so a test can hold blank labels and blank keys. */
function draft(
  entities: { id: string; label: string; key?: string; type?: FormSchema["entities"][string]["type"]; options?: string[] }[],
): FormSchema {
  return {
    root: entities.map((entity) => entity.id),
    entities: Object.fromEntries(
      entities.map((entity) => [
        entity.id,
        {
          type: entity.type ?? "text",
          attributes: {
            key: entity.key ?? "",
            label: entity.label,
            helpText: "",
            required: true,
            options: entity.options ?? [],
            archived: false,
          },
        },
      ]),
    ),
  } as FormSchema;
}

describe("deriveFieldKeys", () => {
  it("mints a key from the question", () => {
    const schema = draft([{ id: NAME_ID, label: "Your company name" }]);

    expect(deriveFieldKeys(schema, new Set())).toEqual([
      { entityId: NAME_ID, key: "your_company_name" },
    ]);
  });

  it("never touches a field that is already a row", () => {
    /*
     * ⚠️ THE ONE THAT WOULD ORPHAN DATA. A locked field's key is what every
     * stored answer is filed under, `vizserve_pms_form_field_protect` refuses to
     * rename it, and re-deriving from a retyped label would silently point the
     * form at a column that has nothing in it.
     */
    const schema = draft([{ id: NAME_ID, label: "Anything else?", key: "notes" }]);

    expect(deriveFieldKeys(schema, new Set([NAME_ID]))).toEqual([]);
  });

  it("de-duplicates against a locked field's key", () => {
    const schema = draft([
      { id: NAME_ID, label: "Notes", key: "notes" },
      { id: BRIEF_ID, label: "Notes" },
    ]);

    expect(deriveFieldKeys(schema, new Set([NAME_ID]))).toEqual([
      { entityId: BRIEF_ID, key: "notes_2" },
    ]);
  });

  it("de-duplicates two new questions against each other", () => {
    const schema = draft([
      { id: NAME_ID, label: "Notes" },
      { id: BRIEF_ID, label: "Notes" },
      { id: BUDGET_ID, label: "Notes" },
    ]);

    expect(deriveFieldKeys(schema, new Set())).toEqual([
      { entityId: NAME_ID, key: "notes" },
      { entityId: BRIEF_ID, key: "notes_2" },
      { entityId: BUDGET_ID, key: "notes_3" },
    ]);
  });

  it("⚠️ de-duplicates against an ARCHIVED question too", () => {
    /*
     * The one a naive derivation gets wrong. An archived question is off the
     * form and its answers are NOT gone — they are still filed under its key and
     * the Responses table still draws a column for it. Two fields sharing a key
     * would file two different questions' answers in one place.
     */
    const schema = draft([
      { id: RETIRED_ID, label: "Notes", key: "notes" },
      { id: BRIEF_ID, label: "Notes" },
    ]);

    schema.entities[RETIRED_ID]!.attributes.archived = true;

    expect(deriveFieldKeys(schema, new Set([RETIRED_ID]))).toEqual([
      { entityId: BRIEF_ID, key: "notes_2" },
    ]);
  });

  it("derives nothing from a question with no name yet", () => {
    // There is nothing to derive from, and the document is unsavable anyway —
    // `unsavableReason` is what says so.
    const schema = draft([{ id: NAME_ID, label: "   " }]);

    expect(deriveFieldKeys(schema, new Set())).toEqual([]);
  });

  it("reports no change when the key it would mint is already there", () => {
    // The common case on every save after the first: the caller can skip the
    // store writes entirely.
    const schema = draft([{ id: NAME_ID, label: "Notes", key: "notes" }]);

    expect(deriveFieldKeys(schema, new Set())).toEqual([]);
  });

  it("is deterministic in `root` order, not object-key order", () => {
    const schema = draft([
      { id: BUDGET_ID, label: "Notes" },
      { id: NAME_ID, label: "Notes" },
    ]);

    // Reversing `root` alone must reverse which one gets the plain key.
    const reversed: FormSchema = { ...schema, root: [...schema.root].reverse() };

    expect(deriveFieldKeys(schema, new Set())[0]).toEqual({ entityId: BUDGET_ID, key: "notes" });
    expect(deriveFieldKeys(reversed, new Set())[0]).toEqual({ entityId: NAME_ID, key: "notes" });
  });
});

// ---------------------------------------------------------------------------
// P7-66 — WHAT AUTOSAVE WAITS FOR.
//
// With a Save button, an incomplete question was somebody pressing Save and
// being told. With no button the builder decides for itself when to write, and
// it writes the WHOLE document — so this is what stands between a half-typed
// question and a refusal painted under it on every keystroke's debounce.
// ---------------------------------------------------------------------------

describe("unsavableReason", () => {
  it("passes a complete document", () => {
    expect(unsavableReason(FLAT)).toBeNull();
  });

  it("blocks on a question with no name, and names it", () => {
    const schema = draft([
      { id: NAME_ID, label: "Your name", key: "your_name" },
      { id: BRIEF_ID, label: "" },
    ]);

    expect(unsavableReason(schema)?.entityId).toBe(BRIEF_ID);
  });

  it("treats a label of only spaces as no name", () => {
    // Matching `labelAttribute`, which refuses it — accepting it here would hand
    // the save a document the library then rejects.
    expect(unsavableReason(draft([{ id: NAME_ID, label: "   " }]))?.entityId).toBe(NAME_ID);
  });

  it("blocks a choice question with no choices", () => {
    const schema = draft([{ id: NAME_ID, label: "Which pages?", type: "select", options: [] }]);

    expect(unsavableReason(schema)?.message).toMatch(/at least one choice/i);
  });

  it("blocks an EMPTY choice rather than dropping it, and says which row", () => {
    /*
     * `optionsAttribute` refuses `""`, so the document cannot be written — and
     * silently removing the row would delete, mid-keystroke, a choice somebody
     * had just cleared in order to retype.
     */
    const schema = draft([
      { id: NAME_ID, label: "Which pages?", type: "select", options: ["Home", "  ", "Contact"] },
    ]);

    expect(unsavableReason(schema)?.message).toContain("Choice 2");
  });

  it("ignores choices on a type that has none", () => {
    const schema = draft([{ id: NAME_ID, label: "Notes", type: "text", options: [] }]);

    expect(unsavableReason(schema)).toBeNull();
  });

  it("reports the FIRST problem only", () => {
    // The canvas has one place to put this sentence. A list of everything wrong
    // with a form somebody is still writing is a wall of red.
    const schema = draft([
      { id: NAME_ID, label: "" },
      { id: BRIEF_ID, label: "" },
    ]);

    expect(unsavableReason(schema)?.entityId).toBe(NAME_ID);
  });

  it("checks archived questions too", () => {
    /*
     * They cannot normally be invalid — they were saved once, so they carry a
     * label — but they travel in the same document and the save carries them.
     * Skipping them would report "ready" on a document Postgres then refuses for
     * a reason nothing on screen mentions.
     */
    const schema = draft([{ id: RETIRED_ID, label: "" }]);
    schema.entities[RETIRED_ID]!.attributes.archived = true;

    expect(unsavableReason(schema)?.entityId).toBe(RETIRED_ID);
  });
});

describe("nextOptionLabel", () => {
  it("names the next choice by position on an untouched list", () => {
    expect(nextOptionLabel(["Option 1", "Option 2"])).toBe("Option 3");
  });

  it("⚠️ does not repeat a name after a row in the middle is removed", () => {
    /*
     * THE BUG THIS EXISTS FOR. `Option ${length + 1}` on ["Option 1",
     * "Option 3"] mints "Option 3" — which is already there. Nothing rejects a
     * duplicate option (`optionsAttribute` refuses only an EMPTY one), so
     * `z.enum(["Option 1", "Option 3", "Option 3"])` ships and the respondent
     * is offered two choices they cannot tell apart.
     */
    expect(nextOptionLabel(["Option 1", "Option 3"])).toBe("Option 4");
  });

  it("skips past a run of names somebody typed by hand", () => {
    expect(nextOptionLabel(["Option 3", "Option 4", "Option 5"])).toBe("Option 6");
  });

  it("ignores choices that are not named this way at all", () => {
    expect(nextOptionLabel(["Home", "Pricing"])).toBe("Option 3");
  });

  it("terminates on a list built entirely of collisions", () => {
    // The bound the loop relies on: among n rows there can be at most n
    // collisions, so a free name exists within n + 1.
    expect(nextOptionLabel(["Option 3", "Option 4"])).toBe("Option 5");
  });
});

/*
 * ⚠️ WHAT ONLY A BROWSER CAN CONFIRM. None of it is covered above, and saying so
 * is more useful than a test that pretends to.
 *
 * ⚠️ REWRITTEN FOR THE THREE-PANE LAYOUT. The two-column canvas, its overlay
 * buttons, the Add-question dialog and the Save/Cancel pair are all gone; every
 * item below refers to what is on the screen now.
 *
 *  --- the drag, which is the part no unit test can reach ---
 *   1. That a drag STARTS at all — dnd-kit's pointer sensor has an 8px
 *      activation distance, so a grip that is too small or a `touch-action` that
 *      is wrong produces a scroll instead of a drag.
 *   2. That `over.id` is the row the person believes they are on. Collision
 *      detection is geometry; jsdom gives every element a zero-sized rect.
 *   3. That the sortable transform previews the new order and the overlay
 *      follows the cursor without a second copy of the row moving with it.
 *   4. dnd-kit's keyboard sensor off the grip, and that it does not fight the
 *      up/down buttons beside it.
 *
 *  --- autosave, which is the new mechanism ---
 *   5. THAT IT ACTUALLY SAVES. Type a question, wait out the 900ms pause, and
 *      confirm the top bar goes Saving… → All changes saved and that a reload
 *      shows the question. Then confirm a SECOND change during the same dirty
 *      spell RESTARTS the pause rather than saving mid-word.
 *   6. THAT AN INCOMPLETE QUESTION BLOCKS IT QUIETLY. Add a question and type
 *      nothing: the bar must read "Unsaved changes", the editor must show the
 *      "give this question a name" line, and NO red attribute error may appear —
 *      `validateSchema` writes those as a side effect and must not be running on
 *      the debounce.
 *   7. THAT THE BLOCKING QUESTION CAN BE FOUND. Leave question 6 unnamed, open
 *      question 2, and confirm the warning under the editor names it and opens
 *      it when pressed.
 *   8. THAT `router.refresh()` MID-TYPING DOES NOT DISCARD ANYTHING. Save one
 *      question, then immediately type into another before the refresh lands —
 *      `useFormBuilderStore` reads `initialData` once, and this is what proves
 *      it.
 *   9. That closing the tab within the debounce window loses at most the last
 *      pause, and that nothing warns falsely when it does not.
 *
 *  --- the three panes ---
 *  10. At 1280px, 1180px, 760px and 390px, in both themes: three columns, then
 *      the preview dropping full-width beneath, then the type rail going
 *      full-width above the list. Each pane scrolls independently above 1180px
 *      and the page scrolls as one document below it — a form with thirty
 *      questions must not scroll the type rail away.
 *  11. That the type rail's buttons add a question DIRECTLY BELOW the open one,
 *      on a form with an archived question in the middle of it, and that the new
 *      question's label input takes focus.
 *  12. THE PREVIEW IS THE FORM. Confirm the right pane draws the same controls
 *      /request/[slug] and /respond/[slug] draw, that every one is disabled and
 *      OUT OF THE TAB ORDER, and that typing a label or a choice updates it as
 *      you type.
 *  13. That the desktop/mobile toggle actually reflows the two-column "Your
 *      details" block and the choice lists.
 *  14. That a client form shows the five fixed fields and a staff form shows
 *      none, and that a staff form shows the anonymity notice matching its
 *      Settings switch.
 *
 *  --- the editor ---
 *  15. THE ANSWER TYPE CHANGE, which is a delete plus an add. Change question
 *      2's type on a form of four and confirm it stays at position 2, keeps its
 *      label, help text and required flag, keeps its choices going
 *      select→multiselect and loses them going select→text, and that the editor
 *      stays open on it (the entity id changes).
 *  16. That the type select is DISABLED on a form with submissions, and that
 *      Delete has become Archive there.
 *  17. Duplicate: that the copy lands directly below, opens, and — after the
 *      save — carries a DIFFERENT field key from the original.
 *  18. That deleting a never-saved question needs no save, and deleting a saved
 *      one writes.
 *  19. The inline choices: add, remove, that the last row cannot be removed,
 *      that a typed SPACE survives (the textarea this replaced ate one), and
 *      that clearing a row blocks the save with the row number named.
 *
 *  --- the chrome ---
 *  20. The tab strip: that switching to Responses and back keeps the open
 *      question, the selection and the scroll position (`keepMounted`), and that
 *      a `?tab=responses&page=2` link opens on the Responses tab.
 *  21. The in-place title: that Enter commits, that Escape abandons WITHOUT
 *      saving, that clearing it and clicking away restores the name rather than
 *      leaving a blank, and that a rename reaches the Settings tab's Name field.
 *  22. That `toast` still appears — this route left the `(app)` shell, and the
 *      `Toaster` it depends on is mounted in the ROOT layout rather than the one
 *      it left. That reasoning is in `app/(builder)/layout.tsx`; only the
 *      browser proves it.
 */
