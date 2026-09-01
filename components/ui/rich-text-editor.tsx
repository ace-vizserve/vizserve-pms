"use client";

import dynamic from "next/dynamic";

import { RichTextEditorShell } from "@/components/ui/rich-text-editor-shell";

/**
 * P7-56 — THE EDITOR, LOADED ONLY WHEN A PAGE ACTUALLY DRAWS ONE.
 *
 * TipTap and ProseMirror are around 120KB, and importing them directly put that
 * in the first-load bundle of every route holding an editor — the task detail
 * page, the task list (its comment popovers), the board, both request screens
 * and both approval screens. On most visits nobody types into any of them.
 *
 * This module keeps the public import path (`@/components/ui/rich-text-editor`)
 * so no call site changed; the implementation moved to `-impl` beside it.
 *
 * ⚠️ `ssr: false` IS REQUIRED, NOT AN OPTIMISATION. The implementation already
 * sets TipTap's `immediatelyRender: false` because the editor cannot render on
 * the server without a hydration mismatch. Rendering the module on the server
 * only to produce an empty box costs a round trip and buys nothing.
 *
 * The `loading` fallback is the same box at `min-h-16`, the component's own
 * default. A field asking for a taller `minHeight` settles by a few pixels on
 * the frame the real editor mounts — the alternative is rendering nothing and
 * having the whole field appear at once, which is a far larger movement.
 */
export const RichTextEditor = dynamic(
  () => import("@/components/ui/rich-text-editor-impl").then((module) => module.RichTextEditor),
  {
    ssr: false,
    loading: () => <RichTextEditorShell />,
  },
);
