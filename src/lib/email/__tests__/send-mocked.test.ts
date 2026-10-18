import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The one email transport, with Resend mocked out (Darshan's brief, ground rule
 * 5: "No email … from tests. Mock both."). Nothing here can post to Resend:
 * the SDK is replaced at the module boundary and every message it is handed is
 * captured for the assertions.
 */

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  send: vi.fn(),
  constructed: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    constructor(apiKey: string) { mocks.constructed.push(apiKey); }
  },
}));

import { emailIsConfigured, sendEmail } from "@/lib/email/send";

const MESSAGE = {
  to: "accounts@acme.example",
  subject: "Invoice INV00042",
  html: "<p>Hello</p>",
  text: "Hello",
  attachments: [{ filename: "INV00042.pdf", content: Buffer.from("%PDF-1.7") }],
};

function configure(values: Record<string, string | undefined>) {
  for (const key of Object.keys(mocks.env)) delete mocks.env[key];
  Object.assign(mocks.env, values);
}

afterEach(() => {
  mocks.send.mockReset();
  mocks.constructed.length = 0;
  configure({});
});

describe("sending through a mocked Resend", () => {
  it("does not touch the provider at all while no provider is configured", async () => {
    configure({ RESEND_API_KEY: "re_test_key_123" }); // a key but no from address
    expect(emailIsConfigured()).toBe(false);
    const result = await sendEmail(MESSAGE);
    expect(result).toEqual({
      ok: false,
      error: "No email provider is configured. Set RESEND_API_KEY and INVOICE_FROM_EMAIL.",
    });
    expect(mocks.constructed).toHaveLength(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("hands Resend the message, the laundry's name, the reply-to and the PDF", async () => {
    configure({
      RESEND_API_KEY: "re_test_key_123", INVOICE_FROM_EMAIL: "invoices@laundry.example",
      INVOICE_FROM_NAME: "Test Laundry", INVOICE_REPLY_TO: "accounts@laundry.example",
    });
    mocks.send.mockResolvedValue({ data: { id: "email-1" }, error: null });

    expect(await sendEmail(MESSAGE)).toEqual({ ok: true, id: "email-1" });
    expect(mocks.constructed).toEqual(["re_test_key_123"]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent = mocks.send.mock.calls[0]![0];
    expect(sent).toMatchObject({
      from: "Test Laundry <invoices@laundry.example>",
      to: ["accounts@acme.example"],
      subject: "Invoice INV00042",
      replyTo: "accounts@laundry.example",
    });
    expect(sent.attachments).toEqual([{ filename: "INV00042.pdf", content: MESSAGE.attachments[0]!.content }]);
  });

  it("reports the provider's refusal rather than a success", async () => {
    configure({ RESEND_API_KEY: "re_test_key_123", INVOICE_FROM_EMAIL: "invoices@laundry.example" });
    mocks.send.mockResolvedValue({ data: null, error: { message: "Domain not verified" } });
    expect(await sendEmail(MESSAGE)).toEqual({ ok: false, error: "Domain not verified" });
  });

  it("reports a thrown network error rather than throwing", async () => {
    configure({ RESEND_API_KEY: "re_test_key_123", INVOICE_FROM_EMAIL: "invoices@laundry.example" });
    mocks.send.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await sendEmail(MESSAGE)).toEqual({ ok: false, error: "connect ECONNREFUSED" });
  });
});
