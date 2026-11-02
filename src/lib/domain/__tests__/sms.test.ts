import { describe, expect, it } from "vitest";
import { buildInvoiceSms, displayMobile, normaliseMobile, readClickSendResponse } from "../sms";

describe("normaliseMobile", () => {
  it.each([
    ["0412 345 678"], ["0412345678"], ["+61 412 345 678"], ["+61412345678"],
    ["61412345678"], ["0061 412 345 678"], ["(0412) 345-678"], ["+61 (0) 412 345 678"],
  ])("reads %s", (raw) => {
    expect(normaliseMobile(raw)).toBe("+61412345678");
  });

  it.each([
    ["08 8365 7211"], ["88365 7211"], ["1300 123 456"], ["041234567"], ["04123456789"], ["call Sam"], [""],
  ])("refuses %s, because a text to it reaches nobody", (raw) => {
    expect(normaliseMobile(raw)).toBeNull();
  });

  it("answers null for nothing at all", () => {
    expect(normaliseMobile(null)).toBeNull();
    expect(normaliseMobile(undefined)).toBeNull();
  });
});

describe("displayMobile", () => {
  it("prints the number the way a person says it", () => {
    expect(displayMobile("+61412345678")).toBe("0412 345 678");
  });
});

describe("buildInvoiceSms", () => {
  const link = `https://ats.coreit.com.au/i/${"a".repeat(22)}.abcd.${"b".repeat(22)}`;
  it("says who, what, how much and where, in one message part", () => {
    const body = buildInvoiceSms({
      business: "Adelaide Towel Service", invoiceNumber: "00415360", amount: "$80.20", due: "16/11/2026", link,
    });
    expect(body).toBe(`Adelaide Towel Service invoice 00415360 $80.20 due 16/11/2026: ${link}`);
    expect(body.length).toBeLessThanOrEqual(160);
  });
  it("leaves the due date out when there is none", () => {
    expect(buildInvoiceSms({ business: "X", invoiceNumber: "1", amount: "$1.00", due: null, link: "l" }))
      .toBe("X invoice 1 $1.00: l");
  });
});

const body = (status: string, code = "SUCCESS") => ({
  response_code: code, data: { messages: [{ status, message_id: "m1" }] },
});

describe("reading ClickSend's answer", () => {
  it("takes a queued message as sent", () => {
    expect(readClickSendResponse(200, body("SUCCESS"))).toEqual({ ok: true, id: "m1" });
  });

  it("does not believe the top level when the message itself was refused", () => {
    const result = readClickSendResponse(200, body("INSUFFICIENT_CREDIT"));
    expect(result).toEqual({ ok: false, error: "The ClickSend account is out of credit." });
    expect(readClickSendResponse(200, body("INVALID_RECIPIENT")).ok).toBe(false);
  });

  it("says when the keys are wrong", () => {
    expect(readClickSendResponse(401, null))
      .toEqual({ ok: false, error: "ClickSend refused the username or API key." });
    expect(readClickSendResponse(200, { response_code: "INVALID_CREDENTIALS" }).ok).toBe(false);
  });

  it("refuses a failed request", () => {
    expect(readClickSendResponse(429, null).ok).toBe(false);
    expect(readClickSendResponse(500, { response_code: "INTERNAL_ERROR" }).ok).toBe(false);
  });
});
