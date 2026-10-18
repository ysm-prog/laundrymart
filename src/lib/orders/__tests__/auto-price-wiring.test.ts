import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Brief 1.3: completion prices the job, through the one completion path. Read
 * from the sources because `lib/orders/*` reaches `lib/env` and cannot be
 * imported here — the trap §2 records three times.
 */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("automatic pricing on completion", () => {
  const complete = read("../complete.ts");
  const billing = read("../job-billing.ts");
  const body = billing.slice(billing.indexOf("export async function autoPriceCompletedJob"),
    billing.indexOf("export async function priceAndSaveJob"));

  it("runs from the single completion implementation", () => {
    expect(complete).toMatch(/autoPriceCompletedJob\(createAdminClient\(\), session, order\.id\)/);
  });

  it("never approves", () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/approveJob|freeze_job_charges|billing_status:\s*"approved"/);
  });

  it("names the tenant on every read it makes with the service role", () => {
    const reads = body.match(/admin\s*\.from\("[a-z_]+"\)[\s\S]*?;/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const statement of reads) expect(statement).toMatch(/tenant_id/);
  });
});
