import { describe, expect, it } from "vitest";

import { HEAD_BYTES, readImageSize } from "@/lib/image-size";

/**
 * P7-67 — the dimension reader.
 *
 * ⚠️ THE FIXTURES ARE BUILT, NOT PASTED. Every one below is assembled byte by
 * byte from the format's own specification, so a test that passes says the
 * parser reads the header the spec describes — not that it reads the one
 * header somebody happened to paste in as base64 five years ago. It also keeps
 * the intent legible: `ihdr(2560, 1440)` says what it is testing, and a 400
 * character blob does not.
 *
 * What is NOT covered here: anything requiring a real encoder. There is no
 * dependency that produces a JPEG in this repo and adding one to test eighty
 * lines would be the trade §2 of the design system warns about.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function be32(value: number): Uint8Array {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function be16(value: number): Uint8Array {
  return bytes((value >>> 8) & 0xff, value & 0xff);
}

function le16(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff);
}

function le24(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
}

const PNG_MAGIC = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A PNG head: magic, the IHDR chunk length and type, then width and height. */
function png(width: number, height: number): Uint8Array {
  return concat(
    PNG_MAGIC,
    be32(13),
    bytes(0x49, 0x48, 0x44, 0x52), // "IHDR"
    be32(width),
    be32(height),
    bytes(8, 6, 0, 0, 0), // bit depth, colour type, compression, filter, interlace
  );
}

/** A GIF head — fixed, little-endian, and the same since 1989. */
function gif(width: number, height: number): Uint8Array {
  return concat(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), le16(width), le16(height), bytes(0, 0, 0));
}

/**
 * A JPEG: SOI, then any number of skippable segments, then a frame header.
 * `before` is what the parser has to walk past — an EXIF block, a thumbnail, a
 * comment — which is the only interesting part of reading a JPEG.
 */
function jpeg(
  width: number,
  height: number,
  { marker = 0xc0, before = [] as Uint8Array[] } = {},
): Uint8Array {
  return concat(
    bytes(0xff, 0xd8), // SOI
    ...before,
    bytes(0xff, marker),
    be16(11), // segment length: 2 + 1 + 2 + 2 + 4 component bytes
    bytes(8), // sample precision
    be16(height),
    be16(width),
    bytes(1, 0x11, 0x00, 0x00),
  );
}

/** One skippable APPn segment of `size` payload bytes. */
function appSegment(size: number, marker = 0xe1): Uint8Array {
  return concat(bytes(0xff, marker), be16(size + 2), new Uint8Array(size));
}

function riff(chunk: string, body: Uint8Array): Uint8Array {
  const tag = Uint8Array.from([...chunk].map((character) => character.charCodeAt(0)));
  return concat(
    bytes(0x52, 0x49, 0x46, 0x46), // "RIFF"
    be32(body.length + 12),
    Uint8Array.from([..."WEBP"].map((character) => character.charCodeAt(0))),
    tag,
    be32(body.length),
    body,
  );
}

describe("readImageSize — PNG", () => {
  it("reads a landscape screenshot", () => {
    expect(readImageSize(png(2560, 1440))).toEqual({
      width: 2560,
      height: 1440,
      orientation: "landscape",
    });
  });

  it("reads a portrait phone capture", () => {
    expect(readImageSize(png(1170, 2532))?.orientation).toBe("portrait");
  });

  it("calls equal sides square", () => {
    expect(readImageSize(png(512, 512))?.orientation).toBe("square");
  });

  it("survives a dimension with the high bit set", () => {
    // ⚠️ `<<` IS SIGNED IN JS. Without the `>>> 0` in the reader this returns a
    // negative width and the image is reported as portrait.
    const wide = 0x80000001;
    expect(readImageSize(png(wide, 10))?.width).toBe(wide);
  });

  it("returns null for a truncated header", () => {
    expect(readImageSize(PNG_MAGIC)).toBeNull();
  });

  it("returns null for a zero dimension", () => {
    expect(readImageSize(png(0, 100))).toBeNull();
  });
});

describe("readImageSize — JPEG", () => {
  it("reads a baseline frame header", () => {
    expect(readImageSize(jpeg(4032, 3024))).toEqual({
      width: 4032,
      height: 3024,
      orientation: "landscape",
    });
  });

  it("walks past an EXIF block to find it", () => {
    // The whole reason a JPEG cannot be read at a fixed offset: a phone photo
    // puts kilobytes of EXIF and a thumbnail in front of the frame header.
    const head = jpeg(1920, 1080, { before: [appSegment(60000), appSegment(2000, 0xe0)] });
    expect(readImageSize(head)?.width).toBe(1920);
  });

  it("reads a progressive frame, which is SOF2 rather than SOF0", () => {
    expect(readImageSize(jpeg(800, 600, { marker: 0xc2 }))?.width).toBe(800);
  });

  it("does not mistake a Huffman table for a frame header", () => {
    // ⚠️ 0xC4 SITS INSIDE THE SOF RANGE AND IS NOT ONE. Reading it as a frame
    // header returns two bytes of a Huffman table as an image size — a wrong
    // answer, which is worse than no answer.
    const table = concat(bytes(0xff, 0xc4), be16(6), bytes(0x11, 0x22, 0x33, 0x44));
    expect(readImageSize(jpeg(640, 480, { before: [table] }))?.width).toBe(640);
  });

  it("gives up at the start of scan rather than walking the pixels", () => {
    const sos = concat(bytes(0xff, 0xda), be16(8), new Uint8Array(6));
    const head = concat(bytes(0xff, 0xd8), sos, new Uint8Array(200));
    expect(readImageSize(head)).toBeNull();
  });

  it("returns null when the frame header is past the head it was given", () => {
    // The documented fallback: no dimensions, no orientation, the image takes
    // the default cap. Never a failed upload.
    const head = jpeg(1000, 800, { before: [appSegment(HEAD_BYTES)] }).slice(0, HEAD_BYTES);
    expect(readImageSize(head)).toBeNull();
  });
});

describe("readImageSize — GIF and WebP", () => {
  it("reads a GIF", () => {
    expect(readImageSize(gif(300, 200))).toEqual({
      width: 300,
      height: 200,
      orientation: "landscape",
    });
  });

  it("reads an extended WebP, whose dimensions are stored minus one", () => {
    // One flags byte and three reserved, then the two 24-bit values.
    const body = concat(bytes(0, 0, 0, 0), le24(1919), le24(1079));
    expect(readImageSize(riff("VP8X", body))).toEqual({
      width: 1920,
      height: 1080,
      orientation: "landscape",
    });
  });

  it("reads a lossless WebP, whose dimensions are 14 bits each in one word", () => {
    const width = 640;
    const height = 480;
    const packed = (width - 1) | ((height - 1) << 14);
    const body = concat(
      bytes(0x2f), // the VP8L signature byte
      bytes(packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, (packed >>> 24) & 0xff),
      new Uint8Array(20),
    );
    expect(readImageSize(riff("VP8L", body))).toMatchObject({ width, height });
  });

  it("reads a lossy WebP behind its key frame start code", () => {
    const body = concat(
      new Uint8Array(3), // frame tag
      bytes(0x9d, 0x01, 0x2a), // start code
      le16(1024),
      le16(768),
      new Uint8Array(10),
    );
    expect(readImageSize(riff("VP8 ", body))).toMatchObject({ width: 1024, height: 768 });
  });
});

describe("readImageSize — anything else", () => {
  it("returns null rather than guessing", () => {
    for (const head of [
      new Uint8Array(0),
      bytes(0x25, 0x50, 0x44, 0x46, 0x2d), // "%PDF-"
      bytes(0x50, 0x4b, 0x03, 0x04), // a zip, which is every Office file
      Uint8Array.from([..."<svg xmlns="].map((character) => character.charCodeAt(0))),
      new Uint8Array(64).fill(0xff),
    ]) {
      expect(readImageSize(head)).toBeNull();
    }
  });
});
