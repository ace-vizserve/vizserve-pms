import type { FormSchema, FormSchemaEntity } from "@/lib/form-builder/builder";
import { planEntityReorder, type EntityIndexMove } from "@/lib/form-builder/schema";
import { FIELD_TYPES, type FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 4a — EVERY DECISION THE DRAG-AND-DROP BUILDER MAKES, WITH NO DOM
 * AND NO LIBRARY IN SIGHT.
 *
 * A drag cannot be unit-tested: it is a pointer gesture over real geometry, and
 * faking one only tests the fake. So the gesture is split in two. The part a
 * browser owns — where the pointer is, and which card it ended over — lives in
 * `lib/form-builder/dnd.tsx` and is checked by hand. Everything that follows
 * from the answer lives HERE, is pure, and is checked by
 * `tests/unit/form-builder-canvas.test.ts`.
 *
 * ⚠️ THERE IS EXACTLY ONE ORDERING RULE, AND DRAG DOES NOT GET ITS OWN.
 * `planEntityDrop` is a LOOP OVER `planEntityReorder` — the same function the
 * up/down buttons call, which is the same rule as `planFieldReorder`, which is
 * the rule that was got wrong twice before it was pinned down in one tested
 * place. Dragging a card three places is therefore, by construction and not by
 * coincidence, pressing the down arrow three times: the archived-field skip, the
 * dense renumbering and the remove-then-insert call ordering all come along
 * unchanged, and a drag can never disagree with the keyboard about where a field
 * ended up.
 */

/** What each field type is called on screen. The enum value is never shown. */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  date: "Date",
  select: "Choose one",
  multiselect: "Choose many",
  file: "File upload",
  email: "Email",
  number: "Number",
};

/** One line of "what would I use this for", for the palette. */
export const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  text: "A name, a URL, one line",
  textarea: "A brief, several sentences",
  date: "A deadline or an event day",
  select: "One option from a list",
  multiselect: "Any number from a list",
  file: "An upload the team will need",
  email: "A checked email address",
  number: "A quantity or a budget",
};

/** The palette, in the order it is offered. */
export const PALETTE_FIELD_TYPES: ReadonlyArray<FieldType> = FIELD_TYPES;

/** One field on the canvas: the entity, and the id it is filed under. */
export type CanvasField = { id: string; entity: FormSchemaEntity };

/**
 * The two lists the builder renders — what is on the form, and what has been
 * retired from it.
 *
 * A `root` id with no entity behind it is DROPPED here rather than treated as
 * active, which is the opposite of what `planEntityReorder` does with one, and
 * deliberately so: that function is deciding an ORDER and must not silently
 * edit the schema it was handed, while this one is deciding what to RENDER and
 * has no component to render for an entity that is not there. The builder store
 * cannot produce one either way.
 */
export function splitCanvasFields(schema: FormSchema): {
  active: CanvasField[];
  archived: CanvasField[];
} {
  const active: CanvasField[] = [];
  const archived: CanvasField[] = [];

  for (const entityId of schema.root) {
    if (!Object.hasOwn(schema.entities, entityId)) continue;

    const entity = schema.entities[entityId]!;
    (entity.attributes.archived === true ? archived : active).push({ id: entityId, entity });
  }

  return { active, archived };
}

/**
 * `setEntityIndex` modelled: REMOVE, then splice-insert.
 *
 * Measured in the shipped `dist`, and it is why a move is an ORDERED list of
 * calls rather than a set of positions. `planEntityDrop` needs it to know what
 * the list looks like after step N before it can plan step N+1, and the tests
 * need it to assert about the order somebody ends up looking at rather than
 * about the numbers in the plan.
 */
export function applyEntityMoves(
  root: ReadonlyArray<string>,
  moves: ReadonlyArray<EntityIndexMove>,
): string[] {
  const next = [...root];

  for (const move of moves) {
    const at = next.indexOf(move.entityId);
    if (at < 0) continue;
    next.splice(at, 1);
    next.splice(move.index, 0, move.entityId);
  }

  return next;
}

/**
 * Where a palette drop inserts, expressed as a `root` index for
 * `addFieldEntity`.
 *
 * A SLOT is a gap in the visible list, numbered 0…n: slot 0 is above the first
 * card, slot n is past the last. Dropping a palette type onto the card at
 * visible index i inserts AT i and pushes that card down, which is dnd-kit's own
 * convention for `over` and therefore what the sortable preview has already
 * shown the person before they let go.
 *
 * ⚠️ A VISIBLE SLOT IS NOT A `root` INDEX. Archived fields keep their place in
 * `root` and render in their own list, so "third on the form" and "third in the
 * blob" stop agreeing the moment a field is retired. The slot is resolved
 * through the id currently standing in it; the end of the list is the end of
 * `root`, which puts a new field after the archived tail rather than in front of
 * it — archived fields render nowhere on the form, so their position relative to
 * a new one is not something anybody can see.
 */
export function rootIndexForSlot(schema: FormSchema, slot: number): number {
  const { active } = splitCanvasFields(schema);

  if (slot >= active.length) return schema.root.length;

  const occupant = active[Math.max(slot, 0)]!.id;
  const at = schema.root.indexOf(occupant);

  return at < 0 ? schema.root.length : at;
}

/**
 * Moving one field to a visible position, as `setEntityIndex` calls — BY
 * PRESSING THE ARROW BUTTON REPEATEDLY.
 *
 * `to` is the index the card should END UP at among the fields the user can see,
 * which is exactly what dnd-kit hands over: `over.id`'s position in the sortable
 * list, the same semantics as its own `arrayMove`. `arrayMove` is deliberately
 * NOT used — it is a second ordering rule, it knows nothing about archived
 * fields, and it works in `root` indexes that stop matching visible ones the
 * moment a field is retired.
 *
 * ⚠️ THE LOOP IS THE POINT. Each pass re-plans from the list as it stands, so
 * every rule `planEntityReorder` carries — most of all "the neighbour is the
 * nearest field the user can SEE", which steps over an archived field rather
 * than swapping into it — applies at every step of a long drag, not just the
 * first. A closed-form "splice it to index n" would have had to restate all of
 * it, and restating it is what produced the two bugs that rule exists to record.
 *
 * `break` rather than `continue` when a pass plans nothing: that only happens at
 * the ends of the visible list, and there is nowhere further to go.
 */
export function planEntityDrop(
  schema: FormSchema,
  entityId: string,
  to: number,
): EntityIndexMove[] {
  const { active } = splitCanvasFields(schema);

  const from = active.findIndex((field) => field.id === entityId);
  if (from < 0) return [];

  const target = Math.min(Math.max(to, 0), active.length - 1);
  if (target === from) return [];

  const direction = target > from ? "down" : "up";

  const moves: EntityIndexMove[] = [];
  let working = schema;

  for (let step = 0; step < Math.abs(target - from); step += 1) {
    const planned = planEntityReorder(working, entityId, direction);
    if (planned.length === 0) break;

    moves.push(...planned);
    working = { ...working, root: applyEntityMoves(working.root, planned) };
  }

  return moves;
}

/**
 * Do these two documents say the same thing?
 *
 * ⚠️ THIS IS WHAT REPLACED "AN EDITOR IS OPEN" AS THE REASON TO DISABLE THE
 * LIST.
 *
 * A save writes the WHOLE form, so a mechanical change — archive, restore,
 * reorder, drop — cannot go through while the store holds a half-typed field:
 * the save carries both, and either it is refused over the half-typed one or it
 * commits it. The old builder expressed that as "one editor at a time, and the
 * list is frozen while it is open", which froze the list the moment somebody
 * merely LOOKED at a field. A side panel does not change the invariant — it is
 * the same one store and the same whole-document save — so the guard stays; what
 * changes is that it now asks the real question. Selecting a field is free.
 * Typing into it is what locks the list, and only until it is saved or cancelled.
 *
 * Structural, not `JSON.stringify`: `setEntityIndex` and `addEntity` are free to
 * rewrite the `entities` record's key order, and two forms differing only in
 * that are the same form. `root` and `options` are compared elementwise because
 * in both of those places the order IS the meaning.
 */
export function sameFormSchema(a: FormSchema, b: FormSchema): boolean {
  if (a === b) return true;

  if (a.root.length !== b.root.length) return false;
  if (a.root.some((id, index) => id !== b.root[index])) return false;

  const aIds = Object.keys(a.entities);
  if (aIds.length !== Object.keys(b.entities).length) return false;

  for (const entityId of aIds) {
    if (!Object.hasOwn(b.entities, entityId)) return false;

    const left = a.entities[entityId]!;
    const right = b.entities[entityId]!;

    if (left.type !== right.type) return false;
    if (!sameAttributes(left.attributes, right.attributes)) return false;
  }

  return true;
}

function sameAttributes(
  left: FormSchemaEntity["attributes"],
  right: FormSchemaEntity["attributes"],
): boolean {
  return (
    left.key === right.key &&
    left.label === right.label &&
    left.helpText === right.helpText &&
    left.required === right.required &&
    left.archived === right.archived &&
    left.options.length === right.options.length &&
    left.options.every((option, index) => option === right.options[index])
  );
}

// ---------------------------------------------------------------------------
// P7-66 — the two decisions the DOM was making on its own, brought in here
// ---------------------------------------------------------------------------

/**
 * ⚠️ ADDING A FIELD MUST WORK WITHOUT A MOUSE, AND THIS IS THE KEY TEST.
 *
 * A palette entry is a real `<button>`, so Enter and Space are what a keyboard
 * user presses on it — Enter fires a click on keydown, Space on keyup, and
 * every screen reader announces the element as one that responds to both.
 *
 * They did NOT, before this. dnd-kit's `KeyboardSensor` contributes an
 * `onKeyDown` activator to `useDraggable`'s `listeners`, and spreading those
 * onto the button installed it: it `preventDefault()`s exactly these two codes
 * and starts a keyboard drag instead. Its own escape hatch — "ignore the key
 * unless the event target IS the registered activator node" — is skipped when
 * `setActivatorNodeRef` was never called, which it was not. And the drag it
 * started could never move, because `sortableKeyboardCoordinates` returns
 * `undefined` for an `active.id` that is not a droppable container, and a
 * palette entry is `useDraggable` only. So Enter did nothing at all and Escape
 * was the only way out.
 *
 * The palette therefore does NOT get a keyboard drag. It does not need one:
 * pressing the entry adds the field at the end, and the card's up/down buttons
 * — `planEntityReorder`, the same rule as every other path — move it from
 * there. That is WCAG 2.2 AA 2.1.1 satisfied with the tested code, rather than
 * with a second ordering mechanism.
 */
export function addsFieldOnKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * Does the card at `cardId` show the "a new field lands HERE" rule?
 *
 * ⚠️ THE PREVIEW HAS TO AGREE WITH `rootIndexForSlot`, WHICH INSERTS ABOVE THE
 * HOVERED CARD. dnd-kit will not draw that gap itself: `SortableContext` sets
 * `disableTransforms` whenever something is dragged over the list that is not
 * IN the list (`overIndex !== -1 && activeIndex === -1`), and a palette entry is
 * never in `itemIds`. So a palette drag moved nothing on the canvas and the
 * person let go with no idea where the field would land — while a REORDER drag,
 * whose active item is in the list, previews correctly through
 * `verticalListSortingStrategy` and is left alone.
 *
 * A rule in the gap above the hovered card is the honest answer, and it is the
 * same answer `rootIndexForSlot(schema, overIndex)` gives: insert AT that
 * visible slot, pushing the hovered card down. Dropping past the last card is
 * the end zone's own hover state instead, which is already drawn.
 */
export function showsInsertGuide(
  drag: { kind: "new" | "move" } | null,
  overId: string | null,
  cardId: string,
): boolean {
  return drag !== null && drag.kind === "new" && overId === cardId;
}
