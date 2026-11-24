import { describe, expect, it } from "vitest";
import { answersFromForm, carriedDelivery, carriedUuid, carriedVia, carryAnswers, withoutParam } from "../carry";

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
    form.set("delivery_required", "on");
    expect(carryAnswers("/orders/new", answersFromForm(form)))
      .toBe(`/orders/new?customer=${ID}&received=2026-11-17&due=2026-11-19&delivery=yes`);
  });

  it("reads a missing delivery_required as a customer pickup", () => {
    const form = new FormData();
    form.set("expected_collection_date", "2026-11-20");
    expect(carryAnswers("/orders/new", answersFromForm(form)))
      .toBe("/orders/new?collect=2026-11-20&delivery=no");
  });

  it("can leave out the customer and keep the rest", () => {
    const form = new FormData();
    form.set("customer_id", ID);
    form.set("received_date", "2026-11-17");
    expect(carryAnswers("/orders/new", { ...answersFromForm(form), customer: null }))
      .toBe("/orders/new?received=2026-11-17&delivery=no");
  });
});

describe("carriedDelivery", () => {
  it("reads yes and no, and nothing else", () => {
    expect(carriedDelivery("yes")).toBe(true);
    expect(carriedDelivery("no")).toBe(false);
    for (const junk of [undefined, null, "", "true", "on"]) expect(carriedDelivery(junk)).toBeUndefined();
  });
});

describe("withoutParam", () => {
  it("takes one parameter off and keeps the rest", () => {
    expect(withoutParam("/orders/new?pickup=p1&via=driver_pickup", "pickup")).toBe("/orders/new?via=driver_pickup");
    expect(withoutParam("/orders/new?pickup=p1", "pickup")).toBe("/orders/new");
    expect(withoutParam("/orders/new", "pickup")).toBe("/orders/new");
  });
});

describe("how the laundry arrived", () => {
  const DRIVER = "1c2b996b-1111-4222-8333-944455556666";

  it("carries a driver pickup with its day and driver", () => {
    const form = new FormData();
    form.set("received_via", "driver_pickup");
    form.set("pickup_date", "2026-11-16");
    form.set("pickup_driver_id", DRIVER);
    expect(carryAnswers("/orders/new", { ...answersFromForm(form), delivery: null }))
      .toBe(`/orders/new?via=driver_pickup&picked=2026-11-16&collector=${DRIVER}`);
  });

  it("leaves the pickup's day and driver off any other channel", () => {
    expect(carryAnswers("/orders/new", { via: "customer_dropoff", picked: "2026-11-16", collector: DRIVER }))
      .toBe("/orders/new?via=customer_dropoff");
  });

  it("refuses a channel that is not stored, and a driver that is not a uuid", () => {
    expect(carryAnswers("/orders/new", { via: "teleport" })).toBe("/orders/new");
    expect(carryAnswers("/orders/new", { via: "driver_pickup", picked: "2026-02-31", collector: "bob" }))
      .toBe("/orders/new?via=driver_pickup");
  });

  it("reads them back, and nothing else", () => {
    expect(carriedVia("driver_pickup")).toBe("driver_pickup");
    for (const junk of [undefined, null, "", "teleport"]) expect(carriedVia(junk)).toBeUndefined();
    expect(carriedUuid(DRIVER)).toBe(DRIVER);
    expect(carriedUuid("bob")).toBeUndefined();
  });
});
