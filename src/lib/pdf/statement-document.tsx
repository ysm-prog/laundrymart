/**
 * A customer's statement, on the same page as their invoices
 * (`standard-layout.tsx`): title and logo, the addresses, a summary strip, a table,
 * the Bank Deposit block and the total. What it says comes from
 * `lib/domain/statement.ts`; this only draws it.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatMoney } from "@/lib/domain/pricing";
import { bankDepositLines, formatAbn, type InvoiceProfile } from "@/lib/domain/invoice-profile";
import { AGING_BUCKETS, AGING_LABELS } from "@/lib/domain/receivables";
import type { Statement } from "@/lib/domain/statement";
import { longDate } from "./line-display";
import {
  Addresses, DocFooter, DocHeader, LowerBlock, SummaryStrip, formatAmount, s, type Party,
} from "./standard-layout";
import type { PdfLogo } from "./logo";

export type StatementPdfData = {
  tenant: { name: string; abn: string | null; profile: InvoiceProfile; logo?: PdfLogo | null };
  customer: {
    id: string;
    business_name: string;
    customer_number: string;
    abn: string | null;
    billing_email: string | null;
    address: string[];
    contact_name?: string | null;
    phone?: string | null;
  };
  statement: Statement;
};

const COLUMNS = {
  date: { width: 62 },
  number: { width: 72 },
  reference: { flexGrow: 1, flexShrink: 1, paddingRight: 8 },
  due: { width: 62 },
  money: { width: 58, textAlign: "right" as const },
};

const b = StyleSheet.create({
  ageing: { flexDirection: "row", marginTop: 14 },
  ageCell: { flexGrow: 1, flexBasis: 0, paddingRight: 8 },
  ageLabel: { fontSize: 7.5, color: "#404040", marginBottom: 2 },
  ageValue: { fontFamily: "Helvetica-Bold", fontSize: 9 },
});

export function StatementDocument({ data }: { data: StatementPdfData }) {
  const { tenant, customer, statement } = data;
  const cash = (value: number) => formatMoney(value, "AUD");
  const { profile } = tenant;

  const billTo: Party = {
    contact: customer.contact_name,
    business: customer.business_name,
    lines: customer.address,
    details: [
      customer.billing_email,
      customer.phone,
      customer.abn ? `ABN: ${formatAbn(customer.abn)}` : null,
    ].filter((line): line is string => Boolean(line)),
  };

  const notes = statement.excluded.count > 0
    ? [`This statement lists invoices from ${longDate(statement.trustedFrom)}. Please contact us if you would like details of anything earlier.`]
    : [];

  return (
    <Document title={`Statement ${customer.customer_number}`} author={tenant.name}>
      <Page size="A4" style={s.page}>
        <DocHeader title="Statement" logo={tenant.logo} />
        <Addresses billTo={billTo} business={{
          name: tenant.name, abn: tenant.abn, addressLines: profile.addressLines,
          phone: profile.phone, email: profile.email, website: profile.website,
        }} />
        <SummaryStrip columns={[
          { label: "Amount due", value: cash(statement.total), strong: true },
          { label: "Overdue", value: cash(statement.overdue), strong: true },
          { label: "Statement date", value: longDate(statement.asAt) },
          { label: "Account", value: customer.customer_number },
        ]} />

        <View>
          <View style={s.heavyRule} />
          <View style={s.head}>
            <Text style={[s.headCell, COLUMNS.date]}>Date</Text>
            <Text style={[s.headCell, COLUMNS.number]}>Invoice</Text>
            <Text style={[s.headCell, COLUMNS.reference]}>Reference</Text>
            <Text style={[s.headCell, COLUMNS.due]}>Due date</Text>
            <Text style={[s.headCell, COLUMNS.money]}>Total</Text>
            <Text style={[s.headCell, COLUMNS.money]}>Paid</Text>
            <Text style={[s.headCell, COLUMNS.money]}>Credited</Text>
            <Text style={[s.headCell, COLUMNS.money]}>Balance</Text>
          </View>
          {statement.rows.length === 0 ? (
            <View style={s.row}><Text style={s.cell}>Nothing is outstanding on this account.</Text></View>
          ) : statement.rows.map((row) => (
            <View key={row.id} style={s.row} wrap={false}>
              <Text style={[s.cell, COLUMNS.date]}>{longDate(row.issueDate)}</Text>
              <Text style={[s.cell, COLUMNS.number]}>{row.invoiceNumber}</Text>
              <Text style={[s.cell, COLUMNS.reference]}>{row.reference ?? ""}</Text>
              <Text style={[s.cell, COLUMNS.due]}>{longDate(row.dueDate)}</Text>
              <Text style={[s.cell, COLUMNS.money]}>{formatAmount(row.total)}</Text>
              <Text style={[s.cell, COLUMNS.money]}>{row.paid ? formatAmount(row.paid) : ""}</Text>
              <Text style={[s.cell, COLUMNS.money]}>{row.credited ? formatAmount(row.credited) : ""}</Text>
              <Text style={[s.cell, COLUMNS.money]}>{formatAmount(row.balance)}</Text>
            </View>
          ))}
        </View>

        <View style={b.ageing} wrap={false}>
          {AGING_BUCKETS.map((bucket) => (
            <View key={bucket} style={b.ageCell}>
              <Text style={b.ageLabel}>{AGING_LABELS[bucket]}</Text>
              <Text style={b.ageValue}>{cash(statement.buckets[bucket])}</Text>
            </View>
          ))}
        </View>

        <LowerBlock
          sections={statement.total > 0 ? [bankDepositLines(profile)] : []}
          notes={notes}
          totals={[{ label: "Amount due", value: cash(statement.total), strong: true }]}
        />
        <DocFooter numberLabel="Statement" number={customer.customer_number} />
      </Page>
    </Document>
  );
}
