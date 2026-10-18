/**
 * The tax-invoice PDF (spec §7.14, §18), drawn to the layout of the laundry's
 * own MYOB invoice (brief 1.10, template `Invoice-00321043.pdf`).
 *
 * Rendered server-side so a customer, a mailbox and an auditor all get
 * identical bytes. The page is built from `myob-layout.tsx`, which the credit
 * note shares, so the two documents a customer keeps are drawn one way.
 *
 * The data rules did not move with the layout:
 *  - **Line amounts are GST-inclusive** (0043), so the money columns say
 *    "including tax" and the Tax row is the GST *within* the total, not added
 *    to it.
 *  - "Tax invoice" only where GST is charged (the ATO's wording), "Draft
 *    invoice" on a draft, "Adjustment note" on a credit (`invoiceDocumentTitle`).
 *  - The void banner stays.
 *  - **No ledger code and no internal charge type** (2026-10-12): `4-1100` and
 *    "Wash only" are the laundry's bookkeeping vocabulary. The Item ID column is
 *    the *item* code the customer also uses (`T35`), never the GL code.
 *  - The payment line is built from the invoice profile Darshan fills in on
 *    Settings › Invoicing — never written here.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import {
  bankingDetailsLine, formatAbn, invoiceTotalsRows,
} from "@/lib/domain/invoice-profile";
import { auDate, invoiceDocumentTitle, pdfLineCells } from "./line-display";
import {
  BillToRow, DocFooter, DocHeader, LineTable, NotesAndTotals, TitleRow,
  formatAmount, formatQty, s,
  type Detail, type TableLine, type TotalRow,
} from "./myob-layout";
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
  const title = invoiceDocumentTitle(invoice);
  const isCredit = invoice.invoice_type === "credit" || Number(invoice.total) < 0;

  const tableLines: TableLine[] = lines.map((line) => {
    const cells = pdfLineCells(line);
    return {
      ...cells,
      qty: formatQty(line.quantity),
      unitPrice: formatAmount(line.unit_price, 4),
      amount: formatAmount(line.amount),
    };
  });

  // A draft can still change and a void is not payable; a credit is money owed
  // the other way. None of them carries a way to pay.
  const payable = invoice.status !== "draft" && invoice.status !== "void" && !isCredit;
  const banking = payable ? bankingDetailsLine(tenant.profile) : null;
  const notes = [
    ...(banking ? [banking, `Please quote ${invoice.invoice_number} as the payment reference.`] : []),
    ...(invoice.notes && !IMPORT_NOTE.test(invoice.notes.trim()) ? [invoice.notes.trim()] : []),
  ];

  // Paid, credited and the balance — the 0052 rows, from the same rule the
  // invoice page and the email use, so the three cannot disagree.
  const settlement: TotalRow[] = invoiceTotalsRows({
    total: invoice.total, taxAmount: invoice.tax_amount, amountPaid: invoice.amount_paid,
    amountCredited: invoice.amount_credited ?? 0, balance: invoice.balance,
  })
    .filter((row) => row.label === "Paid" || row.label === "Credited" || row.label === "Balance due")
    .map((row) => ({ label: row.label, value: cash(row.value), strong: row.strong }));

  const details: Detail[] = [
    ...(customer.customer_number ? [{ label: "Customer", value: customer.customer_number }] : []),
    ...(invoice.period_start
      ? [{ label: "Period", value: `${auDate(invoice.period_start)} – ${auDate(invoice.period_end)}` }]
      : []),
    ...(invoice.purchase_order_number ? [{ label: "Your order", value: invoice.purchase_order_number }] : []),
    { label: "Terms", value: `${invoice.payment_terms_days} days` },
  ];

  return (
    <Document title={`${title} ${invoice.invoice_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <DocHeader business={{
          name: tenant.name, abn: tenant.abn, addressLines: tenant.profile.addressLines,
          phone: tenant.profile.phone, email: tenant.profile.email,
          website: tenant.profile.website, logo: tenant.logo ?? null,
        }} />

        <TitleRow title={title} columns={[
          { label: "Invoice number", value: invoice.invoice_number, strong: true },
          { label: "Issue date", value: invoice.status === "draft" ? "Not issued yet" : auDate(invoice.issue_date) },
          ...(invoice.due_date && !isCredit ? [{ label: "Due date", value: auDate(invoice.due_date) }] : []),
        ]} />

        {invoice.status === "void" ? (
          <Text style={s.banner}>This invoice has been voided and is not payable.</Text>
        ) : null}

        <BillToRow
          billTo={{
            contact: customer.contact_name ?? null,
            business: customer.business_name,
            lines: [
              ...customer.address,
              ...(customer.abn ? [`ABN: ${formatAbn(customer.abn)}`] : []),
            ],
          }}
          details={details}
        />

        <LineTable lines={tableLines} empty="No lines on this invoice." />

        <NotesAndTotals
          notes={notes}
          tax={cash(invoice.tax_amount)}
          total={cash(invoice.total)}
          after={settlement}
        />

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
                    {week.weekStart ? `Week of ${auDate(week.weekStart)}` : "No completion date"}
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

        <DocFooter numberLabel="Invoice no" number={invoice.invoice_number} total={cash(invoice.total)} />
      </Page>
    </Document>
  );
}
