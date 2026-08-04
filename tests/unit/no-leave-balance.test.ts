import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PHASE 5 EXIT CRITERION — "No leave-balance logic exists anywhere in the
 * codebase."
 *
 * Unusual as a test, and deliberately so. This is the single easiest place in
 * the build for scope to explode: accrual rules, carry-over, pro-rating and
 * holiday entitlement are a project of their own, and every one of them looks
 * like a small addition on the day somebody adds it.
 *
 * Amier waved it off explicitly (22:40): HR counts manually for now — "ang
 * mahalaga lang, may record". This test keeps it waved off by failing the build
 * rather than relying on somebody remembering the decision a year from now.
 *
 * TWO DESIGN CHOICES MAKE IT SURVIVABLE, and both were learned by getting it
 * wrong on the first attempt:
 *
 *   1. It scans CODE, not prose — comments and string literals are stripped
 *      first. The first version failed on the comments in this very repo that
 *      exist to say leave balances are out of scope, which is absurd.
 *   2. It matches IDENTIFIERS (`leave_balance`, `leaveBalance`), not English
 *      ("accrual", "carry over"). Those words appear in ordinary prose —
 *      `lib/attachments-server.ts` says "carry over" about something unrelated
 *      — and a guard that cries wolf gets deleted rather than heeded.
 *
 * If leave balances are ever genuinely scoped, DELETE THIS FILE as part of that
 * work. Deleting it is a deliberate act with a commit message; quietly adding a
 * balance column is not.
 */

const ROOTS = ["app", "lib", "supabase/migrations", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".sql", ".mjs"];

/** Identifier shapes only — a column, field or variable modelling entitlement. */
const FORBIDDEN = [
  /\bleave_balances?\b/i,
  /\bleaveBalances?\b/,
  /\bleave_credits?\b/i,
  /\bleaveCredits?\b/,
  /\bleave_entitlements?\b/i,
  /\bleaveEntitlements?\b/,
  /\bleave_days_remaining\b/i,
  /\bleaveDaysRemaining\b/,
  /\bleave_accrual\b/i,
  /\bleaveAccrual\b/,
];

/**
 * Strip comments and string literals so only executable code is searched.
 *
 * Crude — it does not parse — but the failure mode is the safe one: an odd
 * quote makes it strip too much and MISS something, which a reviewer catches,
 * rather than strip too little and block a build over a sentence.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block */
    .replace(/^\s*--.*$/gm, " ") // -- sql line
    .replace(/\/\/.*$/gm, " ") // // ts line
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function walk(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (EXTENSIONS.some((extension) => path.endsWith(extension))) found.push(path);
  }
  return found;
}

describe("Phase 5 exit criterion — leave balances stay out of scope", () => {
  it("models no leave balance, credit or entitlement in app, lib, migrations or scripts", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const code = codeOnly(readFileSync(file, "utf8"));
        for (const pattern of FORBIDDEN) {
          const match = pattern.exec(code);
          if (match) offenders.push(`${file.replaceAll("\\", "/")} — "${match[0]}"`);
        }
      }
    }

    expect(
      offenders,
      "Leave balances are out of scope (docs/09, Amier 22:40). HR counts manually; the app only " +
        "keeps the record. If this is now genuinely in scope, delete " +
        "tests/unit/no-leave-balance.test.ts as an explicit part of that work.\n\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("actually detects a violation, so a green result means something", () => {
    // A guard nobody has seen fail is a guard that might match nothing at all.
    // This proves the patterns fire on the shape they are meant to catch.
    const sample = codeOnly("alter table x add column leave_balance integer;");
    expect(FORBIDDEN.some((pattern) => pattern.test(sample))).toBe(true);

    // ...and that prose about the exclusion does not trip it.
    const prose = codeOnly("-- Leave balances are deliberately out of scope. No accrual.");
    expect(FORBIDDEN.some((pattern) => pattern.test(prose))).toBe(false);
  });
});
