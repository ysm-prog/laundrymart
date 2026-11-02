/**
 * The tax-invoice PDF (spec §7.14, §18), drawn on the standard template
 * (`standard-layout.tsx`, from Xero's `INV-0015359`).
 *
 * Rendered server-side so a customer, a mailbox and an auditor all get
 * identical bytes. The page is built from the same blocks as the credit note and
 * the statement, so every document a customer keeps is drawn one way.
 *
 * The data rules did not move with the layout:
 *  - **Line amounts are GST-inclusive** (0043), so the subtotal and the total are
 *    the same figure and the GST is stated as what it is, a part of it.
 *  - "Tax Invoice" only where GST is charged (the ATO's wording), a Draft prefix
 *    on a draft, "Adjustment Note" on a credit (`invoiceDocumentTitle`).
 *  - The void banner stays.
 *  - **No ledger code and no internal charge type** (2026-10-12): `4-1100` and
 *    "Wash only" are the laundry's bookkeeping vocabulary. The Item Code column is
 *    the *item* code the customer also uses (`T35`), never the GL code.
 *  - The Bank Deposit block is built from the invoice profile filled in on
 *    Settings › Invoicing, never written here.
 *  - **A purchase order prints**, because a government customer's accounts team
 *    matches on it.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import {
  bankDepositLines, formatAbn, invoiceTotalsRows,
} from "@/lib/domain/invoice-profile";
import { auDate, gstPercent, invoiceDocumentTitle, longDate, pdfLineCells } from "./line-display";
import {
  Addresses, DocFooter, DocHeader, LineTable, LowerBlock, SummaryStrip,
  formatAmount, formatQty, s,
  type Party, type StripColumn, type TableLine, type TotalRow,
} from "./standard-layout";
import type { InvoicePdfData } from "./invoice-data";

/** What the importer writes into `notes`; it describes our import, not the customer's invoice. */
const IMPORT_NOTE = /^Imported from the MYOB\b/i;

const b = StyleSheet.create({
  section: { marginTop: 22 },
  head: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  muted: { fontSize: 8.5, color: "#404040", marginTop: 2 },
  week: { marginTop: 8 },
  weekHead: {
    flexDirection: "row", justifyContent: "space-between",
    borderBottomWidth: 1, borderBottomColor: "#E3E3E3", paddingBottom: 2,
  },
  job: { marginTop: 3, paddingLeft: 6 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  itemRow: { flexDirection: "row", justifyContent: "space-between", paddingLeft: 10 },
  text: { fontSize: 8.5, lineHeight: 1.3 },
  grey: { fontSize: 8.5, lineHeight: 1.3, color: "#404040" },
  totals: { marginTop: 10, padding: 6, backgroundColor: "#EEEEEE" },
});

export function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const { tenant, customer, invoice, lines, breakdown } = data;
  const currency = invoice.currency || "AUD";
  const cash = (value: number) => formatMoney(Number(value ?? 0), currency);
  const plain = (value: number) => formatAmount(Number(value ?? 0));
  const title = invoiceDocumentTitle(invoice);
  const isCredit = invoice.invoice_type === "credit" || Number(invoice.total) < 0;

  const tableLines: TableLine[] = lines.map((line) => ({
    ...pdfLineCells(line, tenant.gstRate),
    qty: formatQty(line.quantity),
    unitPrice: formatAmount(line.unit_price, 4),
    amount: formatAmount(line.amount),
  }));

  // A draft can still change and a void is not payable; a credit is money owed
  // the other way. None of them carries a way to pay.
  const payable = invoice.status !== "draft" && invoice.status !== "void" && !isCredit;
  const banking = payable ? bankDepositLines(tenant.profile) : [];
  const notes = invoice.notes && !IMPORT_NOTE.test(invoice.notes.trim()) ? [invoice.notes.trim()] : [];

  // Paid, credited and the balance — the 0052 rows, from the same rule the
  // invoice page and the email use, so the three cannot disagree.
  const settlement = invoiceTotalsRows({
    total: invoice.total, taxAmount: invoice.tax_amount, amountPaid: invoice.amount_paid,
    amountCredited: invoice.amount_credited ?? 0, balance: invoice.balance,
  }).filter((row) => row.label === "Paid" || row.label === "Credited");

  const amountDue = invoice.status === "void" ? 0 : invoice.balance;
  const totals: TotalRow[] = [
    { label: "Subtotal", value: plain(invoice.subtotal) },
    ...(Number(invoice.tax_amount) > 0
      ? [{ label: `Includes GST ${gstPercent(tenant.gstRate)} of`, value: plain(invoice.tax_amount), note: true }]
      : []),
    { label: "Total", value: plain(invoice.total), rule: true },
    ...settlement.map((row) => ({ label: `Less ${row.label.toLowerCase()}`, value: plain(row.value) })),
    { label: "Amount due", value: cash(amountDue), rule: true, strong: true },
  ];

  const billTo: Party = {
    contact: customer.contact_name ?? null,
    business: customer.business_name,
    lines: customer.address,
    details: [
      ...(customer.billing_email ? [customer.billing_email] : []),
      ...(customer.phone ? [customer.phone] : []),
      ...(customer.abn ? [`ABN: ${formatAbn(customer.abn)}`] : []),
    ],
  };
  const shipTo: Party = {
    business: customer.business_name,
    lines: customer.ship_to?.length ? customer.ship_to : customer.address,
  };

  const strip: StripColumn[] = [
    { label: "Amount due", value: cash(amountDue), strong: true },
    ...(invoice.due_date && !isCredit
      ? [{ label: "Due date", value: longDate(invoice.due_date), strong: true }]
      : []),
    { label: "Issue date", value: invoice.status === "draft" ? "Not issued yet" : longDate(invoice.issue_date) },
    { label: "Invoice number", value: invoice.invoice_number },
    ...(invoice.purchase_order_number ? [{ label: "Reference", value: invoice.purchase_order_number }] : []),
    ...(invoice.period_start
      ? [{ label: "Period", value: `${longDate(invoice.period_start)} – ${longDate(invoice.period_end)}` }]
      : []),
  ];

  return (
    <Document title={`${title} ${invoice.invoice_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <DocHeader title={title} logo={tenant.logo ?? null} />

        <Addresses
          billTo={billTo}
          shipTo={shipTo}
          business={{
            name: tenant.name, abn: tenant.abn, addressLines: tenant.profile.addressLines,
            phone: tenant.profile.phone, email: tenant.profile.email, website: tenant.profile.website,
          }}
        />

        <SummaryStrip columns={strip} />

        {invoice.status === "void" ? (
          <Text style={s.banner}>This invoice has been voided and is not payable.</Text>
        ) : null}

        <LineTable lines={tableLines} empty="No lines on this invoice." />

        <LowerBlock sections={banking.length ? [banking] : []} notes={notes} totals={totals} />

        {/* What was processed, job by job. Printed whenever the invoice bills
            jobs — one or many — because the line now carries the item's name
            and not the job number (brief 1.10, gap G15), so this is the only
            place the customer can read which job each towel came from. */}
        {breakdown.jobCount >= 1 ? (
          <View style={b.section} break={breakdown.weeks.length > 3}>
            <Text style={b.head}>Service breakdown</Text>
            <Text style={b.muted}>
              What was processed on this invoice — {breakdown.jobCount} {breakdown.jobCount === 1 ? "job" : "jobs"}.
            </Text>
            {breakdown.weeks.map((week) => (
              <View key={week.weekStart ?? "undated"} style={b.week} wrap={false}>
                <View style={b.weekHead}>
                  <Text style={b.head}>
                    {week.weekStart ? `Week of ${longDate(week.weekStart)}` : "No completion date"}
                  </Text>
                  <Text style={b.head}>{cash(week.total)}</Text>
                </View>
                {week.jobs.map((job) => (
                  <View key={job.jobId} style={b.job}>
                    <View style={b.row}>
                      <Text style={b.grey}>{job.date ? auDate(job.date) : "—"} · {job.orderNumber}</Text>
                      <Text style={b.text}>{cash(job.total)}</Text>
                    </View>
                    {job.items.map((item, index) => (
                      <View key={`${job.jobId}-${index}`} style={b.itemRow}>
                        <Text style={b.grey}>{item.description}</Text>
                        <Text style={b.grey}>{Number(item.quantity).toLocaleString("en-AU")}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            ))}

            {breakdown.totals.length > 0 ? (
              <View style={b.totals} wrap={false}>
                <Text style={b.head}>Total for the period</Text>
                {breakdown.totals.map((total) => (
                  <View key={total.key} style={b.row}>
                    <Text style={b.text}>{total.description}</Text>
                    <Text style={b.text}>{Number(total.quantity).toLocaleString("en-AU")}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        <DocFooter numberLabel="Invoice" number={invoice.invoice_number} />
      </Page>
    </Document>
  );
}
