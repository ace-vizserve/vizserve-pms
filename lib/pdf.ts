/**
 * A minimal PDF writer. No dependency, on purpose.
 *
 * P7-34 needs a printable, signable leave audit — which means a real PDF file,
 * not a print stylesheet somebody has to remember to "Save as PDF" from. The
 * obvious move is to add `pdfkit` or `@react-pdf/renderer`, and this project has
 * already declined that trade once: the payroll CSV refused SheetJS on the
 * grounds that it was not currently a dependency and the output did not need it
 * (`P5-11`). The same reasoning holds here, more strongly:
 *
 *   - The document is a TABLE. Text, rules, and a shaded header band. Nothing a
 *     layout engine earns its megabyte on.
 *   - HELVETICA IS ONE OF THE BASE 14 FONTS every PDF reader is required to
 *     have. No font file, no embedding, no subsetting — which is the part of
 *     PDF generation that actually justifies a library.
 *   - `node_modules` in this repo lives in a OneDrive-synced folder that has
 *     corrupted packages twice. Every dependency not added is one fewer thing
 *     that can arrive truncated.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: images, embedded fonts, non-Latin text,
 * compression, links, outlines, or anything that reflows. If a future report
 * needs one of those, that is the moment to reach for a library rather than to
 * grow this file — the whole argument above depends on the output staying
 * simple.
 *
 * The format written is PDF 1.4, uncompressed, with a classic cross-reference
 * table. Uncompressed because a page of text is a few kilobytes either way, and
 * a byte stream somebody can read in a text editor is worth far more than the
 * saving on the day something is wrong with it.
 */

/** A4 portrait, in PDF points (1/72 inch). */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

export type PdfFont = "regular" | "bold";

/**
 * Helvetica advance widths, per 1000 units of em, for ASCII 32-126.
 *
 * Straight from the Adobe AFM metrics, which every conforming reader uses for
 * the base-14 fonts — so a string measured here occupies exactly this much on
 * the page. That exactness only matters in two places, and they are the two
 * that go visibly wrong without it: truncating a long name to fit its column,
 * and right-aligning a number under its heading.
 *
 * DIGITS ARE ALL 556, and identically so in Helvetica-Bold. That is what makes
 * a right-aligned column of figures land on the same edge whether or not the
 * total row is bold, with no per-font measurement at all.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32-47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48-63
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64-79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 80-95
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 96-111
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 112-126
];

/** Fallback advance for anything outside the table: the width of 'n'. */
const FALLBACK_WIDTH = HELVETICA_WIDTHS["n".charCodeAt(0) - 32];

/**
 * Bold is wider than regular, letter for letter, but not uniformly — so rather
 * than carry a second 95-entry table for the handful of bold strings in one
 * report, regular widths are scaled by the ratio of the two fonts' averages.
 *
 * It over-estimates more often than it under-estimates, which is the safe
 * direction: a bold heading truncates a character early rather than running
 * into the column beside it. Digits are exempt, because they are 556 in both
 * fonts and digits are the only bold text that has to align with anything.
 */
const BOLD_RATIO = 1.06;

/** Anything outside Latin-1 becomes this. See `encodeLatin1`. */
const SUBSTITUTE = 0x3f; // '?'

/**
 * Width of `text` at `size`, in points.
 *
 * Characters above 126 fall back to the width of a lowercase 'n'. WinAnsi does
 * carry the accented Latin letters a Filipino staff list needs — the enye among
 * them — and their advances are close enough to 'n' that a truncation decision
 * is never wrong by more than a fraction of a character.
 */
export function measureText(text: string, size: number, font: PdfFont = "regular"): number {
  let units = 0;

  for (const character of text) {
    const code = character.codePointAt(0) ?? SUBSTITUTE;
    const width = code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : FALLBACK_WIDTH;

    // Digits keep their true width in both fonts, so a bold total lines up with
    // the regular figures above it.
    const isDigit = code >= 48 && code <= 57;
    units += font === "bold" && !isDigit ? width * BOLD_RATIO : width;
  }

  return (units * size) / 1000;
}

/**
 * Cut `text` to fit `maxWidth`, ending in an ellipsis when it does not.
 *
 * A single ellipsis character rather than three dots: WinAnsi has it at 0x85,
 * it is one glyph rather than three, and a name cut mid-word is otherwise hard
 * to tell from a name that genuinely ends there.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  size: number,
  font: PdfFont = "regular",
): string {
  if (measureText(text, size, font) <= maxWidth) return text;

  const ellipsis = "…";
  const room = maxWidth - measureText(ellipsis, size, font);
  if (room <= 0) return "";

  let cut = "";
  for (const character of text) {
    if (measureText(cut + character, size, font) > room) break;
    cut += character;
  }

  return `${cut.trimEnd()}${ellipsis}`;
}

/**
 * One byte per character, WinAnsiEncoding.
 *
 * WinAnsi is Latin-1 with 0x80-0x9F reallocated to typographic characters, and
 * the only one of those this file uses is the ellipsis at 0x85. Everything
 * above 0xFF is replaced rather than dropped: a missing character shifts a
 * column and looks like a data error, where a '?' looks like what it is.
 */
function encodeLatin1(text: string): number[] {
  const bytes: number[] = [];

  for (const character of text) {
    const code = character.codePointAt(0) ?? SUBSTITUTE;
    if (character === "…") bytes.push(0x85);
    else if (code <= 0xff) bytes.push(code);
    else bytes.push(SUBSTITUTE);
  }

  return bytes;
}

/**
 * PDF string literal escaping.
 *
 * Backslash first — escaping it after the parentheses would escape the
 * backslashes this function had just added. A name containing a bracket is not
 * hypothetical: "Test Manager (All)" is already in the seeded staff list, and
 * an unescaped one ends the string early and corrupts the stream length that
 * every byte offset after it depends on.
 */
function escapePdfText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

type Page = { operations: string[] };

export type TextOptions = {
  size?: number;
  font?: PdfFont;
  /** `right` positions the string's RIGHT edge at `x`. */
  align?: "left" | "right";
  /** 0 is black, 1 is white. */
  gray?: number;
};

/**
 * A document being built.
 *
 * COORDINATES ARE FROM THE TOP-LEFT, which PDF's are not — PDF puts the origin
 * at the bottom-left with y increasing upward. The flip happens once, in `y()`
 * below, because a report is written down the page and every call site that had
 * to invert its own coordinates would be a place to get it backwards.
 */
export class PdfDocument {
  private readonly pages: Page[] = [];
  private current: Page | null = null;

  constructor(
    readonly width: number = A4_WIDTH,
    readonly height: number = A4_HEIGHT,
  ) {}

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.current = { operations: [] };
    this.pages.push(this.current);
  }

  private page(): Page {
    if (!this.current) throw new Error("Call addPage() before drawing.");
    return this.current;
  }

  /** Top-left origin to PDF's bottom-left one. */
  private y(fromTop: number): number {
    return this.height - fromTop;
  }

  text(x: number, yFromTop: number, value: string, options: TextOptions = {}): void {
    if (value === "") return;

    const size = options.size ?? 9;
    const font = options.font ?? "regular";
    const left = options.align === "right" ? x - measureText(value, size, font) : x;
    const gray = options.gray ?? 0;

    this.page().operations.push(
      "BT",
      `${gray.toFixed(3)} g`,
      `/${font === "bold" ? "F2" : "F1"} ${size} Tf`,
      `${left.toFixed(2)} ${this.y(yFromTop).toFixed(2)} Td`,
      `(${escapePdfText(value)}) Tj`,
      "ET",
    );
  }

  line(
    x1: number,
    y1FromTop: number,
    x2: number,
    y2FromTop: number,
    options: { width?: number; gray?: number } = {},
  ): void {
    this.page().operations.push(
      `${(options.gray ?? 0).toFixed(3)} G`,
      `${(options.width ?? 0.5).toFixed(2)} w`,
      `${x1.toFixed(2)} ${this.y(y1FromTop).toFixed(2)} m`,
      `${x2.toFixed(2)} ${this.y(y2FromTop).toFixed(2)} l`,
      "S",
    );
  }

  /** `yFromTop` is the rectangle's TOP edge; it extends `height` downward. */
  rect(x: number, yFromTop: number, width: number, height: number, gray: number): void {
    this.page().operations.push(
      `${gray.toFixed(3)} g`,
      `${x.toFixed(2)} ${this.y(yFromTop + height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re`,
      "f",
    );
  }

  /**
   * Serialise to bytes.
   *
   * THE CROSS-REFERENCE TABLE IS THE WHOLE DIFFICULTY. Every entry is the BYTE
   * offset of an object from the start of the file, in a fixed 20-character
   * format, and a reader uses it to seek directly rather than scanning. Get one
   * offset wrong and the file opens blank with no error worth reading — which
   * is why the body is assembled as byte arrays and measured, never as a string
   * whose `.length` would count characters instead.
   */
  build(): Uint8Array {
    if (this.pages.length === 0) throw new Error("A PDF needs at least one page.");

    const objects: number[][] = [];
    const push = (source: string | number[]): void => {
      objects.push(typeof source === "string" ? encodeLatin1(source) : source);
    };

    // Numbered up front so the catalog and the pages tree can reference each
    // other, and the tree can list pages, before any of them is written.
    const catalogNumber = 1;
    const pagesNumber = 2;
    const regularFontNumber = 3;
    const boldFontNumber = 4;
    const firstPageNumber = 5;
    // Each page is an object plus its content stream, interleaved.
    const pageNumbers = this.pages.map((_, index) => firstPageNumber + index * 2);

    push(`${catalogNumber} 0 obj\n<< /Type /Catalog /Pages ${pagesNumber} 0 R >>\nendobj\n`);
    push(
      `${pagesNumber} 0 obj\n<< /Type /Pages /Kids [${pageNumbers
        .map((number) => `${number} 0 R`)
        .join(" ")}] /Count ${this.pages.length} >>\nendobj\n`,
    );
    push(
      `${regularFontNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ` +
        `/Encoding /WinAnsiEncoding >>\nendobj\n`,
    );
    push(
      `${boldFontNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ` +
        `/Encoding /WinAnsiEncoding >>\nendobj\n`,
    );

    this.pages.forEach((page, index) => {
      const pageNumber = pageNumbers[index];
      const contentNumber = pageNumber + 1;
      const contentBytes = encodeLatin1(page.operations.join("\n"));

      push(
        `${pageNumber} 0 obj\n<< /Type /Page /Parent ${pagesNumber} 0 R ` +
          `/MediaBox [0 0 ${this.width.toFixed(2)} ${this.height.toFixed(2)}] ` +
          `/Resources << /Font << /F1 ${regularFontNumber} 0 R /F2 ${boldFontNumber} 0 R >> >> ` +
          `/Contents ${contentNumber} 0 R >>\nendobj\n`,
      );

      // `/Length` is the byte count of the stream, which is why the content is
      // encoded before the header describing it is written.
      push([
        ...encodeLatin1(`${contentNumber} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
        ...contentBytes,
        ...encodeLatin1("\nendstream\nendobj\n"),
      ]);
    });

    const bytes: number[] = [...encodeLatin1("%PDF-1.4\n")];
    const offsets: number[] = [];

    for (const object of objects) {
      offsets.push(bytes.length);
      bytes.push(...object);
    }

    const xrefOffset = bytes.length;
    // Entry 0 is the head of the free list and is always exactly this.
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      // Ten digits, then " 00000 n " and a newline: twenty bytes per entry, and
      // readers do seek by multiplying. The trailing space is not decorative.
      xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }

    bytes.push(
      ...encodeLatin1(
        `${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R >>\n` +
          `startxref\n${xrefOffset}\n%%EOF\n`,
      ),
    );

    return Uint8Array.from(bytes);
  }
}
