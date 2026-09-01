/**
 * Hand the browser a file a server action produced.
 *
 * P7-53 extracted this from `admin/users/users-table.tsx`, which was the only
 * caller until the report gained a builder screen and a member's own-record
 * button. Three copies of the base64 dance is three chances to get the encoding
 * subtly wrong, and the failure mode is a PDF that downloads, opens blank, and
 * gives no clue why.
 *
 * ⚠️ `atob` + `charCodeAt`, NEVER `TextEncoder`. `atob` returns one character
 * per byte with every code point below 256, so `charCodeAt` IS the byte.
 * `TextEncoder` would re-encode that as UTF-8 and turn every byte above 0x7F
 * into two — which is exactly how a "binary string" arrives unopenable.
 *
 * The blob URL is built and revoked in the same tick, as the DTR CSV export
 * does: one left dangling pins the whole file in memory for the life of the
 * page, and on a report of the whole company that is not nothing.
 */
export function downloadBase64(base64: string, filename: string, mimeType: string): void {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The only mime type this app downloads as base64 today. */
export function downloadPdf(base64: string, filename: string): void {
  downloadBase64(base64, filename, "application/pdf");
}
