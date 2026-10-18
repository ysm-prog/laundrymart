import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE, invoiceProfileGaps, issueBlockedReason, issueGaps, type InvoiceProfile,
} from "../invoice-profile";

/**
 * Brief 1.1 (18 October 2026): a draft becomes a tax invoice only once the
 * laundry's ABN, address and bank details are set. INV00008 was issued with
 * Settings › Invoicing empty and printed "TAX INVOICE" with none of them.
 *
 * `guard_invoice_issue` (0053) asks the same four questions in SQL;
 * `invoice_issue_guard.test.sql` proves that half against real rows.
 */

// ATS's own ABN, from its MYOB invoice and the brief. Valid: the weighted sum is 534 = 6 × 89.
const ATS_ABN = "69892278164";

const complete: InvoiceProfile = {
  ...EMPTY_PROFILE,
  addressLines: ["1 Example Road", "Adelaide SA 5000"],
  bankAccountName: "Example Laundry", bsb: "062-000", accountNumber: "12345678",
};

describe("what stops a draft being issued", () => {
  it("names all three when nothing is set", () => {
    expect(issueGaps(null, EMPTY_PROFILE)).toEqual(["abn", "address", "bank"]);
  });

  it("names only the bank details on the live 18 October state — ABN and address set", () => {
    const live = { ...EMPTY_PROFILE, addressLines: ["16a Example Rd", "Newton SA 5074"] };
    expect(issueGaps(ATS_ABN, live)).toEqual(["bank"]);
    expect(issueBlockedReason(issueGaps(ATS_ABN, live)))
      .toBe("Add your bank details in Settings › Invoicing before issuing. A tax invoice needs them.");
  });

  it("checks the ATO checksum, not just eleven digits", () => {
    // One digit off: still eleven digits, still plausible, not an ABN.
    expect(issueGaps("69892278165", complete)).toEqual(["abn_invalid"]);
    expect(issueBlockedReason(["abn_invalid"])).toMatch(/a valid ABN/);
    // The ATO's own published example passes.
    expect(issueGaps("51824753556", complete)).toEqual([]);
  });

  it("treats a blank ABN as missing, not as invalid", () => {
    expect(issueGaps("   ", complete)).toEqual(["abn"]);
  });

  it("wants all three bank details — a BSB and account number with no name is not a payment instruction", () => {
    expect(issueGaps(ATS_ABN, { ...complete, bankAccountName: null })).toEqual(["bank"]);
    expect(issueGaps(ATS_ABN, { ...complete, bsb: null })).toEqual(["bank"]);
    expect(issueGaps(ATS_ABN, { ...complete, accountNumber: null })).toEqual(["bank"]);
  });

  it("opens issuing once everything is set", () => {
    expect(issueGaps(ATS_ABN, complete)).toEqual([]);
    expect(issueBlockedReason([])).toBeNull();
  });

  it("lists several gaps in one sentence", () => {
    expect(issueBlockedReason(["abn", "address", "bank"]))
      .toBe("Add your ABN, your business address and your bank details in Settings › Invoicing before issuing. A tax invoice needs them.");
  });

  it("tells a role that cannot open Settings › Invoicing who can", () => {
    expect(issueBlockedReason(["bank"], false))
      .toBe("Ask the owner to add your bank details in Settings › Invoicing. A tax invoice needs them before it can be issued.");
  });

  it("keeps the printed-invoice warning on the same rule", () => {
    expect(invoiceProfileGaps("69892278165", complete)).toEqual([
      "a valid ABN — the one saved does not pass the ATO check",
    ]);
    expect(invoiceProfileGaps(ATS_ABN, complete)).toEqual([]);
  });
});
