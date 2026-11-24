import { describe, expect, it } from "vitest";
import { workflowFromRead } from "../workflow";

/**
 * Which workflow a laundry runs, read off its settings row (2026-11-24). An
 * absent key is the simplified workflow, as in 0065; a read that fails is the
 * full one, as the trigger treats a row it cannot read — so a transient error
 * in a Full laundry never completes a new job on save.
 */
describe("workflowFromRead", () => {
  it("reads the stored answer", () => {
    expect(workflowFromRead({ data: { settings: { operations: { workflow: "full" } } }, error: null })).toBe("full");
    expect(workflowFromRead({ data: { settings: { operations: { workflow: "simplified" } } }, error: null }))
      .toBe("simplified");
  });

  it("treats a laundry that never chose as simplified", () => {
    expect(workflowFromRead({ data: { settings: {} }, error: null })).toBe("simplified");
    expect(workflowFromRead({ data: { settings: null }, error: null })).toBe("simplified");
  });

  it("treats a failed or empty read as the full workflow", () => {
    expect(workflowFromRead({ data: null, error: { message: "timeout" } })).toBe("full");
    expect(workflowFromRead({ data: { settings: {} }, error: { message: "timeout" } })).toBe("full");
    expect(workflowFromRead({ data: null, error: null })).toBe("full");
  });
});
