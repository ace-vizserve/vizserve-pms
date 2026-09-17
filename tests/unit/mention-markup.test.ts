// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { useMentions, type MentionPerson } from "@/components/ui/rich-text-mention";
import { mentionedUserIds } from "@/lib/rich-text";
import { sanitizeRichText } from "@/lib/rich-text-server";

/**
 * P7-71 — THE ONE THING ABOUT MENTIONS THAT A PURE-FUNCTION TEST CANNOT REACH.
 *
 * `rich-text.test.ts` proves what the sanitiser keeps. It cannot prove that what
 * the EDITOR writes is the same markup, and that gap is exactly where this
 * feature fails: TipTap's stock mention node emits `data-type`, `data-id`,
 * `data-label` and `data-mention-suggestion-char`, all four of which the
 * sanitiser strips. A mention built that way renders perfectly while you type
 * it and comes back as bare text on reload — the failure P7-56 called the worst
 * this feature can have, "because the user watched it work".
 *
 * So this drives the real extension, through the real hook, and puts its output
 * through the real sanitiser.
 *
 * ⚠️ `.test.ts`, NOT `.test.tsx`, DESPITE DRIVING A HOOK. The runner's include
 * pattern is `.test.ts` only (`vitest.config.ts`), and widening a shared pattern
 * to admit one file is a change to every test written after it rather than to
 * this one. Nothing here needs JSX — `renderHook` takes a callback.
 *
 * ⚠️ , NOT , DESPITE TESTING COMPONENTS. The runner's
 * include pattern is  only (), and widening a shared
 * pattern to admit one file is a change to every future test rather than to this
 * one. Nothing here needs JSX —  takes a callback.
 *
 * ⚠️ `@vitest-environment jsdom` ON THIS FILE ALONE, and that is the whole
 * reason for the docblock. `vitest.config.ts` runs everything under `node` and
 * says why — "there are no component tests yet… give them their own project
 * entry with jsdom rather than making every server test pay for a DOM". A
 * per-file environment keeps that promise: the other 1,660 tests still start
 * without one.
 */

const AMIER: MentionPerson = { id: "5c7e2f81-4a3b-4c9d-8e12-6f0a9b3d5e74", full_name: "Amier B" };

/**
 * The extension as the editor actually receives it.
 *
 * ⚠️ FROM THE HOOK, NOT FROM THE NODE. `renderHTML` — the half that decides the
 * stored markup — is passed in `configure`, so a test that imported the bare
 * node would assert TipTap's defaults and prove nothing about this app.
 */
function mentionExtension() {
  const { result } = renderHook(() => useMentions(async () => [AMIER]));
  const extension = result.current.extension;
  if (!extension) throw new Error("the hook returned no extension for a loader that exists");
  return extension;
}

function editorWith(content: string) {
  return new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ heading: { levels: [3, 4] } }), mentionExtension()],
    content,
  });
}

describe("what the editor writes is what the sanitiser keeps", () => {
  it("writes a mention as one span carrying one attribute", () => {
    const editor = editorWith("<p></p>");
    editor.commands.insertContent({
      type: "mention",
      attrs: { id: AMIER.id, label: AMIER.full_name },
    });

    const html = editor.getHTML();

    expect(html).toContain(`data-mention-id="${AMIER.id}"`);
    expect(html).toContain(`@${AMIER.full_name}`);

    // The four TipTap defaults that would each be stripped on the way to the
    // database. Named individually so a failure says which one came back.
    expect(html).not.toContain("data-type");
    expect(html).not.toContain("data-id=");
    expect(html).not.toContain("data-label");
    expect(html).not.toContain("data-mention-suggestion-char");

    editor.destroy();
  });

  it("survives the sanitiser with its id and its name intact", () => {
    const editor = editorWith("<p></p>");
    editor.commands.insertContent({
      type: "mention",
      attrs: { id: AMIER.id, label: AMIER.full_name },
    });

    const stored = sanitizeRichText(editor.getHTML());

    expect(stored).toContain(`data-mention-id="${AMIER.id}"`);
    expect(stored).toContain(`@${AMIER.full_name}`);
    // And the database will find it — the same string the notify trigger reads.
    expect(mentionedUserIds(stored)).toEqual([AMIER.id]);

    editor.destroy();
  });

  it("parses back out of the stored markup, so editing a comment keeps the mention", () => {
    /*
     * ⚠️ THE ROUND TRIP IS THE POINT, and it is a second, separate failure from
     * the one above. The stock parse rule looks for `data-type="mention"`, which
     * the sanitiser removes — so a stored mention would reload as plain text and
     * lose its id the first time somebody edited the comment. Nobody would ever
     * see an error; the name would simply stop notifying.
     */
    const first = editorWith("<p></p>");
    first.commands.insertContent({
      type: "mention",
      attrs: { id: AMIER.id, label: AMIER.full_name },
    });
    const stored = sanitizeRichText(first.getHTML());
    first.destroy();

    const reopened = editorWith(stored);

    // The node is back as a node, not as characters.
    let mentions = 0;
    reopened.state.doc.descendants((node) => {
      if (node.type.name !== "mention") return;
      mentions += 1;
      expect(node.attrs.id).toBe(AMIER.id);
      expect(node.attrs.label).toBe(AMIER.full_name);
    });
    expect(mentions).toBe(1);

    // And it writes itself out the same way it came in.
    expect(sanitizeRichText(reopened.getHTML())).toBe(stored);

    reopened.destroy();
  });

  it("does not exist at all in an editor with no loader", () => {
    /*
     * PRESENT OR ABSENT DECIDES THE SCHEMA — the same contract `onUploadImage`
     * has. A resolution field or a leave reason has no mention node, so there is
     * nothing for an `@` to become and nothing a paste can smuggle in.
     */
    const { result } = renderHook(() => useMentions(undefined));
    expect(result.current.extension).toBeNull();
  });
});
