import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * P0-12 — test runner configuration.
 *
 * Two kinds of test live in `tests/`, and the split is deliberate:
 *
 *   unit/  pure functions. No database, no network. Always run, everywhere,
 *          including CI with no secrets.
 *   db/    the scope suite. Talks to a real Supabase over the wire as four
 *          different signed-in users, because RLS cannot be unit tested — a
 *          policy is only true against a live `auth.uid()`.
 *
 * The db suite SKIPS rather than fails when credentials are absent, so
 * `npm run verify` stays useful on a machine with no `.env.local`. It prints why
 * it skipped: a silently-skipped security suite is worse than no suite, since it
 * reports green while asserting nothing.
 *
 * `environment: node` — there are no component tests yet. When Kurt adds them,
 * give them their own project entry with `jsdom` rather than making every server
 * test pay for a DOM.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` is a Next build-time marker: it has no runtime module, it
      // exists so that importing a server file from a client component fails the
      // build. Vitest has no such bundler step, so it must be stubbed or every
      // test that touches lib/auth/authorization.ts dies on the import.
      //
      // Stubbing it here does NOT weaken the guarantee — the guarantee is
      // enforced by `next build`, which still runs in `npm run verify`.
      //
      // fileURLToPath, not `.pathname` — on Windows the latter yields
      // "/C:/Users/..." with a leading slash, which resolves to nothing.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // The db suite signs in over the network, several times, per file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // RLS tests share seeded rows. Running files in parallel against one remote
    // project produces failures that look like policy bugs and are not.
    fileParallelism: false,
  },
});
