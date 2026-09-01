import { z } from "zod";

import { richTextLength } from "@/lib/rich-text";

/**
 * P7-56 — a zod field for one of the six rich-text columns.
 *
 * ⚠️ EVERY LENGTH RULE IN THIS APP WAS WRITTEN ABOUT PROSE. `<p><strong>ok</strong></p>`
 * is 26 characters of markup and 2 of what somebody typed, so a plain
 * `.min(5).max(2000)` on a rich column does two wrong things at once: it accepts
 * an empty document as five characters of "explanation", and it cuts a
 * 2000-character cap to a few hundred real ones. Both failures are silent.
 *
 * So the rule is measured on the FLATTENED text while the markup is what gets
 * stored. `richTextLength` is the same flattener the emails and the list
 * previews use, which is what stops "too long" here disagreeing with what a
 * client actually receives.
 *
 * ⚠️ THIS DOES NOT SANITISE. It cannot — it runs on the client too. The action
 * sanitises on write and `<RichText>` sanitises on render; this only decides
 * whether there is enough of it.
 */
export function richTextSchema({
  min = 0,
  max,
  requiredMessage,
  tooLongMessage,
}: {
  min?: number;
  max: number;
  requiredMessage?: string;
  tooLongMessage?: string;
}) {
  return z
    .string()
    .trim()
    .refine((value) => richTextLength(value) >= min, {
      message:
        requiredMessage ??
        (min <= 1 ? "This is required." : `Say a little more — at least ${min} characters.`),
    })
    .refine((value) => richTextLength(value) <= max, {
      message: tooLongMessage ?? `Keep it under ${max.toLocaleString("en-US")} characters.`,
    })
    /*
     * An empty document is stored as the EMPTY STRING, never as `<p></p>`.
     *
     * Optional fields all treat `""` as "nothing here" — `|| null` in the
     * actions, `.default("")` in the schemas — and seven characters of empty
     * markup would sail past every one of those checks and be written to the
     * column as content.
     */
    .transform((value) => (richTextLength(value) === 0 ? "" : value));
}
