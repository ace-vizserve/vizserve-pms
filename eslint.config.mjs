import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // The Gantt is a vendored registry component (Kibo UI) and brings its own
  // dependencies. CLAUDE.md bans date libraries in favour of lib/dates.ts, so
  // those deps are fenced into components/kibo-ui/** and converted at the
  // boundary. This rule is what keeps the fence honest.
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts}"],
    ignores: ["components/kibo-ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "date-fns",
              message:
                "No date library outside components/kibo-ui/** — use lib/dates.ts (CLAUDE.md).",
            },
            {
              name: "jotai",
              message:
                "jotai exists only for the vendored Gantt in components/kibo-ui/**. Use React state or the existing server-action patterns.",
            },
            {
              name: "lodash.throttle",
              message:
                "lodash.throttle exists only for the vendored Gantt in components/kibo-ui/**.",
            },
            {
              name: "@uidotdev/usehooks",
              message:
                "@uidotdev/usehooks exists only for the vendored Gantt in components/kibo-ui/**.",
            },
          ],
          patterns: [
            {
              group: ["date-fns/*"],
              message:
                "No date library outside components/kibo-ui/** — use lib/dates.ts (CLAUDE.md).",
            },
          ],
        },
      ],
    },
  },
  // Vendored upstream code (Kibo UI registry). It predates the React 19
  // compiler hook rules and is re-pullable from the registry, so it is held to
  // the compiler's rules loosely rather than forked to satisfy them. Anything
  // outside this folder still gets the full ruleset.
  {
    files: ["components/kibo-ui/**"],
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;
