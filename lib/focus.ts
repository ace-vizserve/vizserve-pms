/**
 * Focus something without dragging the page to it.
 *
 * ⚠️ `autoFocus` INSIDE A PORTALED POPUP SCROLLS THE WHOLE PAGE. React's
 * `autoFocus` calls `element.focus()` with no options, and the default is
 * `preventScroll: false` — so the browser scrolls the document until the focused
 * element is in view. Every popover in this app is portaled to `<body>` by
 * `PopoverContent`, so "in view" is computed against a node that is nowhere near
 * the row you clicked, and the list jumps.
 *
 * Amier reported it on `/tasks?list=…`: clicking move, rename, priority or
 * add-subtask scrolled the page up, every time.
 *
 * ⚠️ THIS IS THE THIRD TIME THIS BUG HAS APPEARED HERE, which is why it is a
 * shared helper rather than a fourth local fix. `tasks/assignees.tsx` hit it and
 * wrote out the whole diagnosis; `timesheet/duration-suggestion.tsx` hit it
 * separately. Both solved it privately, so the next person to type `autoFocus`
 * inside a `<PopoverContent>` reintroduced it — and there was nothing to find by
 * searching, because neither fix had a name.
 *
 * ⚠️ A CALLBACK REF, NOT AN EFFECT, AND NOT A HOOK. As a ref it runs when the
 * node mounts, which is exactly once per open — an effect with the wrong
 * dependencies re-runs on every render and drags focus back off whatever the
 * reader had tabbed to (the trap `assignees.tsx` records). Module scope gives it
 * a stable identity, so passing it as `ref` never causes a detach/reattach.
 *
 * It is a no-op on unmount: React calls a callback ref with `null` when the node
 * goes away, and `?.` handles that.
 *
 * USE IT ANYWHERE `autoFocus` WOULD GO INSIDE A POPOVER, DIALOG OR ANY OTHER
 * PORTALED SURFACE:
 *
 *     <Input ref={focusWithoutScroll} … />   // not autoFocus
 */
export function focusWithoutScroll(node: HTMLElement | null) {
  node?.focus({ preventScroll: true });
}
