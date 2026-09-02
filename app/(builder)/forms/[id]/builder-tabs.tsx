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
 * ⚠️ RESPONSES IS OPTIONAL, AND A CLIENT FORM DOES NOT PASS ONE. Two tabs, not
 * three, and not a third tab holding an explanation of why it is empty. The
 * reasoning is in `builderTabsFor`: a client form's submissions are requests,
 * and /requests is the one place requests are read.
 *
 * ⚠️ EVERY PANEL RENDERED IS KEPT MOUNTED. `keepMounted` is not a performance
 * choice, it is the only way the canvas survives a tab change: the builder store
 * lives in `FieldBuilder`'s own state, so unmounting it to look at the answers
 * and coming back would discard the open question, the selection and anything
 * typed into it. Base UI unmounts a hidden panel by default.
 *
 * The panels are SERVER-RENDERED and passed in as children. That is what lets a
 * client tab strip sit over an `async` Responses summary without this component
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
  responsesCount,
  questions,
  responses,
  settings,
}: {
  initialTab: BuilderTab;
  /**
   * How many answers the form has, which is what the badge shows.
   *
   * Always a real number by the time this renders: the page refuses to open the
   * builder at all on a count that failed, because the same number decides
   * whether the reference prefix and the anonymity switch render locked. See
   * `countFormSubmissions` and `readFailure`.
   */
  responsesCount: number;
  questions: React.ReactNode;
  /**
   * ⚠️ UNDEFINED ON A CLIENT FORM, WHICH REMOVES THE TAB RATHER THAN EMPTYING
   * IT. `builderTabsFor` decides; this prop is the same decision expressed as a
   * child, so the strip and the panel cannot disagree about whether the tab
   * exists.
   */
  responses?: React.ReactNode;
  settings: React.ReactNode;
}) {
  const [tab, setTab] = useState<BuilderTab>(initialTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as BuilderTab)}
      /*
        A FLEX COLUMN INSIDE A FIXED-HEIGHT ONE, so the panel below gets a real
        height to hand on. `flex-1` takes what the header left, `min-h-0` lets it
        be shorter than its content (without it a flex item refuses to shrink
        below `min-content` and pushes the column past the window), and `gap-0`
        closes the Root's default gap, which would otherwise open a stripe of
        page background between the tab strip and the panes.
      */
      className="flex min-h-0 flex-1 flex-col gap-0">
      {/*
        `shrink-0`, NOT `sticky`. The strip used to be `sticky top-14`, pinned to
        the header's height, because the page scrolled underneath it. Nothing
        scrolls past it any more — it is a fixed row of a fixed-height column, so
        it is always where it is, and the 56px in that `top-14` is one more
        number that had to stay in step with the header by hand.

        The rest is the mockup's `.maintabs`: full width, centred, `bg-card`, a
        hairline underneath.
      */}
      <TabsList
        variant="line"
        className="w-full shrink-0 justify-center rounded-none border-0 border-b border-border bg-card py-6">
        <div className="max-w-md mx-auto space-x-4">
          <TabsTrigger value="questions">Questions</TabsTrigger>
          {responses === undefined ? null : (
            <TabsTrigger value="responses">
              Responses
              {/*
              ⚠️ NO BADGE ON AN EMPTY FORM. A pill reading 0 beside the word
              "Responses" is a count of nothing dressed as a count — and on the
              tab somebody visits precisely to find out whether anybody has
              answered yet, the empty state inside says it better than a zero on
              the way in.
            */}
              {responsesCount > 0 ? (
                <span className="inline-grid h-[19px] min-w-[19px] place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
                  {responsesCount}
                </span>
              ) : null}
            </TabsTrigger>
          )}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </div>
      </TabsList>

      {/*
        `keepMounted` on every panel. See the note at the top: the Questions
        panel holds the builder store, and the others are cheap server output
        that is already on the page by the time this renders.
      */}
      {/*
        ⚠️ QUESTIONS DOES NOT SCROLL — IT HANDS ITS HEIGHT TO THE THREE PANES.

        A flex column so `FieldBuilder`'s grid can be `flex-1` and stop
        subtracting the chrome from `100svh` by hand. Below 1180px the panes
        stack into one column and there is nothing left to scroll them, so the
        panel takes the job back.
      */}
      <TabsContent value="questions" keepMounted className="flex flex-1 flex-col max-[1180px]:overflow-y-auto">
        {questions}
      </TabsContent>

      {/*
        ⚠️ THESE TWO SCROLL THEMSELVES. `app/(builder)/layout.tsx` clips the page
        at the window, so a panel that is taller than its row and does not scroll
        is simply cut off — no scrollbar, no way to reach the rest.
      */}
      {responses === undefined ? null : (
        <TabsContent value="responses" keepMounted className="min-h-0 flex-1 overflow-y-auto">
          {responses}
        </TabsContent>
      )}
      <TabsContent value="settings" keepMounted className="min-h-0 flex-1 overflow-y-auto">
        {settings}
      </TabsContent>
    </Tabs>
  );
}
