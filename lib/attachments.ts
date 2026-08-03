/**
 * P1-09 — file identification and naming.
 *
 * No `server-only` marker: the size formatter and the extension helper are
 * useful in the picker UI too, and nothing here touches a session.
 */

/** Signature ("magic number") checks for the allowlisted types. */
type Signature = { mime: string[]; offset: number; bytes: number[] };

const SIGNATURES: Signature[] = [
  { mime: ["image/png"], offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: ["image/jpeg"], offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: ["image/gif"], offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: ["application/pdf"], offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  // The whole Office/OpenXML family and .zip share one container format, so a
  // .docx and a .zip are indistinguishable here by design.
  {
    mime: [
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  // Legacy .doc/.xls/.ppt — OLE2 compound file.
  {
    mime: [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
    ],
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
];

/** WEBP is RIFF….WEBP — two checks at two offsets, so it gets its own path. */
function isWebp(head: Uint8Array): boolean {
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  return (
    riff.every((byte, index) => head[index] === byte) &&
    webp.every((byte, index) => head[8 + index] === byte)
  );
}

/** Types with no signature at all. Verified by shape, not by prefix. */
const SIGNATURELESS = new Set(["text/plain", "text/csv"]);

export type SniffResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Does the file's content match the type it claims to be?
 *
 * A browser sets `File.type` from the extension, so it is a claim, not a fact —
 * `payload.exe` renamed to `brief.pdf` arrives declaring application/pdf. This
 * reads the actual leading bytes, which the client cannot rewrite without
 * genuinely producing a file of that type.
 *
 * Not a malware scanner and not pretending to be one. It closes the trivial
 * rename, which is the attack this surface actually gets.
 */
export function sniffMatchesDeclaredType(head: Uint8Array, declaredMime: string): SniffResult {
  if (SIGNATURELESS.has(declaredMime)) {
    // Text has no magic number. Reject anything with a NUL byte in the first
    // chunk — no plain text file has one, and every binary does.
    if (head.includes(0x00)) {
      return { ok: false, reason: "That does not look like a text file." };
    }
    return { ok: true };
  }

  if (declaredMime === "image/webp") {
    return isWebp(head) ? { ok: true } : { ok: false, reason: "That file is not a WEBP image." };
  }

  const signature = SIGNATURES.find((candidate) => candidate.mime.includes(declaredMime));

  // An allowlisted type with no signature entry is a gap in this table, not
  // permission to skip the check.
  if (!signature) {
    return { ok: false, reason: "That file type cannot be verified." };
  }

  const matches = signature.bytes.every(
    (byte, index) => head[signature.offset + index] === byte,
  );

  return matches
    ? { ok: true }
    : { ok: false, reason: "The file's contents do not match its extension." };
}

/**
 * Makes a filename safe to put in a storage path.
 *
 * Strips directory separators and traversal, collapses everything exotic, and
 * caps the length. The original name is preserved in the database column and
 * shown in the UI — this is only the on-disk key.
 */
export function safeStorageName(filename: string): string {
  const trimmed = filename.trim().replace(/^.*[\\/]/, "");
  const dot = trimmed.lastIndexOf(".");

  const stem = (dot > 0 ? trimmed.slice(0, dot) : trimmed)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);

  const extension = (dot > 0 ? trimmed.slice(dot + 1) : "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 10)
    .toLowerCase();

  const base = stem || "file";
  return extension ? `${base}.${extension}` : base;
}

/** "2.4 MB". Binary units, because that is what the byte limit is written in. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
