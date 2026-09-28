"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";

/**
 * P12 — one board column's cards: virtualised, and able to ask for more.
 *
 * The column scrolls on its own (the board caps itself at one screen), so the
 * virtualiser watches THIS scroll box, not the window. Only the cards near its
 * viewport are built; spacers keep the scrollbar honest, and each card is
 * measured because titles wrap and subtask groups open.
 *
 * `onReachEnd` is how a finished column loads its next page (infinite scroll):
 * a sentinel at the bottom of the list fires it when it scrolls into view, so it
 * works whether or not the list is long enough to virtualise.
 *
 * Short columns (under `VIRTUALIZE_FROM`) render whole: measuring costs more
 * than it saves, and a column of eight cards has nothing to gain.
 *
 * Drag and drop is unaffected: a card can only be picked up while it is on
 * screen, which is exactly when it exists, and the drop target is the column.
 */
const VIRTUALIZE_FROM = 25;
const ESTIMATED_CARD_HEIGHT = 132;

export function VirtualCardList<T>({
  items,
  getKey,
  renderItem,
  empty,
  onReachEnd,
  loadingMore = false,
  className,
}: {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  empty: ReactNode;
  /** Called when the bottom of the list scrolls into view. Omit when there is nothing more. */
  onReachEnd?: () => void;
  loadingMore?: boolean;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const virtual = items.length >= VIRTUALIZE_FROM;

  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    overscan: 6,
    getItemKey: (index) => (items[index] ? getKey(items[index]) : index),
  });

  // Infinite scroll: the sentinel sits after the last card.
  const reachEnd = useRef(onReachEnd);
  useEffect(() => {
    reachEnd.current = onReachEnd;
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !onReachEnd) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reachEnd.current?.();
      },
      // Start loading a little before the bottom is actually reached.
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onReachEnd, items.length]);

  const virtualItems = virtual ? virtualizer.getVirtualItems() : [];
  const padTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const padBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0;

  return (
    <div ref={scrollRef} className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-2", className)}>
      {items.length === 0 ? (
        empty
      ) : virtual ? (
        <>
          <div aria-hidden style={{ height: padTop, flexShrink: 0 }} />
          {virtualItems.map((item) => (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="shrink-0 pb-2">
              {renderItem(items[item.index]!)}
            </div>
          ))}
          <div aria-hidden style={{ height: padBottom, flexShrink: 0 }} />
        </>
      ) : (
        items.map((item) => (
          <div key={getKey(item)} className="shrink-0 pb-2">
            {renderItem(item)}
          </div>
        ))
      )}

      <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />

      {loadingMore ? (
        <p role="status" className="py-2 text-center text-2xs text-muted-foreground">
          Loading more…
        </p>
      ) : null}
    </div>
  );
}
