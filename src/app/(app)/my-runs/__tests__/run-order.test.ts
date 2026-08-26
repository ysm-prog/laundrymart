import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { returnTo } from "@/lib/actions";

/**
 * Adjust Run, drawn on My Runs.
 *
 * The round's own day is the screen a manager is looking at when they notice
 * the van should call at the school before the hotel, so the ordering board is
 * drawn there as well as on Runs. Two things about that can break silently, and
 * neither is visible to the typechecker:
 *
 *   * the **field seam** — the board posts `return_to` and the action reads it.
 *     A producer and a consumer disagreeing about a field name is the class this
 *     repository has shipped three times behind a green `verify` (the job form's
 *     items, the dispatch planner's whole board, and its payload again). Here it
 *     would not look like a failure: the save would work and quietly move the
 *     manager to a different screen;
 *   * the **capability** — the client's rule is that management determines the
 *     order and drivers execute it, so the control has to be gated on
 *     `routes.sequence` and not on the `routes.write` a dispatcher holds.
 *
 * The two page-source assertions read the files rather than importing them,
 * which is the arrangement `nav.test.ts` already uses and for the same reason:
 * a `page.tsx` here reaches Supabase at module scope and cannot be imported
 * into a unit test at all.
 */

const source = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "src", "app", ...parts), "utf8");

const MY_RUNS_PAGE = source("(app)", "my-runs", "page.tsx");
const SEQUENCE_BOARD = source("(app)", "runs", "sequence-board.tsx");
const RUNS_ACTIONS = source("(app)", "runs", "actions.ts");

describe("who may adjust a run from My Runs", () => {
  // Which roles hold `routes.sequence` is pinned exhaustively in
  // `roles.test.ts`, and deliberately not restated here — a second, weaker copy
  // of that list is how the two drift. What this file pins is the half that
  // list cannot see: that this screen asks for that capability and not another.

  it("gates the board on ordering, not on planning", () => {
    expect(MY_RUNS_PAGE).toContain('canSequence={can(session.role, "routes.sequence")}');
    // A dispatcher may work somebody's day on their behalf (`routes.write`) and
    // still may not decide what order it is driven in — 0036's guard trigger
    // refuses them at the database, so a screen that offered it would be
    // offering a control that can only fail.
    expect(MY_RUNS_PAGE).not.toContain('canSequence={can(session.role, "routes.write")}');
    expect(MY_RUNS_PAGE).not.toContain("canSequence={canWork}");
  });

  it("draws no card at all for a round, rather than a disabled one", () => {
    // `sequence` is null unless the viewer may order the run, so the whole card
    // — and the extra read behind it — is absent for a board or a driver.
    expect(MY_RUNS_PAGE).toContain("const sequence = canSequence");
    expect(MY_RUNS_PAGE).toContain("{sequence && sequence.stops.length > 0 ? (");
  });
});

describe("the save comes back to the screen it was pressed on", () => {
  it("posts the field the action reads", () => {
    expect(SEQUENCE_BOARD).toContain('name="return_to"');
    expect(RUNS_ACTIONS).toContain("returnTo(formData,");
  });

  it("honours the path My Runs builds", () => {
    // Both shapes the page composes: a round looking at its own day, and a
    // manager looking at a named board's.
    const own = new FormData();
    own.set("return_to", "/my-runs?date=2026-08-28");
    expect(returnTo(own, "/runs")).toBe("/my-runs?date=2026-08-28");

    const named = new FormData();
    named.set("return_to", "/my-runs?date=2026-08-28&board=b1");
    expect(returnTo(named, "/runs")).toBe("/my-runs?date=2026-08-28&board=b1");
  });

  it("falls back to the Runs screen when nothing is posted", () => {
    expect(returnTo(new FormData(), "/runs?date=2026-08-28&board=b1"))
      .toBe("/runs?date=2026-08-28&board=b1");
  });

  it("refuses anything that is not a plain same-site path", () => {
    // The value arrives in a form field, so it is hostile until proven
    // otherwise: `//evil.example` is a protocol-relative URL and would make
    // every sequence save an open redirect.
    for (const hostile of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const posted = new FormData();
      posted.set("return_to", hostile);
      expect(returnTo(posted, "/runs")).toBe("/runs");
    }
  });
});
