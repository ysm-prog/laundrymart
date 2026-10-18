import { defineConfig, devices } from "@playwright/test";

/**
 * The golden-path end-to-end test (Darshan's BA review, section 5).
 *
 * Runs against a deployed preview — never production — whose Supabase project
 * is a **seeded branch**, so nothing here can write to `laundrymart-syd`. The
 * base URL and the two logins come from the environment; without them the
 * suite skips itself rather than failing, so `npm test` (vitest) and `verify`
 * are untouched. `.github/workflows/e2e.yml` is the only thing that runs it.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
  },
});
