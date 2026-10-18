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
    expect(complete).toMatch(/const admin = createAdminClient\(\);/);
    expect(complete).toMatch(/autoPriceCompletedJob\(admin, session, order\.id\)/);
  });

  it("approves automatically only a job it priced in full (brief 2.3)", () => {
    expect(complete).toMatch(
      /if \(pricing\.state === "priced"\) approval = await autoApproveIfClean\(admin, session, order\.id\)/);
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

describe("automatic approval (brief 2.3)", () => {
  const source = read("../auto-approve.ts");

  it("goes through the existing approve routine, never around it", () => {
    expect(source).toMatch(/approveAndPlaceJob\(admin, session, job\.id\)/);
    // No write of its own: the freeze, the status and the placement are the
    // approve routine's, so an automatic approval cannot mean anything else.
    expect(source).not.toMatch(/freeze_job_charges|\.update\(|\.insert\(/);
  });

  it("names the tenant on every read it makes with the service role", () => {
    const reads = source.match(/admin\s*\.from\("[a-z_]+"\)[\s\S]*?(?:;|,\n)/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const statement of reads) expect(statement).toMatch(/tenant_id|eq\("id", session\.tenantId\)/);
  });
});
