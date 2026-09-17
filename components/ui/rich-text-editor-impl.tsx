"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import FileHandler from "@tiptap/extension-file-handler";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import {
  Bold,
  Code,
  Heading3,
  Heading4,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Quote,
  Strikethrough,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RICH_TEXT_CLASS } from "@/components/ui/rich-text";
import { useMentions, type MentionPerson } from "@/components/ui/rich-text-mention";
import { EDITOR_SHELL, RichTextEditorShell } from "@/components/ui/rich-text-editor-shell";
import { cn } from "@/lib/utils";
import { focusWithoutScroll } from "@/lib/focus";

/**
 * P7-56 — the editor behind the six long-prose columns.
 *
 * ⚠️ ITS SCHEMA AND `RICH_TEXT_TAGS` ARE ONE DECISION, in two files that must
 * change together. A mark this toolbar offers but `sanitizeRichText` strips is
 * a button that appears to work and silently undoes itself on reload — the
 * worst class of bug this feature can have, because the user watched it work.
 *
 * IMAGES ARE OPT-IN, PER FIELD (P7-67). Pass `onUploadImage` and the editor
 * accepts a pasted or dropped picture; leave it off and the `img` node does not
 * exist in that editor's schema at all, so there is nothing to paste into. Task
 * comments pass it. The other five columns do not, and a resolution or a leave
 * reason is not a place for a screenshot.
 *
 * ⚠️ AND THE UPLOAD IS THE CALLER'S, WHICH IS THE POINT. This component never
 * learns what a task is. It hands over a `File` and writes whatever `src` comes
 * back — so nothing base64 ever enters a body, which is the rule P7-56 wrote
 * down when it banned images outright and the one that still holds.
 *
 * WHAT IS DELIBERATELY ABSENT: tables (unusable at the width these fields
 * render), and `h1`/`h2` (the page owns those — see `lib/rich-text.ts`).
 *
 * The single biggest usability win here is not the toolbar, it is StarterKit's
 * INPUT RULES: typing `- `, `1. `, `## ` or `**bold**` formats as you go. Most
 * people will never press one of these buttons.
 */

/**
 * P7-67 — what an inline image carries, and why it is more than a `src`.
 *
 * The base `Image` node knows `src`, `alt` and `title`. A comment thread needs
 * two more facts, both measured from the bytes by the upload action:
 *
 *   `width` / `height`  the browser derives an intrinsic aspect ratio from the
 *                       pair and reserves the right box before the image
 *                       arrives, so a thread does not jolt as it loads.
 *   `orientation`       the cap that applies. CSS CANNOT DERIVE THIS — there is
 *                       no selector for an image's intrinsic aspect ratio, at
 *                       any level, so a portrait screenshot and a landscape one
 *                       cannot be told apart in a stylesheet unless the
 *                       orientation arrives as an attribute.
 *
 * ⚠️ IT RENDERS AS `data-orientation`, AND THE SANITISER'S ALLOWLIST NAMES THAT
 * SPELLING. The node's own attribute is `orientation`; a Tiptap attribute
 * cannot be called `data-orientation` without quoting it everywhere, so the
 * mapping happens here, once. If you rename either half, rename both — the
 * failure is silent, and it looks like every image losing its size cap.
 *
 * Module scope, not inside the component: an extension re-created per render
 * re-creates the editor's schema with it.
 */
const CommentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),

      width: {
        default: null,
        parseHTML: (element) => element.getAttribute("width"),
        renderHTML: (attributes) => (attributes.width ? { width: attributes.width } : {}),
      },

      height: {
        default: null,
        parseHTML: (element) => element.getAttribute("height"),
        renderHTML: (attributes) => (attributes.height ? { height: attributes.height } : {}),
      },

      orientation: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-orientation"),
        renderHTML: (attributes) =>
          attributes.orientation ? { "data-orientation": attributes.orientation } : {},
      },
    };
  },
});

/**
 * What `onUploadImage` hands back: where the bytes now live, and how big they
 * are. Everything but `src` is optional — a header this app could not parse
 * costs the image its size cap, never its place in the comment.
 */
export type UploadedImage = {
  src: string;
  width?: number | null;
  height?: number | null;
  orientation?: "landscape" | "portrait" | "square" | null;
};

export function RichTextEditor({
  value,
  onChange,
  onSubmit,
  onBlur,
  disabled = false,
  placeholder,
  ariaLabel,
  invalid = false,
  minHeight = "min-h-16",
  className,
  onUploadImage,
  loadMentions,
}: {
  value: string;
  onChange: (html: string) => void;
  /**
   * Cmd/Ctrl+Enter. Given rather than assumed, because this component has no
   * idea whether it is sitting in a comment box or a resolution field.
   *
   * ⚠️ PLAIN ENTER BELONGS TO THE EDITOR. It makes a paragraph and continues a
   * list; a comment box that stole it could never hold a second bullet.
   */
  onSubmit?: () => void;
  /**
   * Focus left the editor.
   *
   * ⚠️ A DEBOUNCED FIELD NEEDS THIS. `<Textarea>` fires a native blur, and the
   * autosaved resolution on `/tasks/[id]` used it to commit early rather than
   * wait out the 800ms timer. A contenteditable inside TipTap gives the parent
   * no such event, so without this prop that flush path simply disappears and
   * the window in which a typed resolution is not yet saved gets wider.
   */
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  minHeight?: string;
  className?: string;
  /**
   * P7-67 — turn one pasted, dropped or picked image into a `src`, or return
   * null if it could not be stored.
   *
   * PRESENT OR ABSENT DECIDES THE SCHEMA, so it is read once, when the editor
   * is created: a field cannot start accepting images half way through a
   * session. The FUNCTION itself may change identity freely — it is held in a
   * ref below, because an extension's handlers are bound at creation and would
   * otherwise keep calling the first render's closure for the life of the box.
   *
   * ⚠️ REPORT YOUR OWN FAILURES. Returning null inserts nothing and says
   * nothing; the caller holds the error string and knows which toast to raise.
   */
  onUploadImage?: (file: File) => Promise<UploadedImage | null>;
  /**
   * P7-71 — who `@` may name here, fetched the first time somebody types one.
   *
   * PRESENT OR ABSENT DECIDES THE SCHEMA, exactly like `onUploadImage` above
   * and for the same reason: the `mention` node only exists in an editor that
   * was created with this, so a field without it has nothing for an `@` to
   * become. Task comments pass it; the other rich-text columns do not, because
   * a QA resolution or a leave reason is addressed to a process rather than to
   * a person.
   *
   * ⚠️ WHAT IT RETURNS IS A SUGGESTION, NOT A PERMISSION. The database decides
   * who may actually be mentioned and who is notified — see
   * `vizserve_pms_task_mention_candidates`. This list only decides what the
   * menu offers.
   */
  loadMentions?: () => Promise<MentionPerson[]>;
}) {
  /*
   * Read once, deliberately — see the prop's own note. `useState` rather than a
   * ref because the toolbar renders from it.
   */
  const [imagesEnabled] = useState(() => Boolean(onUploadImage));

  // P7-71. Read once for the same reason, and it says so itself.
  const mentions = useMentions(loadMentions);
  const uploadRef = useRef(onUploadImage);
  useEffect(() => {
    uploadRef.current = onUploadImage;
  }, [onUploadImage]);

  /*
   * How many uploads are in flight. Not per-image: there is no placeholder node
   * to hang a spinner on, so an image appears when its bytes are stored and
   * until then the toolbar button spins. A decoration-based placeholder is the
   * nicer version of this and is a bigger change than the feature.
   */
  const [uploading, setUploading] = useState(0);

  /*
   * ⚠️ ONE PLACE THAT INSERTS AN IMAGE, and the paste handler, the drop handler
   * and the toolbar button all come through it. They differ only in WHERE: a
   * paste and a pick go to the caret, a drop goes to the position under the
   * pointer.
   *
   * Sequential, not `Promise.all`: pasting five screenshots at once would
   * otherwise open five uploads against a private bucket and insert them in
   * whatever order they happened to finish, which is not the order they were
   * pasted.
   */
  const insertImages = useCallback(async (instance: Editor, files: File[], pos?: number) => {
    const upload = uploadRef.current;
    if (!upload) return;

    let at = pos;

    for (const file of files) {
      setUploading((count) => count + 1);
      try {
        const uploaded = await upload(file);
        if (!uploaded) continue;

        // The filename is the alt text: it is what the person who pasted it
        // would have written, and `richTextToPlainText` prints it in an email.
        const node = {
          type: "image",
          attrs: {
            src: uploaded.src,
            alt: file.name,
            // Null rather than absent is fine — `renderHTML` drops a null, so
            // an unmeasured image simply writes no `width`.
            width: uploaded.width ?? null,
            height: uploaded.height ?? null,
            orientation: uploaded.orientation ?? null,
          },
        };

        if (at === undefined) {
          instance.chain().focus().insertContent(node).run();
        } else {
          instance.chain().focus().insertContentAt(at, node).run();
          // Keeps a run of dropped files in the order they were dropped.
          at += 1;
        }
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }, []);

  const editor = useEditor({
    /*
     * ⚠️ WITHOUT THIS, EVERY PAGE WITH AN EDITOR HYDRATION-MISMATCHES. TipTap
     * renders the document synchronously by default, which does not survive
     * SSR. The documented Next.js setting, and the reason is worth keeping
     * written down because the symptom — a React error about server/client
     * markup — points nowhere near the editor.
     */
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        // Two levels only, mapped to h3/h4 by the renderer's stylesheet. See
        // `RICH_TEXT_TAGS`.
        heading: { levels: [3, 4] },
        // Off: a code BLOCK is a different thing from the inline `code` mark,
        // it is not in the allowlist, and nobody writes shell scripts in a
        // leave-request reason.
        codeBlock: false,
        horizontalRule: false,
        // StarterKit v3 bundles Link, and configuring it twice throws a
        // duplicate-extension warning. It is disabled here and added below with
        // the settings this app needs.
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        // ⚠️ The same allowlist `sanitizeRichText` enforces. Stated here too so
        // a `javascript:` URL cannot even be created — the sanitiser is the
        // guard, this is the courtesy of refusing before it is saved.
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
      ...(imagesEnabled
        ? [
            /*
             * ⚠️ `allowBase64: false` IS THE WHOLE GUARD ON THIS SIDE. With it
             * on, a pasted screenshot that the browser also offers as HTML
             * would parse straight into the document as a `data:` URI —
             * megabytes of it, in a text column, which is precisely what P7-56
             * refused. The sanitiser drops such an `img` on the way to the
             * database, so the damage would be a picture that renders while you
             * type and vanishes on reload: the worst class of bug this feature
             * can have, because the user watched it work.
             *
             * `inline: false` — a block, like a paragraph. An image sitting
             * inside a line of prose is not a layout anybody asked for here.
             */
            CommentImage.configure({ inline: false, allowBase64: false }),
            /*
             * ⚠️ `react-hooks/refs` IS SILENCED HERE, AND ONLY HERE.
             *
             * The rule's objection is that `insertImages` reads `uploadRef`
             * and is handed to a function during render, which is the shape of
             * reading a ref while rendering. It is not what happens: these two
             * handlers are invoked by a paste and a drop, both long after this
             * render committed, and the ref exists precisely because an
             * extension binds its options ONCE when the editor is created — the
             * alternative is a box that keeps calling the first render's upload
             * closure for the rest of the session.
             *
             * The narrower fix would be re-creating the editor whenever
             * `onUploadImage` changes identity, which throws away the caret and
             * the draft on every parent re-render.
             */
            // eslint-disable-next-line react-hooks/refs
            FileHandler.configure({
              // The same four the upload action accepts. A fifth here would be
              // a file that uploads and then reports an error from the server.
              allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
              /*
               * ⚠️ TRUE, OR EVERY SCREENSHOT ARRIVES TWICE. A paste from a
               * screenshot tool carries the bitmap AND an HTML flavour holding
               * an `<img>`; without this, this handler stores the bitmap while
               * ProseMirror's own paste parsing inserts the HTML one beside it.
               */
              consumePasteEvent: true,
              onPaste: (instance, files) => {
                void insertImages(instance, files);
              },
              onDrop: (instance, files, pos) => {
                void insertImages(instance, files, pos);
              },
            }),
          ]
        : []),
      // P7-71. Null unless `loadMentions` was given — see `useMentions`.
      ...(mentions.extension ? [mentions.extension] : []),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: cn(RICH_TEXT_CLASS, "px-2.5 py-2 outline-none", minHeight),
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleKeyDown: (_view, event) => {
        if (!onSubmit) return false;
        /*
         * P7-71 — ⚠️ THE MENTION MENU OWNS ENTER WHILE IT IS OPEN, MODIFIERS
         * INCLUDED. Somebody half way through picking a name has not finished
         * writing the comment, and Cmd+Enter is close enough to Enter that a
         * slipped thumb would post it. The menu's own handler takes plain Enter
         * (it runs as a plugin, after this); this is only about not stealing
         * the modified one out from under it.
         */
        if (mentions.isOpen()) return false;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
    onBlur: () => onBlur?.(),
  });

  /*
   * Pull a value in only when the PARENT changed it to something the editor is
   * not already showing — a reset after a successful save, or a dialog reopened
   * on a different row.
   *
   * ⚠️ THE `getHTML()` COMPARISON IS WHAT MAKES THIS SAFE. Without it every
   * keystroke would round-trip through the parent and back, resetting the
   * document and putting the caret at position 0 on every character typed.
   */
  useEffect(() => {
    if (!editor) return;
    if (value === editor.getHTML()) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) {
    // The pre-hydration shell. Same box, same height — so nothing shifts when
    // the editor mounts into it.
    return <RichTextEditorShell minHeight={minHeight} className={className} />;
  }

  return (
    <div
      className={cn(EDITOR_SHELL, className)}
      aria-invalid={invalid || undefined}
      data-slot="rich-text-editor">
      <Toolbar
        editor={editor}
        disabled={disabled}
        onPickImages={imagesEnabled ? (files) => void insertImages(editor, files) : undefined}
        uploading={uploading > 0}
      />
      <EditorContent editor={editor} />
      {placeholder && editor.isEmpty ? (
        // A real placeholder needs TipTap's Placeholder extension and a CSS
        // pseudo-element; this is the same thing for one less dependency, and
        // it is `aria-hidden` because the field already has its label.
        <p
          aria-hidden
          className="pointer-events-none -mt-[1.9rem] px-2.5 text-sm text-muted-foreground">
          {placeholder}
        </p>
      ) : null}
      {/* P7-71. Null unless an `@` is open. Rendered INSIDE the editor's own
          box rather than portalled, so it inherits the stacking context of
          whatever is holding the editor — a comment sheet, a popover on a list
          row — instead of having to out-guess it with a z-index. */}
      {mentions.overlay}
    </div>
  );
}

function Toolbar({
  editor,
  disabled,
  onPickImages,
  uploading,
}: {
  editor: Editor;
  disabled: boolean;
  /** P7-67 — absent on every field that does not take images. */
  onPickImages?: (files: File[]) => void;
  uploading: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1">
      <Mark
        editor={editor}
        disabled={disabled}
        label="Bold"
        icon={<Bold />}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Italic"
        icon={<Italic />}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Strikethrough"
        icon={<Strikethrough />}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Inline code"
        icon={<Code />}
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />

      <Divider />

      <Mark
        editor={editor}
        disabled={disabled}
        label="Heading"
        icon={<Heading3 />}
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Subheading"
        icon={<Heading4 />}
        active={editor.isActive("heading", { level: 4 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Quote"
        icon={<Quote />}
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />

      <Divider />

      <Mark
        editor={editor}
        disabled={disabled}
        label="Bullet list"
        icon={<List />}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <Mark
        editor={editor}
        disabled={disabled}
        label="Numbered list"
        icon={<ListOrdered />}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />

      <Divider />

      <LinkButton editor={editor} disabled={disabled} />

      {onPickImages ? (
        <ImageButton onPick={onPickImages} disabled={disabled} uploading={uploading} />
      ) : null}
    </div>
  );
}

/**
 * P7-67 — the way in for anyone who is not pasting.
 *
 * Paste and drag are how most people will add a picture and neither is
 * discoverable, so the toolbar carries the third — and it is the only one that
 * works from a phone, where there is no drag and the clipboard rarely holds a
 * bitmap.
 *
 * A hidden `<input type="file">` behind a button rather than a styled input:
 * the input cannot be made to look like the six controls beside it, and a
 * `<label>` wrapped around one loses the toolbar's keyboard behaviour.
 */
function ImageButton({
  onPick,
  disabled,
  uploading,
}: {
  onPick: (files: File[]) => void;
  disabled: boolean;
  uploading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={uploading ? "Adding image" : "Add image"}
        title="Add image"
        // The spinner is this control's only state, and it is announced rather
        // than drawn alone (§5).
        aria-busy={uploading || undefined}
        disabled={disabled || uploading}
        className="size-7"
        onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
      </Button>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared before the upload starts, so picking the same file twice in
          // a row still fires a change event the second time.
          event.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
    </>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * One toolbar control.
 *
 * `aria-pressed` rather than a tinted background alone — state is never carried
 * by colour only (§5), and a toggle that only looks different is invisible to
 * anyone using a screen reader.
 */
function Mark({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  editor: Editor;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn("size-7", active && "bg-accent text-accent-foreground")}
      onClick={onClick}>
      {icon}
    </Button>
  );
}

function LinkButton({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");

  const active = editor.isActive("link");

  const apply = useCallback(() => {
    const url = href.trim();

    // Empty means "remove the link", which is the only way back out of one.
    if (!url) {
      editor.chain().focus().unsetLink().run();
      setOpen(false);
      return;
    }

    // Bare domains are what people paste. Defaulting to https rather than
    // refusing keeps the common case one step instead of two — and the scheme
    // allowlist in the extension still rejects anything hostile.
    const withScheme = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;

    editor.chain().focus().extendMarkRange("link").setLink({ href: withScheme }).run();
    setOpen(false);
  }, [editor, href]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Seed from the link under the caret, so opening this on an existing
        // link edits it rather than silently replacing it with a blank.
        if (next) setHref(editor.getAttributes("link").href ?? "");
      }}>
      {/*
        `PopoverTrigger` with classes directly, NOT `render={<Button/>}`. Base
        UI's trigger already renders a button, so wrapping one inside it nests
        two — invalid HTML, and the inner one swallows the click the popover is
        listening for. The same shape `InlinePriority` uses.
      */}
      <PopoverTrigger
        type="button"
        aria-label="Link"
        title="Link"
        aria-pressed={active}
        disabled={disabled}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
          "[&_svg]:size-4",
          active && "bg-accent text-accent-foreground",
        )}>
        <Link2 />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-2">
          <Input
            value={href}
            ref={focusWithoutScroll}
            placeholder="example.com"
            aria-label="Link address"
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              }
            }}
          />
          <div className="flex gap-1.5">
            <Button type="button" size="sm" onClick={apply}>
              {href.trim() ? "Apply" : "Remove"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
