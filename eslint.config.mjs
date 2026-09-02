import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Destructuring to omit keys (`const { a, ...rest } = obj`) is the
      // typed way to derive one object from another; the named siblings are
      // intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The e2e suite builds here so it does not fight a running dev server for
    // .next (Next's dev lock is scoped to the output directory). Without this,
    // lint walks the build output after every e2e run.
    ".next-e2e/**",
    // Playwright's failure artefacts: traces, screenshots, error context.
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
