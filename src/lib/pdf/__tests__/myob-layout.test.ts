import { describe, expect, it } from "vitest";
import { Font } from "@react-pdf/renderer";
import { auDate, imageFormat, invoiceDocumentTitle, pdfLineCells } from "../line-display";
import { formatAmount, formatQty } from "../myob-layout";
import { renderCreditNotePdf } from "../render";
import type { CreditNotePdfData } from "../credit-note-data";
import {
  BRANDING_BUCKET, LOGO_MAX_BYTES, isTenantLogoPath, logoObjectPath, logoRefusal,
} from "@/lib/branding";
import {
  EMPTY_PROFILE, bankingDetailsLine, normaliseWebsite, parseInvoiceProfile,
} from "@/lib/domain/invoice-profile";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const TENANT = "20000000-0000-4000-8000-000000000001";

describe("pdfLineCells — what one line prints (brief 1.10)", () => {
  it("prints the item code and the item's name on a job line, not the generator's text", () => {
    expect(pdfLineCells({
      description: "LJ00032 — Towels — 10", taxable: true, origin: "job",
      item_code: "T35", item_name: "Towels - Black", tax_code: "GST",
    })).toEqual({ itemId: "T35", description: "Towels - Black", tax: "GST" });
  });

  it("keeps the words somebody typed on a manual or contract line", () => {
    expect(pdfLineCells({
      description: "Extra pickup, Saturday", taxable: true, origin: "manual",
      item_code: "Del", item_name: "Delivery",
    }).description).toBe("Extra pickup, Saturday");
  });

  it("leaves the Item ID blank where no item is named — never a GL code", () => {
    const cells = pdfLineCells({ description: "Fuel levy", taxable: true, origin: "job" });
    expect(cells.itemId).toBe("");
    expect(cells.description).toBe("Fuel levy");
  });

  it("prints the tax code, and answers from the GST flag when there is none", () => {
    expect(pdfLineCells({ description: "x", taxable: false, tax_code: "n-t" }).tax).toBe("N-T");
    expect(pdfLineCells({ description: "x", taxable: true }).tax).toBe("GST");
    expect(pdfLineCells({ description: "x", taxable: false }).tax).toBe("FRE");
  });
});

describe("invoiceDocumentTitle", () => {
  const base = { invoice_type: "consolidated", status: "issued", tax_amount: 2.28, total: 25.08 };
  it("says Tax invoice only where GST is charged", () => {
    expect(invoiceDocumentTitle(base)).toBe("Tax invoice");
    expect(invoiceDocumentTitle({ ...base, tax_amount: 0 })).toBe("Invoice");
  });
  it("never lets a draft look final, and calls a credit MYOB's word", () => {
    expect(invoiceDocumentTitle({ ...base, status: "draft" })).toBe("Draft invoice");
    expect(invoiceDocumentTitle({ ...base, invoice_type: "credit" })).toBe("Adjustment note");
    expect(invoiceDocumentTitle({ ...base, total: -10 })).toBe("Adjustment note");
  });
});

describe("the table's number formats", () => {
  it("prints dates the way MYOB does", () => {
    expect(auDate("2026-10-18")).toBe("18/10/2026");
    expect(auDate("2026-10-18T04:00:00Z")).toBe("18/10/2026");
    expect(auDate(null)).toBe("—");
  });
  it("prints a quantity without decimals it does not have", () => {
    expect(formatQty(100)).toBe("100");
    expect(formatQty(2.5)).toBe("2.5");
  });
  it("prints money without the dollar sign, and a unit price to four places where it has them", () => {
    expect(formatAmount(1234.5)).toBe("1,234.50");
    expect(formatAmount(0.2364, 4)).toBe("0.2364");
    expect(formatAmount(0.35, 4)).toBe("0.35");
  });
});

describe("the payment line is built from Settings › Invoicing, never written in code", () => {
  const profile = { ...EMPTY_PROFILE, bankAccountName: "Example Laundry", bsb: "062-000", accountNumber: "12345678" };
  it("prints MYOB's one-line format, spacing included", () => {
    expect(bankingDetailsLine(profile))
      .toBe("Banking Details: BSB:062-000 Account No.12345678 Account Name: Example Laundry");
  });
  it("prints nothing unless all three details are there", () => {
    expect(bankingDetailsLine({ ...profile, bsb: null })).toBeNull();
    expect(bankingDetailsLine(EMPTY_PROFILE)).toBeNull();
  });
});

describe("normaliseWebsite", () => {
  it("prints a website the way the invoice does", () => {
    expect(normaliseWebsite("https://www.Example.com.au/")).toBe("www.example.com.au");
    expect(normaliseWebsite("adelaidetowelservice.com.au")).toBe("adelaidetowelservice.com.au");
  });
  it("refuses a sentence", () => {
    expect(normaliseWebsite("call us on the phone")).toBeNull();
    expect(normaliseWebsite("localhost")).toBeNull();
  });
  it("is read back from the stored profile, and an old profile without it reads null", () => {
    expect(parseInvoiceProfile({ invoiceProfile: { website: "example.com.au" } }).website).toBe("example.com.au");
    expect(parseInvoiceProfile({ invoiceProfile: { addressLines: ["1 Road"] } }).website).toBeNull();
    expect(parseInvoiceProfile({ invoiceProfile: { addressLines: ["1 Road"] } }).logoPath).toBeNull();
  });
});

describe("the logo is the tenant's data (0054)", () => {
  it("reads the format from the file, never its name", () => {
    expect(imageFormat(PNG)).toBe("png");
    expect(imageFormat(JPG)).toBe("jpg");
    expect(imageFormat(new TextEncoder().encode("GIF89a........"))).toBeNull();
  });
  it("refuses an empty file, a big one and one a PDF cannot print", () => {
    expect(logoRefusal(new Uint8Array())).toMatch(/Choose a PNG or JPEG/);
    const big = new Uint8Array(LOGO_MAX_BYTES + 1); big.set(PNG);
    expect(logoRefusal(big)).toMatch(/900 KB/);
    expect(logoRefusal(new TextEncoder().encode("<svg></svg>"))).toMatch(/PNG or a JPEG/);
    expect(logoRefusal(PNG)).toBeNull();
  });
  it("keeps the object under the tenant's own prefix, which is what the policy reads", () => {
    const path = logoObjectPath(TENANT, "png", 1760760000000);
    expect(path).toBe(`${TENANT}/invoice-logo-1760760000000.png`);
    expect(isTenantLogoPath(TENANT, path)).toBe(true);
    expect(isTenantLogoPath("10000000-0000-4000-8000-000000000001", path)).toBe(false);
    expect(isTenantLogoPath(TENANT, `${TENANT}/../other/logo.png`)).toBe(false);
    expect(isTenantLogoPath(TENANT, null)).toBe(false);
    expect(BRANDING_BUCKET).toBe("tenant-branding");
  });
});

describe("words wrap whole, as they do on the MYOB invoice", () => {
  // The first side-by-side render printed the bank account name as "Ex-ample":
  // react-pdf hyphenates by default, and a hyphenated account or customer name
  // reads as a typo on a document somebody pays from. Importing the layout is
  // what registers the rule, so this reads the renderer's own state.
  it("never splits a word across two lines", () => {
    const hyphenate = Font.getHyphenationCallback();
    expect(hyphenate?.("Example")).toEqual(["Example"]);
    expect(hyphenate?.("Catering")).toEqual(["Catering"]);
  });
});

describe("the PDF sources carry no identity of their own", () => {
  it("writes no bank detail, phone or email literal into the templates", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../invoice-document.tsx", "../credit-note.tsx", "../myob-layout.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/\b\d{3}-\d{3}\b/);          // a BSB
      expect(source, file).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);      // an email address
      expect(source, file).not.toMatch(/\b0[2-8]\s?\d{4}\s?\d{4}\b/); // an Australian phone number
      expect(source, file).not.toMatch(/69\s?892\s?278\s?164/);     // ATS's ABN
    }
  });
});

const credit: CreditNotePdfData = {
  tenant: {
    name: "Harbour Linen Co", abn: "51824753556",
    profile: { ...EMPTY_PROFILE, addressLines: ["1 Mill Road"], website: "example.com.au" },
  },
  customer: {
    business_name: "Bondi Bistro", customer_number: "CUST00042", abn: null,
    address: ["12 Campbell Parade"], contact_name: "Sam Smith",
  },
  note: {
    credit_note_number: "CN00002", status: "issued", issue_date: "2026-10-18", reason: "Short delivery",
    subtotal: 25.08, tax_amount: 2.28, total: 25.08, invoice_number: "INV00042",
  },
  lines: [{ description: "Towels - Black", quantity: 10, unit_price: 2.508, amount: 25.08, taxable: true }],
};

describe("renderCreditNotePdf", () => {
  it("renders a complete adjustment note", async () => {
    const buffer = await renderCreditNotePdf(credit);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.subarray(-1024).toString("latin1")).toContain("%%EOF");
  }, 30_000);

  it("renders with no lines and no reason rather than failing", async () => {
    const buffer = await renderCreditNotePdf({ ...credit, lines: [], note: { ...credit.note, reason: null } });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);
});
