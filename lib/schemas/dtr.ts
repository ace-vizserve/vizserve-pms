import { z } from "zod";

/**
 * PHASE 5 CONTRACT — the punch payload (D3a, R11).
 *
 * Deliberately tiny, and that is the design. The client sends a DIRECTION and,
 * for a time-out only, which work date it attaches to. It never sends a time:
 * the server timestamp is the punch (Q4), which is what stops a clock-skewed
 * laptop — or a crafted request — from writing a favourable time.
 */

export const PUNCH_DIRECTIONS = ["in", "out"] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const punchSchema = z.discriminatedUnion("direction", [
  /**
   * No `work_date` member at all, rather than an optional one. Time-in always
   * attaches to today, and a field that cannot be sent is a rule that cannot be
   * bent — the migration raises if a date arrives here anyway.
   */
  z.object({ direction: z.literal("in") }),
  z.object({
    direction: z.literal("out"),
    /** Today, or yesterday when yesterday's shift is still open. Null = today. */
    work_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")
      .nullish(),
  }),
]);

export type PunchInput = z.infer<typeof punchSchema>;

/** What `vizserve_pms_punch` returns. `captured` is false for an ignored punch. */
export const punchResultSchema = z.object({
  ok: z.literal(true),
  captured: z.boolean(),
  message: z.string(),
  work_date: z.string(),
  time_in: z.string().nullable(),
  time_out: z.string().nullable(),
});

export type PunchResult = z.infer<typeof punchResultSchema>;

/**
 * The payroll export range (P5-11).
 *
 * Bounded at 92 days — a quarter. The export streams every row in range for
 * every person in scope, and an unbounded range is how a payroll click becomes
 * a timeout at month end.
 */
export const dtrExportSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date."),
    user_id: z.uuid().nullish(),
  })
  .refine((value) => value.to >= value.from, {
    message: "The end date cannot be before the start date.",
    path: ["to"],
  })
  .refine(
    (value) => {
      const from = Date.parse(`${value.from}T12:00:00Z`);
      const to = Date.parse(`${value.to}T12:00:00Z`);
      return (to - from) / 86_400_000 <= 92;
    },
    { message: "Export at most a quarter at a time.", path: ["to"] },
  );

export type DtrExportInput = z.infer<typeof dtrExportSchema>;
