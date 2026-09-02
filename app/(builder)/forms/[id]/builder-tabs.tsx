"use client";

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { BuilderTab } from "./tabs";

/**
 * P7-66 — QUESTIONS · RESPONSES · SETTINGS.
 *
 * The builder used to be one long scroll: the canvas, then a collapsed
 * disclosure holding eleven settings, then the answers table under that. Three
 * unrelated jobs stacked in one column, where the two below the fold were found
 * by accident or not at all — and the settings card was collapsed by default
 * precisely because it made the form itself look like the smaller half of its
 * own page.
 *
 * ⚠️ ALL THREE PANELS ARE RENDERED AND KEPT MOUNTED. `keepMounted` is not a
 * performance choice, it is the only way the canvas survives a tab change: the
 * builder store lives in `FieldBuilder`'s own state, so unmounting it to look at
 * the answers and coming back would discard the open question, the selection and
 * anything typed into it. Base UI unmounts a hidden panel by default.
 *
 * The panels are SERVER-RENDERED and passed in as children. That is what lets a
 * client tab strip sit over an `async` Responses table without this component
 * knowing anything about it — and it means switching tabs costs no round trip,
 * which a `?tab=` link would.
 *
 * ⚠️ THE INITIAL TAB COMES FROM THE URL ALL THE SAME, so a link to a form's
 * answers opens on its answers. The server reads `?tab=` and hands it here as
 * the starting value; from then on the state is local, because a tab click is
 * not something Back should have to undo.
 */

export function BuilderTabs({
  initialTab,
  responsesLabel,
  responsesCount,
  questions,
  responses,
  settings,
}: {
  initialTab: BuilderTab;
  /**
   * ⚠️ THE WORD DIFFERS BY WHAT THE FORM IS FOR, and it is not decoration. A
   * client form's submissions are requests — with a reference number, a status
   * and an SLA clock — and calling them "responses" invites somebody to look
   * here for a queue that lives at /requests. An engagement form collects
   * answers. Two products, one builder.
   */
  responsesLabel: string;
  /**
   * How many submissions the form has, which is what the badge shows.
   *
   * Always a real number by the time this renders: the page refuses to open the
   * builder at all on a count that failed, because the same number decides
   * whether the purpose and the reference prefix render locked. See
   * `countFormSubmissions` and `readFailure`.
   */
  responsesCount: number;
  questions: React.ReactNode;
  responses: React.ReactNode;
  settings: React.ReactNode;
}) {
  const [tab, setTab] = useState<BuilderTab>(initialTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as BuilderTab)}
      // `gap-0`: the strip is a sticky rule directly under the top bar, and the
      // Root's default gap would open a stripe of page background between them.
      className="min-h-0 flex-1 gap-0"
    >
      {/*
        Sticky at 56px — the height of `BuilderHeader` — so the tabs stay
        reachable while a form with thirty questions scrolls under them, exactly
        as the header does.
      */}
      <TabsList
        variant="line"
        className="sticky top-14 z-20 h-auto w-full justify-center rounded-none border-b bg-card p-0"
      >
        <TabsTrigger value="questions" className="h-auto flex-none px-4.5 py-3">
          Questions
        </TabsTrigger>
        <TabsTrigger value="responses" className="h-auto flex-none gap-1.5 px-4.5 py-3">
          {responsesLabel}
          {/*
            ⚠️ NO BADGE ON AN EMPTY FORM. A pill reading 0 beside the word
            "Answers" is a count of nothing dressed as a count — and on the tab
            somebody visits precisely to find out whether anybody has answered
            yet, the empty state inside says it better than a zero on the way in.
          */}
          {responsesCount > 0 ? (
            <span className="inline-grid h-[19px] min-w-[19px] place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
              {responsesCount}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="settings" className="h-auto flex-none px-4.5 py-3">
          Settings
        </TabsTrigger>
      </TabsList>

      {/*
        `keepMounted` on all three. See the note at the top: the Questions panel
        holds the builder store, and the other two are cheap server output that
        is already on the page by the time this renders.
      */}
      <TabsContent value="questions" keepMounted className="min-h-0">
        {questions}
      </TabsContent>
      <TabsContent value="responses" keepMounted className="min-h-0">
        {responses}
      </TabsContent>
      <TabsContent value="settings" keepMounted className="min-h-0">
        {settings}
      </TabsContent>
    </Tabs>
  );
}
