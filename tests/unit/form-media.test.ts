import { describe, expect, it } from "vitest";

import {
  isDisplayOnly,
  isMedia,
  safeImageUrl,
  youtubeEmbedUrl,
  youtubeVideoId,
} from "@/lib/form-builder/canvas";
import { responseColumns } from "@/lib/form-builder/responses";
import type { FormSchema } from "@/lib/form-builder/builder";
import { buildFieldSchema, type PublicFormField } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 9 — AN IMAGE AND A YOUTUBE VIDEO, BOTH SHOWN AND NEITHER ANSWERED.
 *
 * Two risks, and the tests are shaped around them.
 *
 * THE FIRST IS THE ONE SECTIONS ALREADY TAUGHT: a row in
 * `vizserve_pms_form_fields` that never appears in `field_values` breaks
 * everything assuming ONE ROW MEANS ONE ANSWER. `isDisplayOnly` is the single
 * set those places consult, so the test that matters is that these types are
 * IN it — a new display type added to `FIELD_TYPES` and forgotten here would
 * grow a phantom CSV column and refuse submissions.
 *
 * THE SECOND IS NEW AND IS A SECURITY ONE. The URL comes from whoever built the
 * form and ends up in an `img src` and an `iframe src`. `javascript:` and
 * `data:` are both strings that look like links, and an author on a client form
 * is a team leader — trusted, but not trusted to be the last line. Neither
 * helper is a validator that warns; both RETURN NULL, and the components draw a
 * note instead of a frame.
 */

function field(overrides: Partial<PublicFormField> & { field_key: string }): PublicFormField {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    label: overrides.field_key,
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    ...overrides,
  };
}

describe("the display-only set", () => {
  it("holds every type that shows something", () => {
    // The one assertion that stops a phantom column, a phantom CSV heading and a
    // submission refused against a picture. Everything downstream reads this.
    expect(isDisplayOnly("section")).toBe(true);
    expect(isDisplayOnly("image")).toBe(true);
    expect(isDisplayOnly("youtube")).toBe(true);
  });

  it("holds nothing that collects an answer", () => {
    for (const type of ["text", "textarea", "date", "select", "multiselect", "file", "email", "number"]) {
      expect(isDisplayOnly(type)).toBe(false);
    }
  });

  it("separates the two that carry a URL from the one that does not", () => {
    // A page break has no `options[0]`; the media constraint must not reach it.
    expect(isMedia("section")).toBe(false);
    expect(isMedia("image")).toBe(true);
    expect(isMedia("youtube")).toBe(true);
  });
});

describe("buildFieldSchema · media demands nothing", () => {
  for (const type of ["image", "youtube"] as const) {
    it(`${type} accepts absence, a blank and nonsense`, () => {
      const schema = buildFieldSchema(field({ field_key: "clip", field_type: type }));

      expect(schema.safeParse(undefined).success).toBe(true);
      expect(schema.safeParse("").success).toBe(true);
      expect(schema.safeParse({ unexpected: true }).success).toBe(true);
    });

    it(`${type} demands nothing even when the row says required`, () => {
      /*
       * `vizserve_pms_form_fields_media_asks_nothing` refuses that row, but the
       * schema must not depend on the constraint being enforced: a hand-edited
       * row reaching a browser should render a picture, not lock the form.
       */
      const schema = buildFieldSchema(
        field({ field_key: "clip", field_type: type, is_required: true }),
      );

      expect(schema.safeParse(undefined).success).toBe(true);
    });
  }
});

function schemaOf(
  fields: Array<{ id: string; type: string; key: string; label: string }>,
): FormSchema {
  return {
    root: fields.map((f) => f.id),
    entities: Object.fromEntries(
      fields.map((f) => [
        f.id,
        {
          type: f.type,
          attributes: {
            key: f.key,
            label: f.label,
            helpText: "",
            required: false,
            options: [],
            archived: false,
          },
        },
      ]),
    ),
  } as unknown as FormSchema;
}

describe("responseColumns · media is not a column", () => {
  it("omits an image and a video, and keeps every question", () => {
    const schema = schemaOf([
      { id: "a", type: "image", key: "team_photo", label: "Team photo" },
      { id: "b", type: "text", key: "full_name", label: "Full name" },
      { id: "c", type: "youtube", key: "briefing", label: "Briefing" },
      { id: "d", type: "textarea", key: "notes", label: "Notes" },
    ]);

    expect(responseColumns(schema, []).map((column) => column.key)).toEqual([
      "full_name",
      "notes",
    ]);
  });

  it("does not claim a key a question shares with an image", () => {
    /*
     * The data-losing one, same as the section case. An image described "Team
     * photo" and a question asking "Team photo" derive the same key; claiming it
     * for the image would suppress the question's column and drop its answers
     * from the table AND the export with nothing saying so.
     */
    const schema = schemaOf([
      { id: "a", type: "image", key: "team_photo", label: "Team photo" },
      { id: "b", type: "text", key: "team_photo", label: "Team photo" },
    ]);

    const columns = responseColumns(schema, ["team_photo"]);

    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ key: "team_photo", origin: "active" });
  });
});

describe("youtubeVideoId", () => {
  const ID = "dQw4w9WgXcQ";

  it.each([
    ["a watch page", `https://www.youtube.com/watch?v=${ID}`],
    ["no www", `https://youtube.com/watch?v=${ID}`],
    ["mobile", `https://m.youtube.com/watch?v=${ID}`],
    ["a short link", `https://youtu.be/${ID}`],
    ["a shorts link", `https://www.youtube.com/shorts/${ID}`],
    ["an embed link already", `https://www.youtube.com/embed/${ID}`],
    ["the no-cookie host", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["extra query parameters", `https://www.youtube.com/watch?v=${ID}&list=PL123&t=42s`],
    ["a timestamp on a short link", `https://youtu.be/${ID}?t=42`],
    ["surrounding whitespace", `   https://youtu.be/${ID}   `],
    ["http rather than https", `http://youtu.be/${ID}`],
  ])("reads %s", (_name, input) => {
    expect(youtubeVideoId(input)).toBe(ID);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["not a URL at all", "dQw4w9WgXcQ"],
    ["a bare host with no scheme", "youtube.com/watch?v=dQw4w9WgXcQ"],
    ["another video site", "https://vimeo.com/123456789"],
    ["a YouTube page that is not a video", "https://www.youtube.com/results?search_query=cats"],
    ["a channel", "https://www.youtube.com/@someone"],
    ["an id of the wrong length", "https://youtu.be/tooshort"],
    ["an id with an illegal character", "https://youtu.be/dQw4w9WgXc!"],
  ])("refuses %s", (_name, input) => {
    expect(youtubeVideoId(input)).toBeNull();
  });

  it("refuses a javascript: URL whose path looks like an id", () => {
    /*
     * ⚠️ THE ONE THAT MATTERS. The scheme is checked BEFORE the host and path,
     * because a `javascript:` URL has both and would otherwise be matched by the
     * same string handling — and the result goes straight into an `iframe src`.
     */
    expect(youtubeVideoId("javascript:／／youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(youtubeVideoId("javascript:alert(1)")).toBeNull();
    expect(youtubeVideoId("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("builds the embed URL from a fixed prefix rather than the input", () => {
    // Nothing survives from what was pasted except eleven matched characters, so
    // no query, host or scheme from the input can reach the frame.
    expect(youtubeEmbedUrl(`https://www.youtube.com/watch?v=${ID}&list=EVIL`)).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}`,
    );
  });

  it("returns null from the embed helper when the id is not readable", () => {
    expect(youtubeEmbedUrl("https://vimeo.com/1")).toBeNull();
  });
});

describe("safeImageUrl", () => {
  it("accepts http and https", () => {
    expect(safeImageUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
    expect(safeImageUrl("http://example.com/a.jpg")).toBe("http://example.com/a.jpg");
  });

  it("accepts an extensionless path", () => {
    // No extension check on purpose: plenty of legitimate hosts serve images
    // from extensionless paths, and the editor's own preview answers the
    // question better than a regex would.
    expect(safeImageUrl("https://images.example.com/photo")).toBe(
      "https://images.example.com/photo",
    );
  });

  it("refuses javascript: and data:", () => {
    // `data:` is excluded as well as `javascript:` — it executes nothing, but it
    // lets a form carry an arbitrary inline payload in a row anybody can read.
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
  });

  it("refuses a blank and a non-URL", () => {
    expect(safeImageUrl("")).toBeNull();
    expect(safeImageUrl("   ")).toBeNull();
    expect(safeImageUrl("example.com/a.jpg")).toBeNull();
  });
});
