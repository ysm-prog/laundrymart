/**
 * The credit-note PDF. A credit note is a document the customer is sent and
 * keeps, so it gets its own file rather than living only as a row on the
 * invoice page (2026-10-12). Same fonts and the same "no ledger codes on a
 * customer's copy" rule as the invoice.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import { formatAbn } from "@/lib/domain/invoice-profile";
import type { CreditNotePdfData } from "./credit-note-data";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, color: "#111827", padding: 44 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  brand: { fontFamily: "Helvetica-Bold", fontSize: 18 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 14, textAlign: "right" },
  text: { fontSize: 9, lineHeight: 1.5, color: "#374151" },
  muted: { color: "#6b7280" },
  bold: { fontFamily: "Helvetica-Bold" },
  label: { fontSize: 8, letterSpacing: 0.6, color: "#6b7280", marginBottom: 3, marginTop: 14 },
  head: { flexDirection: "row", backgroundColor: "#f3f4f6", padding: 5, marginTop: 16 },
  line: { flexDirection: "row", padding: 5, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  desc: { flex: 4 }, num: { flex: 1.4, textAlign: "right" },
  totals: { marginTop: 12, alignSelf: "flex-end", width: 220 },
  void: { marginTop: 10, padding: 6, backgroundColor: "#fef2f2", color: "#991b1b", fontFamily: "Helvetica-Bold" },
});

function auDate(value: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

export function CreditNoteDocument({ data }: { data: CreditNotePdfData }) {
  const { tenant, customer, note, lines } = data;
  const cash = (v: number) => formatMoney(Number(v ?? 0));
  const heading = Number(note.tax_amount) > 0 ? "ADJUSTMENT NOTE" : "CREDIT NOTE";
  return (
    <Document title={`${heading} ${note.credit_note_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <View style={s.row}>
          <View>
            <Text style={s.brand}>{tenant.name}</Text>
            {tenant.abn ? <Text style={s.text}>ABN {formatAbn(tenant.abn)}</Text> : null}
            {tenant.profile.addressLines.map((l) => <Text key={l} style={s.text}>{l}</Text>)}
          </View>
          <View>
            <Text style={s.title}>{heading}</Text>
            <Text style={[s.text, { textAlign: "right" }]}>{note.credit_note_number}</Text>
            <Text style={[s.text, s.muted, { textAlign: "right" }]}>Issued {auDate(note.issue_date)}</Text>
            <Text style={[s.text, s.muted, { textAlign: "right" }]}>Against invoice {note.invoice_number}</Text>
          </View>
        </View>
        {note.status === "void" ? <Text style={s.void}>This credit note has been voided.</Text> : null}

        <Text style={s.label}>CREDITED TO</Text>
        <Text style={[s.text, s.bold]}>{customer.business_name}</Text>
        {customer.abn ? <Text style={s.text}>ABN {formatAbn(customer.abn)}</Text> : null}
        {customer.address.map((l) => <Text key={l} style={s.text}>{l}</Text>)}

        {note.reason ? (<><Text style={s.label}>REASON</Text><Text style={s.text}>{note.reason}</Text></>) : null}

        <View style={s.head}>
          <Text style={[s.text, s.bold, s.desc]}>Description</Text>
          <Text style={[s.text, s.bold, s.num]}>Amount</Text>
        </View>
        {lines.map((line, i) => (
          <View key={i} style={s.line}>
            <Text style={[s.text, s.desc]}>{line.description}{line.taxable ? "" : " (GST free)"}</Text>
            <Text style={[s.text, s.num]}>{cash(line.amount)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.row}><Text style={[s.text, s.bold]}>Total credited (inc GST)</Text><Text style={[s.text, s.bold]}>{cash(note.total)}</Text></View>
          <View style={s.row}><Text style={[s.text, s.muted]}>Includes GST of</Text><Text style={[s.text, s.muted]}>{cash(note.tax_amount)}</Text></View>
        </View>
      </Page>
    </Document>
  );
}
