// Flat config: `next lint` was removed in Next.js 16, so linting now runs
// through the ESLint CLI directly.
import next from "eslint-config-next/core-web-vitals";

/*
  Reuse the typescript-eslint that `eslint-config-next` already registers, rather
  than depending on it directly: §10a pins the lint stack through that package
  (typescript-eslint 8, ESLint 9), and a second declaration is a second thing to
  keep in step. Flat config requires the plugin in the *same* object as the rule,
  so it has to be pulled back out. Throws rather than skipping — a guard rule
  that quietly stops running is worse than no guard rule.
*/
const tsPlugin = next.find((entry) => entry.plugins?.["@typescript-eslint"])
  ?.plugins["@typescript-eslint"];
if (!tsPlugin) {
  throw new Error(
    "eslint-config-next no longer registers @typescript-eslint; the no-unused-vars guard below is not running.",
  );
}

const config = [
  {
    ignores: [
      ".next/**", "node_modules/**", "out/**", "coverage/**",
      "next-env.d.ts", "public/sw.js",
    ],
  },
  ...next,
  {
    /*
      A value fetched and then dropped on the floor is the shape of a real bug,
      not a tidiness question. `eslint-config-next` does not enable this rule, so
      `createOrder` drew a job number from `next_number()`, never put it on the
      insert, and every job creation died on a not-null constraint — through a
      green typecheck, a green lint and a green build, because the Supabase
      client's `.insert()` takes an untyped object and cannot know a column is
      missing.

      `_`-prefixed names are still allowed: that is the deliberate spelling for
      a binding that exists only to be skipped, as in `const { a: _a, ...rest }`.
    */
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
];

export default config;
