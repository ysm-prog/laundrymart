import { describe, expect, it } from "vitest";
import { answersFromForm, carryAnswers } from "../carry";

const ID = "8c2b996b-1111-4222-8333-944455556666";

describe("carryAnswers", () => {
  it("adds the answers to a bare path", () => {
    expect(carryAnswers("/orders/new", { customer: ID, received: "2026-11-17", due: "2026-11-19" }))
      .toBe(`/orders/new?customer=${ID}&received=2026-11-17&due=2026-11-19`);
  });

  it("keeps a query the path already carries", () => {
    expect(carryAnswers("/orders/new?pickup=abc", { received: "2026-11-17" }))
      .toBe("/orders/new?pickup=abc&received=2026-11-17");
  });

  it("replaces rather than repeats an answer the path already carries", () => {
    expect(carryAnswers("/orders/new?received=2026-11-01", { received: "2026-11-17" }))
      .toBe("/orders/new?received=2026-11-17");
  });

  it("leaves out anything that is not a real date or a uuid", () => {
    expect(carryAnswers("/orders/new", {
      customer: "not-an-id", received: "2026-02-31", due: "", collect: null,
    })).toBe("/orders/new");
  });
});

describe("answersFromForm", () => {
  it("reads the four answers the job form posts", () => {
    const form = new FormData();
    form.set("customer_id", ID);
    form.set("received_date", "2026-11-17");
    form.set("expected_delivery_date", "2026-11-19");
    form.set("expected_collection_date", "");
    expect(carryAnswers("/orders/new", answersFromForm(form)))
      .toBe(`/orders/new?customer=${ID}&received=2026-11-17&due=2026-11-19`);
  });
});
