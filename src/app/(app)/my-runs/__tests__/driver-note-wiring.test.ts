import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The assign forms post the note and the actions read it under the same name
 * (the seam this repo has shipped broken three times behind a green verify).
 * Source, because both actions reach `lib/env` and cannot be imported here.
 */
const src = join(__dirname, "../../../..");
const read = (file: string) => readFileSync(join(src, file), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the note for the driver, form to action", () => {
  it("is posted by the single Assign form and by the bulk move", () => {
    expect(code(read("app/(app)/my-runs/assign-form.tsx"))).toMatch(/name=\{DRIVER_NOTE_FIELD\}/);
    expect(code(read("app/(app)/runs/move-to-board.tsx"))).toMatch(/name=\{DRIVER_NOTE_FIELD\}/);
  });

  it("is read by both actions, and only the single one lets blank clear", () => {
    const single = code(read("app/(app)/my-runs/actions.ts"));
    const bulk = code(read("app/(app)/runs/actions.ts"));
    expect(single).toMatch(/readDriverNote\(formData\.get\(DRIVER_NOTE_FIELD\), \{ blankClears: true \}\)/);
    expect(bulk).toMatch(/readDriverNote\(formData\.get\(DRIVER_NOTE_FIELD\), \{ blankClears: false \}\)/);
  });

  it("is written into delivery_instructions, tenant-filtered, with the row count read back", () => {
    const writer = code(read("lib/runs/driver-note.ts"));
    expect(writer).toMatch(/update\(\{ delivery_instructions: value \}\)/);
    expect(writer).toMatch(/\.eq\("tenant_id", tenantId\)/);
    expect(writer).toMatch(/\.select\("id"\)/);
  });

  it("opens the job page's form showing the current instruction", () => {
    expect(code(read("app/(app)/orders/[id]/dispatch-card.tsx")))
      .toMatch(/driverNote=\{order\.delivery_instructions\}/);
  });
});
