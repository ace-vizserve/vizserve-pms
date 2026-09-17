"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mention } from "@tiptap/extension-mention";
import type { SuggestionOptions } from "@tiptap/suggestion";

import { MENTION_ATTR } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

/**
 * P7-71 — `@` in a comment, and the person it names.
 *
 * P7-08 shipped the thread and listed what it was not: "No threads, no replies,
 * no reactions, no mentions." `comment-thread.tsx` recorded why this one in
 * particular was held back — a mention "needs a notification path and a scope
 * question about who may be mentioned". Both are answered in the database
 * (`20260917090100_p7_71_task_comment_mentions.sql`); this file is the typing
 * end of it.
 *
 * ⚠️ A MENTION IS AN ID IN THE MARKUP, NOT A NAME. It stores as
 * `<span data-mention-id="<uuid>">@Amier Bautista</span>`, and that attribute is
 * the ONLY record that a mention happened — there is no join table. The notify
 * trigger reads it back out of the stored body with a regex, and
 * `sanitizeRichText` is the only reason it survives the trip. Those three
 * spellings of `data-mention-id` are one decision; `MENTION_ATTR` is where it
 * is written down.
 *
 * ⚠️ AND THE NAME IN THE TEXT IS A SNAPSHOT, DELIBERATELY. It is what the
 * author saw when they typed it. A mention that re-resolved its label on every
 * render would quietly rewrite old comments when somebody changed their name,
 * and would need a user lookup on every surface that draws a body — including
 * `<RichText>`, which is a server component with nothing to look anything up
 * with. The id is the durable half; the text is the record of what was said.
 */

/**
 * How many names the menu shows at once.
 *
 * A cap rather than a scroll box: past about eight rows nobody is reading the
 * list, they are typing more letters. Filtering is what narrows it.
 */
const MAX_ROWS = 8;

/** Roughly how tall the menu gets, for deciding whether it fits below the caret. */
const MENU_HEIGHT = 260;

/** Somebody who can be mentioned. The shape `vizserve_pms_mentionable_for_task` returns. */
export type MentionPerson = { id: string; full_name: string };

/**
 * The node.
 *
 * Everything here is a REPLACEMENT of a TipTap default, and each one exists to
 * make the stored markup match what the sanitiser's allowlist admits — a single
 * `span` carrying a single attribute. The stock extension writes `data-type`,
 * `data-id`, `data-label` and `data-mention-suggestion-char`; the sanitiser
 * would strip all four, so a mention would render while you typed it and come
 * back as bare text on reload. That is the exact failure mode P7-56 called the
 * worst this feature can have, "because the user watched it work".
 *
 * Module scope, like `CommentImage` beside it: an extension re-created per
 * render re-creates the editor's schema with it.
 */
const UserMention = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute(MENTION_ATTR),
        renderHTML: (attributes) =>
          attributes.id ? { [MENTION_ATTR]: attributes.id as string } : {},
      },

      /*
       * ⚠️ THE LABEL IS READ BACK OUT OF THE TEXT, because there is nowhere
       * else to keep it. `data-label` is not on the sanitiser's allowlist and
       * should not be — it would be a second, unvalidated attribute on the one
       * tag admitted for a single purpose. The visible text already carries the
       * name, so parsing strips the leading `@` and that is the label.
       *
       * It renders nothing of its own: the text content comes from
       * `renderHTML` below, which would otherwise print the name twice.
       */
      label: {
        default: null,
        parseHTML: (element) => element.textContent?.replace(/^@/, "") || null,
        renderHTML: () => ({}),
      },
    };
  },

  /*
   * The attribute IS the marker. The stock rule looks for `data-type="mention"`,
   * which the sanitiser strips, so a stored mention would parse back as plain
   * text and lose its id the first time somebody edited the comment.
   */
  parseHTML() {
    return [{ tag: `span[${MENTION_ATTR}]` }];
  },
});

/**
 * What the suggestion menu knows at any moment. Null when it is closed.
 *
 * `rect` is a plain box rather than the live `clientRect` callback the plugin
 * hands over: it is read once per update, which is when the caret moved, and
 * holding the callback would mean calling into ProseMirror during render.
 */
type MenuState = {
  items: MentionPerson[];
  rect: { top: number; bottom: number; left: number } | null;
  /** Nothing matched — the menu stays up and says so rather than vanishing. */
  query: string;
};

/**
 * Wire `@` into an editor.
 *
 * Returns the extension to register, the overlay to render, and `isOpen` — the
 * editor's Cmd/Ctrl+Enter handler asks it, because Enter belongs to the menu
 * while the menu is up.
 *
 * ⚠️ THE PEOPLE ARE LOADED ONCE, ON THE FIRST `@`, AND CACHED FOR THE SESSION
 * OF THIS BOX. A request per keystroke is the obvious shape and the wrong one
 * here: a department is sixteen people, they are returned in one `rpc` call,
 * and filtering sixteen names in the browser is instant where a round trip per
 * character is not. It also means the list cannot flicker or arrive out of
 * order while somebody is typing a name.
 *
 * The cost is a picker that does not notice somebody joining the department
 * while a comment box is open. That is a page refresh away and nobody has ever
 * asked for it.
 */
export function useMentions(load?: () => Promise<MentionPerson[]>) {
  /*
   * Read ONCE, deliberately, exactly like `imagesEnabled` next door: present or
   * absent decides the editor's SCHEMA, and a field cannot start accepting
   * mentions half way through a session.
   */
  const [enabled] = useState(() => Boolean(load));

  /*
   * ⚠️ HELD IN A REF, AND ASSIGNED IN AN EFFECT RATHER THAN DURING RENDER.
   * Identical to `uploadRef` in `rich-text-editor-impl.tsx` and for the same
   * reason: an extension binds its handlers ONCE, when the editor is created,
   * so capturing `load` directly would keep calling the first render's closure
   * for the life of the box. The effect is what keeps the linter's rule and the
   * requirement compatible.
   */
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  /** The fetch, not the result — so concurrent `@`s share one request. */
  const peopleRef = useRef<Promise<MentionPerson[]> | null>(null);

  const [menu, setMenu] = useState<MenuState | null>(null);

  /*
   * The menu's current contents, where the bound-once key handler can read
   * them.
   *
   * ⚠️ WRITTEN BESIDE EVERY `setMenu`, NEVER MIRRORED IN AN EFFECT. The key
   * handler and the thing that fills this are both plugin callbacks, and they
   * can run in the same turn: `@a` updates the list and the very next keystroke
   * may be the Enter that picks from it. An effect would land after the commit,
   * which is soon enough for drawing and not obviously soon enough for that. So
   * the ref is the source of truth and `menu` is its shadow, for rendering.
   */
  const menuRef = useRef<MenuState | null>(null);

  /*
   * ⚠️ THE HIGHLIGHTED ROW LIVES IN A REF AS WELL AS IN STATE, and it has to.
   * `onKeyDown` below is bound once, when the plugin is created, so it reads
   * whatever the closure captured — which for React state is the value at
   * creation, forever. The ref is what arrow keys actually move; the state is
   * only so the list can draw the highlight.
   */
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);

  const openRef = useRef(false);
  const isOpen = useCallback(() => openRef.current, []);

  /*
   * ⚠️ BOUND ONCE, LIKE EVERY OTHER EXTENSION HANDLER. The `command` that
   * inserts the node is handed to us per-render by the plugin, so it is stashed
   * here rather than captured — the alternative is a menu whose click inserts
   * into the state of whichever render created it.
   */
  const commandRef = useRef<((item: MentionPerson) => void) | null>(null);

  const close = useCallback(() => {
    openRef.current = false;
    commandRef.current = null;
    menuRef.current = null;
    setMenu(null);
  }, []);

  const choose = useCallback((item: MentionPerson) => {
    commandRef.current?.(item);
  }, []);

  /*
   * The suggestion options. Built once — `useMemo` with no dependencies rather
   * than a `useState` initialiser only because it reads better; both are "make
   * this exactly once". Everything it closes over is a ref or a stable setter.
   */
  const suggestion = useMemo<Partial<SuggestionOptions<MentionPerson>> | null>(() => {
    if (!enabled) return null;

    return {
      char: "@",

      /*
       * ⚠️ SPELLED OUT RATHER THAN LEFT TO THE DEFAULT, which spreads the
       * PICKED ITEM straight into the node's attributes. This app's item is a
       * `{ id, full_name }` — the shape the database returns — and the node's
       * attributes are `id` and `label`, so the default would set an attribute
       * the schema does not have and leave `label` null. The mention would
       * insert, render as a bare `@`, and store a span with no name in it.
       *
       * The trailing space is the default's too, and worth keeping: without it
       * the caret sits flush against an atom node and the next character typed
       * looks like part of the name.
       */
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: "mention", attrs: { id: props.id, label: props.full_name } },
            { type: "text", text: " " },
          ])
          .run();
      },

      /*
       * ⚠️ NOT A SERVER CALL PER KEYSTROKE — see the note on the hook. The
       * promise is cached, so this awaits a resolved value after the first `@`.
       *
       * A failed load resolves to an empty list rather than throwing: the menu
       * then says "No one to mention", which is wrong but harmless, where an
       * unhandled rejection inside a ProseMirror plugin takes the keystroke
       * with it.
       */
      items: async ({ query }: { query: string }) => {
        peopleRef.current ??= (loadRef.current?.() ?? Promise.resolve([])).catch(() => []);
        const people = await peopleRef.current;

        const needle = query.trim().toLowerCase();
        if (!needle) return people.slice(0, MAX_ROWS);

        /*
         * Matches on any WORD of the name, not just the start of it — "@bau"
         * should find "Amier Bautista", because a surname is what people type
         * when two colleagues share a first name. A plain `includes` would also
         * match the middle of a word, which produces results nobody can explain.
         */
        return people
          .filter((person) =>
            person.full_name
              .toLowerCase()
              .split(/\s+/)
              .some((word) => word.startsWith(needle)),
          )
          .slice(0, MAX_ROWS);
      },

      render: () => {
        const sync = (props: {
          items: MentionPerson[];
          query: string;
          command: (item: MentionPerson) => void;
          clientRect?: (() => DOMRect | null) | null;
        }) => {
          const rect = props.clientRect?.();

          const next: MenuState = {
            items: props.items,
            query: props.query,
            rect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left } : null,
          };

          openRef.current = true;
          commandRef.current = props.command;
          menuRef.current = next;
          // Back to the top whenever the filter changes — the old highlight was
          // about a list that no longer exists.
          activeRef.current = 0;
          setActive(0);
          setMenu(next);
        };

        return {
          onStart: sync,
          onUpdate: sync,

          /*
           * ⚠️ RETURNING `true` IS WHAT STOPS THE EDITOR SEEING THE KEY. Enter
           * with this menu open must NOT make a paragraph, and the arrows must
           * not move the caret — so every key this handles is claimed.
           *
           * Escape closes the menu and keeps the `@` and whatever was typed
           * after it as ordinary text, which is how somebody writes an email
           * address or "@here" and means it literally.
           */
          onKeyDown: ({ event }: { event: KeyboardEvent }) => {
            const rows = menuRef.current?.items.length ?? 0;

            if (event.key === "Escape") {
              close();
              return true;
            }

            if (rows === 0) return false;

            if (event.key === "ArrowDown") {
              activeRef.current = (activeRef.current + 1) % rows;
              setActive(activeRef.current);
              return true;
            }

            if (event.key === "ArrowUp") {
              activeRef.current = (activeRef.current - 1 + rows) % rows;
              setActive(activeRef.current);
              return true;
            }

            if (event.key === "Enter" || event.key === "Tab") {
              const item = menuRef.current?.items[activeRef.current];
              if (!item) return false;
              // ⚠️ Not `choose`: this runs inside the plugin, where the command
              // the CURRENT render was given is the one in the ref.
              commandRef.current?.(item);
              return true;
            }

            return false;
          },

          onExit: close,
        };
      },
    };
  }, [enabled, close]);

  /*
   * ⚠️ `react-hooks/refs` IS SILENCED OVER THIS BLOCK, for the same reason and
   * with the same argument as the `FileHandler` block in
   * `rich-text-editor-impl.tsx`.
   *
   * The rule's objection is that `suggestion` holds functions which read refs
   * and is handed to another function during render — the shape of reading a
   * ref while rendering. It is not what happens: `items`, `onKeyDown` and the
   * rest are invoked by a keystroke, long after this render committed. The refs
   * exist precisely BECAUSE an extension binds its options ONCE when the editor
   * is created, so the alternative is a menu that keeps consulting the first
   * render's state for the rest of the session.
   *
   * The narrower fix would be re-creating the editor whenever any of this
   * changes identity, which throws away the caret and the draft.
   */
  /* eslint-disable react-hooks/refs -- see the note directly above */
  const extension = useMemo(() => {
    if (!suggestion) return null;

    return UserMention.configure({
      suggestion,

      /*
       * ⚠️ RETURNING AN ARRAY RATHER THAN A STRING IS LOAD-BEARING. The node's
       * own `renderHTML` merges `data-type="mention"` into the attributes when
       * this option returns a string, and adds nothing when it returns a
       * `DOMOutputSpec`. The sanitiser admits exactly one attribute on a
       * `span`, so the string form would produce markup that renders here and
       * comes back stripped.
       */
      renderHTML: ({ node }) => [
        "span",
        { [MENTION_ATTR]: node.attrs.id as string },
        `@${(node.attrs.label as string | null) ?? ""}`,
      ],

      // What a flattened body says — the email and every list preview go
      // through `richTextToPlainText`, which reads the rendered text.
      renderText: ({ node }) => `@${(node.attrs.label as string | null) ?? ""}`,

      // Backspace on a mention removes the whole name AND the `@` that opened
      // it, rather than leaving a stray trigger behind that immediately
      // reopens the menu.
      deleteTriggerWithBackspace: true,
    });
  }, [suggestion]);
  /* eslint-enable react-hooks/refs */

  return {
    /** Null when the caller passed no loader — see `enabled`. */
    extension,
    isOpen,
    overlay: menu ? <MentionMenu menu={menu} active={active} onChoose={choose} /> : null,
  };
}

/**
 * The menu.
 *
 * ⚠️ NOT `<PopoverContent>`, AND THAT IS NOT AN OVERSIGHT. Every popover in
 * this app moves focus into itself when it opens — that is what a popover is
 * for — and this one must not: the caret has to stay in the editor, because the
 * person is still typing the name. So it is a plain positioned box with no
 * focus management at all, driven entirely by the key handler above. The same
 * reason TipTap's own examples reach for a bare element here.
 *
 * `position: fixed` against the caret's own rect, so it follows the caret
 * inside a scrolling sheet without any measuring of ancestors.
 */
function MentionMenu({
  menu,
  active,
  onChoose,
}: {
  menu: MenuState;
  active: number;
  onChoose: (item: MentionPerson) => void;
}) {
  if (!menu.rect) return null;

  // Above the caret when there is no room below it — a comment box at the
  // bottom of a full-height sheet is the common case, not the edge one.
  const below = menu.rect.bottom + MENU_HEIGHT < window.innerHeight;

  return (
    <div
      role="listbox"
      aria-label="Mention somebody"
      className="fixed z-50 max-h-64 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{
        left: menu.rect.left,
        ...(below ? { top: menu.rect.bottom + 4 } : { bottom: window.innerHeight - menu.rect.top + 4 }),
      }}>
      {menu.items.length === 0 ? (
        <p className="px-2 py-1.5 text-2xs text-muted-foreground">
          {/* Says which of the two nothings this is. "No matches" on an empty
              department would send somebody hunting for a typo in a name that
              was never there. */}
          {menu.query ? `No one matching “${menu.query}”` : "No one to mention here"}
        </p>
      ) : (
        menu.items.map((person, index) => (
          <button
            key={person.id}
            type="button"
            role="option"
            aria-selected={index === active}
            /*
             * ⚠️ `onMouseDown` WITH `preventDefault`, NEVER `onClick`. A click
             * lands after the mousedown has already moved focus out of the
             * editor, which collapses the ProseMirror selection — so the
             * command would insert the mention at a range that no longer
             * exists. Preventing the default keeps the caret exactly where the
             * `@` was typed.
             */
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(person);
            }}
            className={cn(
              "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs",
              index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}>
            <span className="truncate">{person.full_name}</span>
          </button>
        ))
      )}
    </div>
  );
}
