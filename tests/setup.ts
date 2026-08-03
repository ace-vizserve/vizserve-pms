import { readFileSync } from "node:fs";

/**
 * Loads `.env.local` / `.env` into `process.env` before any test runs.
 *
 * Next loads these itself at dev/build time; vitest does not. Without this the
 * db suite would skip on a machine that is perfectly well configured, which is
 * the failure mode worth avoiding — a security suite that quietly stops running
 * is indistinguishable from one that passes.
 *
 * Existing environment variables win, so CI can override a checked-out file.
 */
for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent file is the normal case in CI.
  }
}
