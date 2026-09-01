"use client";

import { useCallback, useEffect, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  Bold,
  Code,
  Heading3,
  Heading4,
  Italic,
  Link2,
  List,
  ListOrdered,
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
import { cn } from "@/lib/utils";

/**
 * P7-56 — the editor behind the six long-prose columns.
 *
 * ⚠️ ITS SCHEMA AND `RICH_TEXT_TAGS` ARE ONE DECISION, in two files that must
 * change together. A mark this toolbar offers but `sanitizeRichText` strips is
 * a button that appears to work and silently undoes itself on reload — the
 * worst class of bug this feature can have, because the user watched it work.
 *
 * WHAT IS DELIBERATELY ABSENT: images (this app has a real attachment system
 * and inlining base64 into a text column would quietly duplicate it), tables
 * (unusable at the width these fields render), and `h1`/`h2` (the page owns
 * those — see `lib/rich-text.ts`).
 *
 * The single biggest usability win here is not the toolbar, it is StarterKit's
 * INPUT RULES: typing `- `, `1. `, `## ` or `**bold**` formats as you go. Most
 * people will never press one of these buttons.
 */

/** Matches `components/ui/textarea.tsx`, so a field does not change shape. */
const SHELL =
  "w-full rounded-md border border-input bg-muted text-sm transition-[color,box-shadow] " +
  "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20";

export function RichTextEditor({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder,
  ariaLabel,
  invalid = false,
  minHeight = "min-h-16",
  className,
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
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  minHeight?: string;
  className?: string;
}) {
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
    ],
    content: value,
    editorProps: {
      attributes: {
        class: cn(RICH_TEXT_CLASS, "px-2.5 py-2 outline-none", minHeight),
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleKeyDown: (_view, event) => {
        if (!onSubmit) return false;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
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
    return (
      <div className={cn(SHELL, className)}>
        <div className="h-9 border-b" />
        <div className={cn("px-2.5 py-2", minHeight)} />
      </div>
    );
  }

  return (
    <div
      className={cn(SHELL, className)}
      aria-invalid={invalid || undefined}
      data-slot="rich-text-editor">
      <Toolbar editor={editor} disabled={disabled} />
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
    </div>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
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
    </div>
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
            autoFocus
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
