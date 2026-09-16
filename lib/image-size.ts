/**
 * P7-67 — how big is this picture, read from the picture.
 *
 * ⚠️ THE SERVER MEASURES THE BYTES. This is the same rule P1-09 wrote down for
 * size and MIME type, applied to one more fact: a browser could tell us a
 * screenshot is 400×300, and a browser is the one participant that cannot be
 * trusted. It matters more than it sounds — the dimensions decide how the image
 * is CAPPED in a comment thread, so a lie about them is a lie about how much of
 * the page one comment gets to occupy.
 *
 * It also has to work where there is no browser at all. The ClickUp import
 * fetches 637 images from a CDN and inserts them into comment bodies with no
 * client in the loop; without this it would have nothing to write.
 *
 * NO DEPENDENCY. `image-size` and `probe-image-size` both do this and more, and
 * "more" is a decoder — the thing you least want pointed at an untrusted upload.
 * Four container formats, each of which states its dimensions in a fixed place
 * near the front, is about eighty lines. The repo already made this call once,
 * for `parse-duration`.
 *
 * ⚠️ IT READS A HEAD, NOT A FILE. `HEAD_BYTES` is what the caller should slice
 * off and hand over. PNG, GIF and WebP declare their size in the first 32 bytes;
 * only JPEG has to be walked, because its dimensions sit in a `SOF` marker that
 * an EXIF thumbnail can push a long way in. 128 KiB covers a phone photo with a
 * full EXIF block. Past that this returns null, the caller writes no dimensions,
 * and the image falls back to the default cap — a worse layout, never a failure.
 */

/** How much of a file to hand to `readImageSize`. */
export const HEAD_BYTES = 128 * 1024;

export type ImageSize = {
  width: number;
  height: number;
  /**
   * Which way round it is.
   *
   * A separate field rather than something the stylesheet derives, because CSS
   * cannot branch on an image's intrinsic aspect ratio — there is no selector
   * for it, at any level. The orientation has to arrive as an attribute or the
   * two caps cannot exist.
   */
  orientation: "landscape" | "portrait" | "square";
};

function orientationOf(width: number, height: number): ImageSize["orientation"] {
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

function size(width: number, height: number): ImageSize | null {
  // A zero or a negative is a malformed header, not a picture. Returning null
  // rather than clamping keeps "we do not know" distinct from "it is 1px wide".
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;

  return { width, height, orientation: orientationOf(width, height) };
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function u32be(bytes: Uint8Array, at: number): number {
  // `>>> 0` because a PNG dimension can set the high bit and `<<` is signed.
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function u16le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[at + index]!);
  return out;
}

/** PNG — IHDR is always the first chunk, so width and height are at 16 and 20. */
function readPng(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (bytes.length < 24) return null;

  return size(u32be(bytes, 16), u32be(bytes, 20));
}

/** GIF — a fixed header, little-endian, and unchanged since 1989. */
function readGif(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return null;
  if (bytes.length < 10) return null;

  return size(u16le(bytes, 6), u16le(bytes, 8));
}

/**
 * WebP — three encodings under one RIFF container, and they disagree about
 * where the dimensions live.
 *
 * `VP8 ` (lossy) hides them behind a 3-byte start code in the frame header;
 * `VP8L` (lossless) packs 14 bits each into a 32-bit little-endian field;
 * `VP8X` (extended — animation, alpha) states them as two 24-bit values, minus
 * one. All three are `-1` encoded, hence the `+ 1`s.
 */
function readWebp(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return null; // "RIFF"
  if (ascii(bytes, 8, 4) !== "WEBP") return null;
  if (bytes.length < 30) return null;

  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X") {
    return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }

  if (chunk === "VP8L") {
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return size((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1);
  }

  if (chunk === "VP8 ") {
    // 0x9d 0x01 0x2a is the key frame start code; the dimensions follow it.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }

  return null;
}

/**
 * JPEG — the only one that has to be walked.
 *
 * A JPEG is a chain of markers: `0xFF`, a kind, a big-endian length, a payload.
 * The dimensions are in whichever `SOF` marker the encoder used, and everything
 * before it — EXIF, a thumbnail, an ICC profile, a comment — is skipped by its
 * own declared length.
 *
 * ⚠️ `SOF0` THROUGH `SOF15`, MINUS FOUR. `0xC4`, `0xC8` and `0xCC` sit inside
 * that range and are not frame headers (Huffman table, an extension, arithmetic
 * coding table); reading one as a `SOF` yields two bytes of a Huffman table as
 * an image size. A progressive JPEG is `SOF2`, which is why this cannot simply
 * look for `SOF0`.
 */
function readJpeg(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;

  let at = 2;

  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      // Padding between markers is legal and is always 0xFF; anything else here
      // means the stream is not what it claimed and walking further is guessing.
      at += 1;
      continue;
    }

    const marker = bytes[at + 1]!;

    // Standalone markers: no length, nothing to skip.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }

    // Start of scan — the compressed data begins and there is no header left to
    // find. Stop rather than walk megabytes of entropy-coded bytes.
    if (marker === 0xda) return null;

    const length = u16be(bytes, at + 2);
    if (length < 2) return null;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      // …FF, kind, length(2), precision(1), height(2), width(2)
      return size(u16be(bytes, at + 7), u16be(bytes, at + 5));
    }

    at += 2 + length;
  }

  return null;
}

/**
 * The dimensions of a PNG, JPEG, GIF or WebP, or null for anything else and for
 * a head too short to hold the answer.
 *
 * The four formats are exactly the four `uploadCommentImage` accepts. Keep them
 * in step: a fifth accepted type that this cannot measure is an image with no
 * orientation, which renders at the fallback cap and looks like a bug.
 */
export function readImageSize(head: Uint8Array): ImageSize | null {
  return readPng(head) ?? readJpeg(head) ?? readGif(head) ?? readWebp(head);
}
