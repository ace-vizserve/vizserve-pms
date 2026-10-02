import { A4_HEIGHT, A4_WIDTH, measureText, PdfDocument, truncateToWidth } from "@/lib/pdf";

import type { AverageRow, PersonRow } from "./people-table";
import { isWorse } from "./rows";

/**
 * P15-09 — THE PEOPLE TAB AS A PDF: a KPI pack somebody reads rather than a
 * sheet somebody works in.
 *
 * Built in the browser from the rows the table already holds, so it is exactly
 * the people and the period on screen — the page read them through RLS.
 *
 * Three parts, A4 landscape:
 *   1. TILES — the period at a glance.
 *   2. CHARTS — one horizontal bar chart per measure, everybody in it, best
 *      first, the department average as a grey rule. ONE MEASURE PER CHART:
 *      percentages, hours and counts never share an axis.
 *   3. THE TABLE — every column on screen, the average as the last row.
 *
 * Orange means "clearly worse than the average" (`isWorse`, the same rule as
 * the table's ▾) and is always paired with words: "below avg" beside a bar,
 * and bold in the table, with the key printed on the page.
 *
 * Helvetica through `lib/pdf.ts`: WinAnsi only, so no en dashes or arrows in
 * anything drawn here — they encode as "?".
 */

const WIDTH = A4_HEIGHT; // landscape
const HEIGHT = A4_WIDTH;
const MARGIN = 36;
const CONTENT = WIDTH - MARGIN * 2;
const BOTTOM = HEIGHT - MARGIN - 18;

const INK = "#1F2433";
const MUTED = 0.42;
const BAR = "#4359A5"; // --primary, the brand blue
const WORSE = "#C2570C";
const TILE = "#EEF1F8";

type Measure = {
  title: string;
  pick: (row: PersonRow) => number | null;
  average: number | null;
  better: "up" | "down";
  format: (value: number) => string;
  /** A fixed axis end, for percentages. Otherwise the largest value. */
  max?: number;
};

const pct = (value: number) => `${Math.round(value)}%`;
const count = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const hours = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;

export function renderPeoplePdf(
  rows: readonly PersonRow[],
  average: AverageRow,
  meta: { period: string; scope: string; generatedOn: string },
): Uint8Array {
  const document = new PdfDocument(WIDTH, HEIGHT);
  let page = 0;

  function footer() {
    document.text(MARGIN, HEIGHT - MARGIN + 6, "VizServe Team Portal - people performance", { size: 7, gray: 0.5 });
    document.text(WIDTH - MARGIN, HEIGHT - MARGIN + 6, `${meta.period}   ·   Page ${page}`, {
      size: 7,
      gray: 0.5,
      align: "right",
    });
  }

  function newPage() {
    if (page > 0) footer();
    document.addPage();
    page += 1;
  }

  // --- 1. Title and tiles --------------------------------------------------
  newPage();
  document.text(MARGIN, 50, "People performance", { size: 20, font: "bold", color: INK });
  document.text(MARGIN, 68, `${meta.period}   ·   ${meta.scope}`, { size: 10, gray: 0.25 });
  document.text(WIDTH - MARGIN, 50, `Generated ${meta.generatedOn}`, { size: 8, gray: MUTED, align: "right" });
  document.text(WIDTH - MARGIN, 62, `${rows.length} ${rows.length === 1 ? "person" : "people"}`, {
    size: 8,
    gray: MUTED,
    align: "right",
  });

  const sum = (pick: (row: PersonRow) => number | null) =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

  const tiles: { label: string; value: string }[] = [
    { label: "Tasks completed", value: String(sum((row) => row.completed)) },
    { label: "On time (average)", value: average.onTime === null ? "-" : pct(average.onTime) },
    { label: "QA first pass (average)", value: average.firstPass === null ? "-" : pct(average.firstPass) },
    { label: "Hours logged", value: `${Math.round(sum((row) => row.minutes) / 60).toLocaleString("en-US")}h` },
    { label: "Overdue now", value: String(sum((row) => row.overdue)) },
    { label: "Days absent", value: count(sum((row) => row.absent)) },
  ];

  const gap = 10;
  const tileWidth = (CONTENT - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (tileWidth + gap);
    document.rect(x, 84, tileWidth, 46, TILE);
    document.text(x + 10, 100, tile.label, { size: 8, gray: 0.35 });
    document.text(x + 10, 121, tile.value, { size: 17, font: "bold", color: INK });
  });

  // The key, once, where the charts start.
  let keyX = MARGIN;
  for (const item of [
    { swatch: BAR, label: "Each person" },
    { swatch: WORSE, label: "Clearly worse than the average (also says 'worse than avg')" },
    { swatch: null, label: "Department average" },
  ]) {
    if (item.swatch) document.rect(keyX, 144, 14, 6, item.swatch);
    else document.line(keyX + 7, 142, keyX + 7, 152, { gray: 0.45, width: 1 });
    document.text(keyX + 18, 150, item.label, { size: 8, gray: 0.3 });
    keyX += 18 + measureText(item.label, 8) + 18;
  }

  // --- 2. Charts, flowing down two columns ---------------------------------
  const measures: Measure[] = [
    { title: "Tasks completed", pick: (r) => r.completed, average: average.completed, better: "up", format: count },
    { title: "Delivered on time", pick: (r) => r.onTime, average: average.onTime, better: "up", format: pct, max: 100 },
    { title: "QA first pass", pick: (r) => r.firstPass, average: average.firstPass, better: "up", format: pct, max: 100 },
    { title: "Hours logged", pick: (r) => r.minutes, average: average.minutes, better: "up", format: hours },
    { title: "Overdue now", pick: (r) => r.overdue, average: average.overdue, better: "down", format: count },
    { title: "Timesheets on time", pick: (r) => r.timesheetsOnTime, average: average.timesheetsOnTime, better: "up", format: pct, max: 100 },
    { title: "Late arrivals", pick: (r) => r.late, average: average.late, better: "down", format: count },
    { title: "Days absent", pick: (r) => r.absent, average: average.absent, better: "down", format: count },
  ];

  const COLUMN_GAP = 28;
  const columnWidth = (CONTENT - COLUMN_GAP) / 2;
  const NAME_WIDTH = 104;
  const VALUE_ROOM = 70;
  const ROW = 12;
  const TITLE = 20;

  let column = 0;
  let y = 168;
  const columnTop = () => (page === 1 ? 168 : 48);

  function nextColumn() {
    if (column === 0) {
      column = 1;
    } else {
      newPage();
      column = 0;
    }
    y = columnTop();
  }

  for (const measure of measures) {
    const values = rows
      .map((row) => ({ row, value: measure.pick(row) }))
      // Best first; people with nothing to measure at the foot, saying so.
      .sort((a, b) => {
        if (a.value === null) return b.value === null ? a.row.name.localeCompare(b.row.name) : 1;
        if (b.value === null) return -1;
        return (measure.better === "up" ? b.value - a.value : a.value - b.value) || a.row.name.localeCompare(b.row.name);
      });

    const largest = Math.max(measure.average ?? 0, ...values.map((entry) => entry.value ?? 0));
    const axisEnd = measure.max ?? (largest > 0 ? largest : 1);

    // WHOLE if it can be: a chart that would fit in a fresh column starts
    // there rather than splitting. Only one taller than a column is split, and
    // then only once there is room for its title and three rows.
    const chartHeight = TITLE + values.length * ROW;
    const freshColumn = BOTTOM - 48;
    if (y + chartHeight > BOTTOM && (chartHeight <= freshColumn || y + TITLE + ROW * 3 > BOTTOM)) nextColumn();

    let segmentTop = 0;
    /** Value labels for the current segment, drawn AFTER the average rule so it never crosses one. */
    let labels: (() => void)[] = [];
    const flushLabels = () => {
      for (const draw of labels) draw();
      labels = [];
    };
    const x = () => MARGIN + column * (columnWidth + COLUMN_GAP);
    const plotLeft = () => x() + NAME_WIDTH + 6;
    const plotWidth = columnWidth - NAME_WIDTH - 6 - VALUE_ROOM;

    const drawAverage = (bottom: number) => {
      if (measure.average === null) return;
      const at = plotLeft() + (Math.min(measure.average, axisEnd) / axisEnd) * plotWidth;
      document.line(at, segmentTop - 2, at, bottom + 1, { gray: 0.45, width: 1 });
    };

    const title = (continued: boolean) => {
      document.text(x(), y + 10, `${measure.title}${continued ? " (continued)" : ""}`, {
        size: 10,
        font: "bold",
        color: INK,
      });
      if (measure.average !== null) {
        document.text(x() + columnWidth, y + 10, `average ${measure.format(measure.average)}`, {
          size: 8,
          gray: MUTED,
          align: "right",
        });
      }
      y += TITLE;
      segmentTop = y;
    };

    title(false);

    for (const { row, value } of values) {
      if (y + ROW > BOTTOM) {
        drawAverage(y);
        flushLabels();
        nextColumn();
        title(true);
      }

      document.text(x(), y + 8.5, truncateToWidth(row.name, NAME_WIDTH, 8), { size: 8, color: INK });

      if (value === null) {
        document.text(plotLeft(), y + 8.5, "not measured", { size: 7, gray: 0.55 });
      } else {
        const worse = isWorse(value, measure.average, measure.better);
        const length = Math.max(1.5, (Math.min(value, axisEnd) / axisEnd) * plotWidth);
        document.rect(plotLeft(), y + 2, length, 8, worse ? WORSE : BAR);
        const label = measure.format(value);
        const labelX = plotLeft() + length + 2;
        const rowY = y;
        labels.push(() => {
          const note = worse ? "worse than avg" : "";
          const labelWidth = measureText(label, 8, worse ? "bold" : "regular");
          const noteWidth = note ? measureText(note, 7) + 4 : 0;
          document.rect(labelX, rowY + 1, labelWidth + noteWidth + 4, 10, 1);
          document.text(labelX + 2, rowY + 8.5, label, { size: 8, color: INK, font: worse ? "bold" : "regular" });
          if (note) document.text(labelX + 2 + labelWidth + 4, rowY + 8.5, note, { size: 7, color: WORSE });
        });
      }

      y += ROW;
    }

    drawAverage(y);
    flushLabels();
    y += 14;
  }

  // --- 3. The table ---------------------------------------------------------
  newPage();
  document.text(MARGIN, 46, "Every measure", { size: 14, font: "bold", color: INK });
  document.text(MARGIN, 60, `${meta.period}   ·   ${meta.scope}. Bold orange: clearly worse than the average.`, {
    size: 8,
    gray: MUTED,
  });

  type Cell = { header: string; width: number; value: (row: PersonRow) => string; worse?: (row: PersonRow) => boolean };
  const n = (value: number | null, digits = 0) => (value === null ? "-" : value.toFixed(digits));
  const p = (value: number | null) => (value === null ? "-" : pct(value));

  const cells: Cell[] = [
    { header: "Open", width: 36, value: (r) => String(r.open) },
    { header: "Overdue", width: 42, value: (r) => String(r.overdue), worse: (r) => isWorse(r.overdue, average.overdue, "down") },
    { header: "Done", width: 36, value: (r) => String(r.completed) },
    { header: "On time", width: 42, value: (r) => p(r.onTime), worse: (r) => isWorse(r.onTime, average.onTime, "up") },
    { header: "Cycle d", width: 40, value: (r) => n(r.cycleDays, 1), worse: (r) => isWorse(r.cycleDays, average.cycleDays, "down") },
    { header: "QA 1st", width: 38, value: (r) => p(r.firstPass), worse: (r) => isWorse(r.firstPass, average.firstPass, "up") },
    { header: "QA ret.", width: 38, value: (r) => String(r.qaReturns) },
    { header: "Reviews", width: 42, value: (r) => String(r.reviews) },
    { header: "Hours", width: 40, value: (r) => hours(r.minutes) },
    { header: "Logged", width: 40, value: (r) => p(r.accounted), worse: (r) => isWorse(r.accounted, average.accounted, "up") },
    { header: "TS on time", width: 50, value: (r) => p(r.timesheetsOnTime), worse: (r) => isWorse(r.timesheetsOnTime, average.timesheetsOnTime, "up") },
    { header: "Late", width: 32, value: (r) => n(r.late), worse: (r) => isWorse(r.late, average.late, "down") },
    { header: "Absent", width: 38, value: (r) => (r.absent === null ? "-" : count(r.absent)), worse: (r) => isWorse(r.absent, average.absent, "down") },
    { header: "Rating", width: 36, value: (r) => n(r.rating, 1) },
  ];

  const PERSON = 132;
  const DEPARTMENT = CONTENT - PERSON - cells.reduce((total, cell) => total + cell.width, 0);
  const TABLE_ROW = 15;

  let ty = 72;
  const header = () => {
    document.rect(MARGIN, ty, CONTENT, 16, 0.92);
    document.text(MARGIN + 4, ty + 11, "Person", { size: 7.5, font: "bold" });
    document.text(MARGIN + PERSON, ty + 11, "Department", { size: 7.5, font: "bold" });
    let cx = MARGIN + PERSON + DEPARTMENT;
    for (const cell of cells) {
      cx += cell.width;
      document.text(cx - 4, ty + 11, cell.header, { size: 7.5, font: "bold", align: "right" });
    }
    ty += 16;
  };
  header();

  // By department, "no department" last, then name — the order people look themselves up in.
  const sorted = [...rows].sort((a, b) => {
    if (a.department !== b.department) {
      if (a.department === null) return 1;
      if (b.department === null) return -1;
      return a.department.localeCompare(b.department);
    }
    return a.name.localeCompare(b.name);
  });

  for (const row of sorted) {
    if (ty + TABLE_ROW > BOTTOM) {
      newPage();
      ty = 40;
      header();
    }
    document.text(MARGIN + 4, ty + 10.5, truncateToWidth(row.name, PERSON - 8, 8), { size: 8, color: INK });
    document.text(MARGIN + PERSON, ty + 10.5, truncateToWidth(row.department ?? "No department", DEPARTMENT - 6, 8), {
      size: 8,
      gray: row.department ? 0.25 : 0.55,
    });
    let cx = MARGIN + PERSON + DEPARTMENT;
    for (const cell of cells) {
      cx += cell.width;
      const worse = cell.worse?.(row) ?? false;
      document.text(cx - 4, ty + 10.5, cell.value(row), {
        size: 8,
        font: worse ? "bold" : "regular",
        color: worse ? WORSE : INK,
        align: "right",
      });
    }
    ty += TABLE_ROW;
    document.line(MARGIN, ty, MARGIN + CONTENT, ty, { gray: 0.88, width: 0.4 });
  }

  // The average row, as on screen.
  if (ty + TABLE_ROW > BOTTOM) {
    newPage();
    ty = 40;
    header();
  }
  document.rect(MARGIN, ty, CONTENT, TABLE_ROW, 0.95);
  document.text(MARGIN + 4, ty + 10.5, "Department average", { size: 8, font: "bold" });
  const averages: (string | null)[] = [
    n(average.open, 1), n(average.overdue, 1), n(average.completed, 1), p(average.onTime), n(average.cycleDays, 1),
    p(average.firstPass), n(average.qaReturns, 1), n(average.reviews, 1), hours(average.minutes), p(average.accounted),
    p(average.timesheetsOnTime), n(average.late, 1), n(average.absent, 1), n(average.rating, 1),
  ];
  let cx = MARGIN + PERSON + DEPARTMENT;
  cells.forEach((cell, index) => {
    cx += cell.width;
    document.text(cx - 4, ty + 10.5, averages[index] ?? "-", { size: 8, font: "bold", align: "right" });
  });

  footer();
  return document.build();
}

export function peoplePdfFilename(from: string, to: string): string {
  return `vizserve-people-${from}-to-${to}.pdf`;
}
