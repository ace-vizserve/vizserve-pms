import { cn } from "@/lib/utils";

/**
 * P7-56 — THE EDITOR'S BOX, WITHOUT THE EDITOR.
 *
 * Two things need to draw an empty editor, and neither may pull ProseMirror in
 * to do it: `rich-text-editor.tsx` renders this while the real component is
 * still downloading, and the implementation renders it for the frame before
 * TipTap has built its document.
 *
 * It lives in its own module for exactly that reason. If the class string were
 * declared next to the implementation, importing it from the lazy wrapper would
 * load the implementation, which is the whole thing the wrapper exists to
 * avoid — the bundle would split and then immediately un-split itself.
 */

/** Matches `components/ui/textarea.tsx`, so a field does not change shape. */
export const EDITOR_SHELL =
  "w-full rounded-md border border-input bg-muted text-sm transition-[color,box-shadow] " +
  "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20";

/**
 * The toolbar strip is `h-9` and the body carries the caller's `minHeight`, so
 * the box occupies its final height before anything interactive arrives. It is
 * `aria-hidden` and holds no controls: there is nothing here to operate yet,
 * and announcing an empty toolbar would be a lie about what is on screen.
 */
export function RichTextEditorShell({
  minHeight = "min-h-16",
  className,
}: {
  minHeight?: string;
  className?: string;
}) {
  return (
    <div className={cn(EDITOR_SHELL, className)} aria-hidden>
      <div className="h-9 border-b" />
      <div className={cn("px-2.5 py-2", minHeight)} />
    </div>
  );
}
