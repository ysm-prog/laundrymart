// Flat config: `next lint` was removed in Next.js 16, so linting now runs
// through the ESLint CLI directly.
import next from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [
      ".next/**", "node_modules/**", "out/**", "coverage/**",
      "next-env.d.ts", "public/sw.js",
    ],
  },
  ...next,
];

export default config;
