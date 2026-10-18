import { describe, expect, it } from "vitest";
import {
  pushBlockedReason, xeroAccountProblems, xeroPushRefusal, type UsedAccount,
} from "../xero-readiness";

const account = (code: string, xero: string | null): UsedAccount => ({
  id: `id-${code}`, code, name: `Account ${code}`, xeroAccountCode: xero, usedBy: ["items"],
});

describe("the Xero pre-flight (brief 1.2)", () => {
  it("lists an account in use with no Xero code — 4-1150 and 4-1151 in the review", () => {
    const problems = xeroAccountProblems([account("4-1151", null), account("4-1150", ""), account("4-1100", "200")], null);
    expect(problems.map((entry) => [entry.account.code, entry.problem])).toEqual([
      ["4-1150", "unmapped"], ["4-1151", "unmapped"],
    ]);
  });

  it("lists a mapped code the connected chart does not carry, once the chart is read", () => {
    const used = [account("4-1100", "200"), account("4-1200", "999")];
    expect(xeroAccountProblems(used, new Set(["200", "260"])).map((entry) => entry.problem)).toEqual(["not_in_xero"]);
    expect(xeroAccountProblems(used, null)).toEqual([]);
  });

  it("blocks pushing while anything is unmapped, and names the codes", () => {
    const reason = pushBlockedReason(xeroAccountProblems([account("4-1150", null), account("4-1151", null)], null));
    expect(reason).toMatch(/2 accounts/);
    expect(reason).toMatch(/4-1150, 4-1151/);
    expect(pushBlockedReason([])).toBeNull();
  });
});

describe("xeroPushRefusal", () => {
  it("never sends an imported invoice, and says why", () => {
    expect(xeroPushRefusal({ status: "issued", source: "import" })).toMatch(/MYOB/);
  });
  it("sends an issued app invoice", () => {
    expect(xeroPushRefusal({ status: "issued", source: "app" })).toBeNull();
    expect(xeroPushRefusal({ status: "issued" })).toBeNull();
  });
  it("refuses a draft and a void as before", () => {
    expect(xeroPushRefusal({ status: "draft", source: "app" })).toMatch(/draft/);
    expect(xeroPushRefusal({ status: "void", source: "app" })).toMatch(/void/);
  });
});
