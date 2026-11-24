import { describe, expect, it } from "vitest";
import { customerAnswerUse, dateAnswerApplies, type IntakeTickets } from "../intake-tickets";

const at = (customer: number, date: number, dateLanded = 0): IntakeTickets => ({ customer, date, dateLanded });

describe("customerAnswerUse", () => {
  it("drops the answer once another customer is chosen", () => {
    expect(customerAnswerUse(at(1, 0), at(2, 0))).toBe("drop");
    expect(customerAnswerUse(at(1, 0), at(2, 3, 3))).toBe("drop");
  });

  it("applies everything when no date request was sent since", () => {
    expect(customerAnswerUse(at(1, 0), at(1, 0))).toBe("all");
    // A date change that sent nothing does not move the date ticket.
    expect(customerAnswerUse(at(1, 2, 2), at(1, 2, 2))).toBe("all");
  });

  it("keeps the items and defaults while a newer date request is still out", () => {
    expect(customerAnswerUse(at(1, 0), at(1, 1, 0))).toBe("items+defaults");
  });

  it("keeps only the items once a newer date answer has landed", () => {
    expect(customerAnswerUse(at(1, 0), at(1, 1, 1))).toBe("items");
  });
});

describe("dateAnswerApplies", () => {
  it("applies only while neither the date nor the customer has moved", () => {
    expect(dateAnswerApplies(at(1, 1), at(1, 1))).toBe(true);
    expect(dateAnswerApplies(at(1, 1), at(1, 2))).toBe(false);
    expect(dateAnswerApplies(at(1, 1), at(2, 1))).toBe(false);
  });
});
