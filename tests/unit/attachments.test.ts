import { describe, expect, it } from "vitest";

import { formatBytes, safeStorageName, sniffMatchesDeclaredType } from "@/lib/attachments";

/**
 * P1-09 — file identification.
 *
 * `sniffMatchesDeclaredType` is what closes the trivial rename. A browser sets
 * `File.type` from the extension, so payload.exe renamed to brief.pdf arrives
 * declaring application/pdf, and every check that reads only the declared type
 * waves it through.
 */

/** Builds a head buffer from a signature, padded to a realistic length. */
function head(...bytes: number[]): Uint8Array {
  const buffer = new Uint8Array(64);
  buffer.set(bytes, 0);
  // Pad with printable filler rather than zeros, so the text-file NUL check is
  // not accidentally satisfied by the padding itself.
  buffer.fill(0x41, bytes.length);
  return buffer;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MZ = [0x4d, 0x5a, 0x90, 0x00]; // A Windows executable.

describe("sniffMatchesDeclaredType", () => {
  it("accepts a genuine PNG declaring image/png", () => {
    expect(sniffMatchesDeclaredType(head(...PNG), "image/png").ok).toBe(true);
  });

  it("accepts a genuine JPEG, PDF and OpenXML document", () => {
    expect(sniffMatchesDeclaredType(head(...JPEG), "image/jpeg").ok).toBe(true);
    expect(sniffMatchesDeclaredType(head(...PDF), "application/pdf").ok).toBe(true);
    expect(
      sniffMatchesDeclaredType(
        head(...ZIP),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ).ok,
    ).toBe(true);
  });

  it("accepts a legacy .doc, which is an OLE2 container", () => {
    expect(sniffMatchesDeclaredType(head(...OLE2), "application/msword").ok).toBe(true);
  });

  it("REJECTS an executable renamed to .pdf", () => {
    // The attack this function exists for. The declared type says PDF; the bytes
    // say MZ.
    const result = sniffMatchesDeclaredType(head(...MZ), "application/pdf");
    expect(result.ok).toBe(false);
  });

  it("rejects a PNG declaring itself a PDF", () => {
    expect(sniffMatchesDeclaredType(head(...PNG), "application/pdf").ok).toBe(false);
  });

  it("rejects a WEBP that is only half a WEBP", () => {
    // RIFF alone is also AVI and WAV. The WEBP marker at offset 8 is what makes
    // it a WEBP, so checking the prefix alone is not enough.
    const riffOnly = head(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20);
    expect(sniffMatchesDeclaredType(riffOnly, "image/webp").ok).toBe(false);
  });

  it("accepts a real WEBP", () => {
    const webp = head(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(sniffMatchesDeclaredType(webp, "image/webp").ok).toBe(true);
  });

  it("accepts plain text and rejects a binary claiming to be text", () => {
    // Text has no magic number, so the rule is inverted: no plain text file
    // contains a NUL byte, and essentially every binary does.
    const text = new TextEncoder().encode("Hello, this is a brief.");
    expect(sniffMatchesDeclaredType(text, "text/plain").ok).toBe(true);

    const binary = new Uint8Array([0x48, 0x00, 0x49]);
    expect(sniffMatchesDeclaredType(binary, "text/plain").ok).toBe(false);
  });

  it("refuses a type it has no signature for, rather than defaulting to allow", () => {
    // A type that reaches the allowlist without a signature entry is a gap in
    // the table — not permission to skip the check.
    expect(sniffMatchesDeclaredType(head(...PNG), "application/x-mystery").ok).toBe(false);
  });

  it("refuses a truncated file rather than reading past the end", () => {
    expect(sniffMatchesDeclaredType(new Uint8Array([0x89, 0x50]), "image/png").ok).toBe(false);
  });
});

describe("safeStorageName", () => {
  it("strips a directory traversal attempt", () => {
    expect(safeStorageName("../../../etc/passwd")).toBe("passwd");
    expect(safeStorageName("..\\..\\windows\\system32\\config")).toBe("config");
  });

  it("keeps an ordinary name readable", () => {
    expect(safeStorageName("Q3 Campaign Brief.pdf")).toBe("Q3-Campaign-Brief.pdf");
  });

  it("collapses characters that have meaning in a URL or a path", () => {
    expect(safeStorageName("a b?c#d&e.png")).toBe("a-b-c-d-e.png");
  });

  it("never returns an empty name", () => {
    expect(safeStorageName("???")).toBe("file");
    expect(safeStorageName("   ")).toBe("file");
  });

  it("caps the length so a 500-character name cannot break the path", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const result = safeStorageName(long);
    expect(result.length).toBeLessThanOrEqual(75);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("handles a dotfile without producing a bare extension", () => {
    expect(safeStorageName(".env")).toBe("env");
  });
});

describe("formatBytes", () => {
  it("reads naturally at each scale", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
});

/**
 * P8-12 — the audio types the reminder sound accepts.
 *
 * ⚠️ A SEPARATE ALLOWLIST FROM THE ONE ABOVE, going into a separate bucket.
 * `vizserve_pms_attachment_rules` never admits audio, and
 * `ALLOWED_SOUND_MIME_TYPES` never admits documents — because the first is read
 * by the PUBLIC client form and the second is not. One sniffer serves both,
 * because "does the content match the claim" is the same question either way,
 * which is exactly why these cases belong beside the ones above.
 */

const MP3_ID3 = [0x49, 0x44, 0x33, 0x04]; // "ID3" — a tagged file.
const MP3_SYNC = [0xff, 0xfb, 0x90, 0x00]; // A tagless frame sync.
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WAVE = [0x57, 0x41, 0x56, 0x45];
const OGG = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const WEBM = [0x1a, 0x45, 0xdf, 0xa3]; // EBML
const MP4 = [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]; // size, then "ftyp"

/** RIFF containers put their tag at byte 8, past a four-byte length. */
function riff(tag: number[]): Uint8Array {
  const buffer = new Uint8Array(64).fill(0x41);
  buffer.set(RIFF, 0);
  buffer.set([0x24, 0x00, 0x00, 0x00], 4);
  buffer.set(tag, 8);
  return buffer;
}

describe("sniffMatchesDeclaredType — audio (P8-12)", () => {
  /**
   * BOTH LEGAL BEGINNINGS. A file with metadata starts with an ID3 tag; one
   * without starts straight in on an MPEG frame sync. Accepting only the first
   * would reject perfectly ordinary tagless exports, and only the second would
   * reject almost every file anybody actually has.
   */
  it("accepts an MP3 with an ID3 tag and one without", () => {
    expect(sniffMatchesDeclaredType(head(...MP3_ID3), "audio/mpeg").ok).toBe(true);
    expect(sniffMatchesDeclaredType(head(...MP3_SYNC), "audio/mpeg").ok).toBe(true);
  });

  /**
   * Browsers disagree about the spelling of the same file — Chrome says
   * `audio/wav` where Safari says `audio/x-wav`, and `audio/mp3` still turns up
   * beside the correct `audio/mpeg`. Refusing the unfashionable spelling would
   * reject a valid file for a reason nobody could act on.
   */
  it("accepts both spellings browsers actually send", () => {
    expect(sniffMatchesDeclaredType(head(...MP3_ID3), "audio/mp3").ok).toBe(true);
    expect(sniffMatchesDeclaredType(riff(WAVE), "audio/wav").ok).toBe(true);
    expect(sniffMatchesDeclaredType(riff(WAVE), "audio/x-wav").ok).toBe(true);
  });

  it("accepts OGG, WebM and M4A", () => {
    expect(sniffMatchesDeclaredType(head(...OGG), "audio/ogg").ok).toBe(true);
    expect(sniffMatchesDeclaredType(head(...WEBM), "audio/webm").ok).toBe(true);
    expect(sniffMatchesDeclaredType(head(...MP4), "audio/mp4").ok).toBe(true);
  });

  /** The whole point: an executable renamed to chime.mp3. */
  it("refuses an executable declaring itself audio", () => {
    expect(sniffMatchesDeclaredType(head(...MZ), "audio/mpeg").ok).toBe(false);
    expect(sniffMatchesDeclaredType(head(...MZ), "audio/wav").ok).toBe(false);
    expect(sniffMatchesDeclaredType(head(...MZ), "audio/ogg").ok).toBe(false);
  });

  /**
   * ⚠️ RIFF IS NOT ENOUGH. A WEBP and a WAV share the first eight bytes and
   * differ only at byte 8, so a check that stopped at "RIFF" would let an image
   * through as audio and vice versa — which is why `isRiff` takes the tag.
   */
  it("does not confuse the two RIFF containers", () => {
    expect(sniffMatchesDeclaredType(riff([0x57, 0x45, 0x42, 0x50]), "audio/wav").ok).toBe(false);
    expect(sniffMatchesDeclaredType(riff(WAVE), "image/webp").ok).toBe(false);
  });

  /** And the reverse direction: audio must not pass as a document. */
  it("refuses audio declaring itself a document", () => {
    expect(sniffMatchesDeclaredType(head(...MP3_ID3), "application/pdf").ok).toBe(false);
    expect(sniffMatchesDeclaredType(head(...OGG), "image/png").ok).toBe(false);
  });
});
