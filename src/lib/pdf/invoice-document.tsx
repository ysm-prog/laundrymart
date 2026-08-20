/**
 * The tax-invoice PDF (spec §7.14, §18).
 *
 * Until now the invoice page was print-styled and the browser's own dialog did
 * the work, which is fine for a person looking at a screen and useless for an
 * attachment. This renders the same document server-side so a customer, a
 * mailbox and an auditor all get identical bytes.
 *
 * Deliberately uses the PDF standard fonts rather than registering a web font:
 * font registration fetches over the network at render time, which would make
 * invoicing fail whenever a font CDN did.
 *
 * ATO wording matters here. Where GST applies, the document has to say "Tax
 * invoice" and show the GST amount separately — both are below, driven by the
 * tenant's own GST rate rather than hard-coded.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import { CHARGE_TYPE_LABELS } from "@/lib/domain/pricing";
import type { InvoicePdfData } from "./invoice-data";

const styles = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, color: "#111827", paddingTop: 40, paddingBottom: 56, paddingHorizontal: 44 },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20 },
  brand: { fontFamily: "Helvetica-Bold", fontSize: 18 },
  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 14, textAlign: "right" },
  muted: { color: "#6b7280" },
  text: { fontSize: 9, lineHeight: 1.5, color: "#374151" },
  bold: { fontFamily: "Helvetica-Bold" },
  right: { textAlign: "right" },
  divider: { borderBottomWidth: 1, borderBottomColor: "#e5e7eb", marginVertical: 10 },
  columns: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  label: { fontSize: 8, letterSpacing: 0.6, color: "#6b7280", marginBottom: 3 },
  tableHeader: { flexDirection: "row", backgroundColor: "#f3f4f6", paddingVertical: 5, paddingHorizontal: 6 },
  tableRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  colDescription: { flex: 4 },
  colType: { flex: 1.6 },
  colNumber: { flex: 1.2, textAlign: "right" },
  colAmount: { flex: 1.4, textAlign: "right" },
  totals: { marginTop: 12, alignSelf: "flex-end", width: 220 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grandTotal: { flexDirection: "row", justifyContent: "space-between", paddingTop: 5, marginTop: 4, borderTopWidth: 1, borderTopColor: "#111827" },
  notes: { marginTop: 22 },
  breakdown: { marginTop: 22 },
  breakdownWeek: { marginTop: 8 },
  breakdownWeekHead: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#e5e7eb", paddingBottom: 2 },
  breakdownJob: { marginTop: 3, paddingLeft: 6 },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between" },
  breakdownItemRow: { flexDirection: "row", justifyContent: "space-between", paddingLeft: 10 },
  breakdownTotals: { marginTop: 10, padding: 6, backgroundColor: "#f3f4f6" },
  footer: { position: "absolute", bottom: 28, left: 44, right: 44, fontSize: 8, color: "#6b7280", textAlign: "center" },
  voided: { marginTop: 10, padding: 6, backgroundColor: "#fef2f2", color: "#991b1b", fontFamily: "Helvetica-Bold" },
});

function auDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const { tenant, customer, invoice, lines, breakdown } = data;
  const currency = invoice.currency || "AUD";
  const cash = (value: number) => formatMoney(Number(value ?? 0), currency);
  const gstPercent = Math.round(tenant.gstRate * 1000) / 10;

  // "Tax invoice" is only the correct heading when GST is actually charged.
  const heading = Number(invoice.tax_amount) > 0 ? "TAX INVOICE" : "INVOICE";

  return (
    <Document title={`${heading} ${invoice.invoice_number}`} author={tenant.name}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{tenant.name}</Text>
            {tenant.abn ? <Text style={styles.text}>ABN {tenant.abn}</Text> : null}
          </View>
          <View>
            <Text style={styles.docTitle}>{heading}</Text>
            <Text style={[styles.text, styles.right]}>{invoice.invoice_number}</Text>
            <Text style={[styles.text, styles.right, styles.muted]}>
              Issued {auDate(invoice.issue_date)}
            </Text>
            <Text style={[styles.text, styles.right, styles.muted]}>
              Due {auDate(invoice.due_date)}
            </Text>
          </View>
        </View>

        {invoice.status === "void" ? (
          <Text style={styles.voided}>This invoice has been voided and is not payable.</Text>
        ) : null}

        <View style={styles.divider} />

        <View style={styles.columns}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>BILL TO</Text>
            <Text style={[styles.text, styles.bold]}>{customer.business_name}</Text>
            {customer.abn ? <Text style={styles.text}>ABN {customer.abn}</Text> : null}
            {customer.address.map((line) => (
              <Text key={line} style={styles.text}>{line}</Text>
            ))}
          </View>
          <View style={{ flex: 1, paddingLeft: 20 }}>
            <Text style={styles.label}>DETAILS</Text>
            <Text style={styles.text}>Customer {customer.customer_number}</Text>
            {invoice.period_start ? (
              <Text style={styles.text}>
                Period {auDate(invoice.period_start)} – {auDate(invoice.period_end)}
              </Text>
            ) : null}
            <Text style={styles.text}>Terms {invoice.payment_terms_days} days</Text>
            {invoice.purchase_order_number ? (
              <Text style={styles.text}>PO {invoice.purchase_order_number}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={[styles.text, styles.bold, styles.colDescription]}>Description</Text>
          <Text style={[styles.text, styles.bold, styles.colType]}>Charge</Text>
          <Text style={[styles.text, styles.bold, styles.colNumber]}>Qty</Text>
          <Text style={[styles.text, styles.bold, styles.colNumber]}>Unit</Text>
          <Text style={[styles.text, styles.bold, styles.colAmount]}>Amount</Text>
        </View>

        {lines.length === 0 ? (
          <View style={styles.tableRow}>
            <Text style={[styles.text, styles.muted]}>No lines on this invoice.</Text>
          </View>
        ) : (
          lines.map((line, index) => (
            <View key={`${line.description}-${index}`} style={styles.tableRow} wrap={false}>
              <Text style={[styles.text, styles.colDescription]}>
                {line.description}{line.taxable ? "" : " (GST free)"}
              </Text>
              <Text style={[styles.text, styles.colType]}>
                {CHARGE_TYPE_LABELS[line.charge_type] ?? line.charge_type}
              </Text>
              <Text style={[styles.text, styles.colNumber]}>{Number(line.quantity)}</Text>
              <Text style={[styles.text, styles.colNumber]}>{cash(line.unit_price)}</Text>
              <Text style={[styles.text, styles.colAmount]}>{cash(line.amount)}</Text>
            </View>
          ))
        )}

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.text}>Subtotal</Text>
            <Text style={styles.text}>{cash(invoice.subtotal)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.text}>GST ({gstPercent}%)</Text>
            <Text style={styles.text}>{cash(invoice.tax_amount)}</Text>
          </View>
          <View style={styles.grandTotal}>
            <Text style={[styles.text, styles.bold]}>Total</Text>
            <Text style={[styles.text, styles.bold]}>{cash(invoice.total)}</Text>
          </View>
          {Number(invoice.amount_paid) > 0 ? (
            <>
              <View style={styles.totalRow}>
                <Text style={styles.text}>Paid</Text>
                <Text style={styles.text}>{cash(invoice.amount_paid)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={[styles.text, styles.bold]}>Balance due</Text>
                <Text style={[styles.text, styles.bold]}>{cash(invoice.balance)}</Text>
              </View>
            </>
          ) : null}
        </View>

        {/* The audit trail behind a rolled-up invoice. Rendered only when the
            invoice really covers several jobs — on a per-job invoice the lines
            above already are the detail, and repeating them reads as an error. */}
        {breakdown.jobCount > 1 ? (
          <View style={styles.breakdown} break={breakdown.weeks.length > 3}>
            <Text style={styles.label}>SERVICE BREAKDOWN</Text>
            <Text style={[styles.text, styles.muted]}>
              What was processed on this invoice — {breakdown.jobCount} jobs.
            </Text>
            {breakdown.weeks.map((week) => (
              <View key={week.weekStart ?? "undated"} style={styles.breakdownWeek} wrap={false}>
                <View style={styles.breakdownWeekHead}>
                  <Text style={[styles.text, styles.bold]}>
                    {week.weekStart ? `Week of ${week.weekStart}` : "No completion date"}
                  </Text>
                  <Text style={[styles.text, styles.bold]}>{cash(week.total)}</Text>
                </View>
                {week.jobs.map((job) => (
                  <View key={job.jobId} style={styles.breakdownJob}>
                    <View style={styles.breakdownRow}>
                      <Text style={[styles.text, styles.muted]}>
                        {job.date ?? "—"} · {job.orderNumber}
                      </Text>
                      <Text style={styles.text}>{cash(job.total)}</Text>
                    </View>
                    {job.items.map((item, index) => (
                      <View key={`${job.jobId}-${index}`} style={styles.breakdownItemRow}>
                        <Text style={[styles.text, styles.muted]}>{item.description}</Text>
                        <Text style={[styles.text, styles.muted]}>
                          {Number(item.quantity).toLocaleString("en-AU")}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            ))}

            {breakdown.totals.length > 0 ? (
              <View style={styles.breakdownTotals} wrap={false}>
                <Text style={[styles.text, styles.bold]}>Total for the period</Text>
                {breakdown.totals.map((total) => (
                  <View key={total.key} style={styles.breakdownRow}>
                    <Text style={styles.text}>{total.description}</Text>
                    <Text style={styles.text}>
                      {Number(total.quantity).toLocaleString("en-AU")}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {invoice.notes ? (
          <View style={styles.notes}>
            <Text style={styles.label}>NOTES</Text>
            <Text style={styles.text}>{invoice.notes}</Text>
          </View>
        ) : null}

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${invoice.invoice_number} · ${tenant.name} · page ${pageNumber} of ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}
