/**
 * The page every customer document is drawn on: the invoice ATS's customers now
 * receive from Xero, `INV-0015359` (Standard branding theme), which Jaimin sent
 * as the template on 2026-11-02.
 *
 * Title top-left and logo top-right; Bill to, Ship to and the business's details
 * in three columns; an Amount due / Due date / Issue date / Invoice number strip;
 * a heavy rule over **Item Code | Description | Quantity | Price | Tax | Amount**;
 * Subtotal, "Includes GST 10% of", Total and Amount due on the right; the Bank
 * Deposit block on the left; a heavy rule along the foot.
 *
 * Xero's "View and pay online", its QR code and its card logos are left out: they
 * are Xero's hosted payment page, which an invoice from this app has no link to.
 *
 * Standard PDF fonts only (Helvetica and its bold), as before: registering a web
 * font fetches at render time, and invoicing must not fail because a font CDN did.
 *
 * Nothing here decides money or wording. The callers decide what the title is,
 * which lines print and what the totals are; this draws them.
 */

import { Font, Image, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ViewProps } from "@react-pdf/renderer";
import { formatAbn } from "@/lib/domain/invoice-profile";
import type { PdfLogo } from "./logo";

const INK = "#000000";
const MUTED = "#404040";
const RULE = "#BDBDBD";

// A hyphenated BSB, account name or customer name reads as a typo on a document
// somebody pays from, so words wrap whole. Global to the renderer, which only
// ever draws these documents.
Font.registerHyphenationCallback((word) => [word]);

export const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica", fontSize: 8.5, color: INK,
    paddingTop: 36, paddingBottom: 54, paddingHorizontal: 36,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", minHeight: 62 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 15 },
  logo: { width: 104, height: 62, objectFit: "contain", objectPosition: "right top" },

  addresses: { flexDirection: "row", marginTop: 12, minHeight: 74 },
  billTo: { marginLeft: 56, width: 158, paddingRight: 10 },
  shipTo: { width: 148, paddingRight: 10 },
  business: { flexGrow: 1, flexShrink: 1, alignItems: "flex-end" },
  addressHead: { fontFamily: "Helvetica-Bold", fontSize: 8, marginBottom: 2 },
  addressLine: { fontSize: 8, lineHeight: 1.3 },
  addressGap: { marginTop: 4 },
  businessLine: { fontSize: 8, lineHeight: 1.3, textAlign: "right" },

  strip: { flexDirection: "row", marginTop: 12 },
  stripColumn: { marginRight: 26 },
  stripLabel: { fontSize: 7.5, color: MUTED, marginBottom: 2 },
  stripStrong: { fontFamily: "Helvetica-Bold", fontSize: 11.5 },
  stripValue: { fontFamily: "Helvetica-Bold", fontSize: 9, marginTop: 2 },

  banner: {
    marginTop: 8, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: "#FDECEC",
    color: "#991B1B", fontFamily: "Helvetica-Bold", fontSize: 9,
  },

  heavyRule: { marginTop: 12, height: 1.75, backgroundColor: INK },
  head: {
    flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4,
    borderBottomWidth: 0.75, borderBottomColor: RULE,
  },
  headCell: { fontSize: 7.5, color: MUTED },
  row: {
    flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4,
    borderBottomWidth: 0.75, borderBottomColor: RULE,
  },
  cell: { fontSize: 8.5 },

  lower: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  notes: { width: 300 },
  noteHead: { fontSize: 8, lineHeight: 1.35 },
  noteLine: { fontSize: 8, lineHeight: 1.35 },
  noteGap: { marginTop: 8 },
  totals: { width: 150 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, paddingHorizontal: 4 },
  totalLabel: { fontSize: 8.5 },
  totalValue: { fontSize: 8.5 },
  totalNote: { fontSize: 7, color: MUTED, paddingHorizontal: 4, marginTop: -1, marginBottom: 3 },
  totalRule: { height: 0.75, backgroundColor: RULE, marginVertical: 2 },
  dueLabel: { fontSize: 8.5, fontFamily: "Helvetica-Bold" },
  dueValue: { fontSize: 12, fontFamily: "Helvetica-Bold" },

  footer: { position: "absolute", bottom: 22, left: 36, right: 36 },
  footerRule: { height: 1.75, backgroundColor: INK },
  footerText: {
    flexDirection: "row", justifyContent: "space-between", marginTop: 4, fontSize: 7, color: MUTED,
  },
});

/** The table's columns, widest last-but-flexing: the page is 523pt inside its margins. */
export const COLUMNS = {
  itemCode: { width: 62 },
  description: { flexGrow: 1, flexShrink: 1, paddingRight: 8 },
  quantity: { width: 56, textAlign: "right" as const },
  price: { width: 56, textAlign: "right" as const },
  tax: { width: 40, textAlign: "right" as const },
  amount: { width: 60, textAlign: "right" as const },
};

export type Business = {
  name: string;
  abn: string | null;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  website: string | null;
  logo?: PdfLogo | null;
};

/** The document's title on the left, the laundry's logo on the right. */
export function DocHeader({ title, logo }: { title: string; logo?: PdfLogo | null }) {
  return (
    <View style={s.header}>
      <Text style={s.title}>{title}</Text>
      <View>
        {logo ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- a react-pdf Image takes no alt
          <Image style={s.logo} src={{ data: logo.data, format: logo.format }} />
        ) : null}
      </View>
    </View>
  );
}

export type Party = {
  /** The person it is for, printed "Attn: Sam Barca". */
  contact?: string | null;
  business: string;
  lines: string[];
  /** Email, phone and ABN, set a little apart under the address. */
  details?: string[];
};

function Address({ heading, party, style }: { heading: string; party: Party; style: ViewProps["style"] }) {
  return (
    <View style={style}>
      <Text style={s.addressHead}>{heading}</Text>
      {party.contact ? <Text style={s.addressLine}>Attn: {party.contact}</Text> : null}
      <Text style={s.addressLine}>{party.business}</Text>
      {party.lines.map((line, index) => (
        <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>
      ))}
      {party.details?.length ? (
        <View style={s.addressGap}>
          {party.details.map((line, index) => (
            <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Bill to, Ship to, and the business's details right-aligned. Ship to is optional. */
export function Addresses({ billTo, shipTo, business }: {
  billTo: Party; shipTo?: Party | null; business: Business;
}) {
  return (
    <View style={s.addresses}>
      <Address heading="Bill to" party={billTo} style={s.billTo} />
      {shipTo ? <Address heading="Ship to" party={shipTo} style={s.shipTo} /> : <View style={s.shipTo} />}
      <View style={s.business}>
        <Text style={s.businessLine}>{business.name}</Text>
        {business.addressLines.map((line, index) => (
          <Text key={`${line}-${index}`} style={s.businessLine}>{line}</Text>
        ))}
        <View style={s.addressGap}>
          {business.abn ? <Text style={s.businessLine}>ABN: {formatAbn(business.abn)}</Text> : null}
          {business.email ? <Text style={s.businessLine}>{business.email}</Text> : null}
          {business.phone ? <Text style={s.businessLine}>{business.phone}</Text> : null}
          {business.website ? <Text style={s.businessLine}>{business.website}</Text> : null}
        </View>
      </View>
    </View>
  );
}

export type StripColumn = { label: string; value: string; strong?: boolean };

/** Amount due, Due date, Issue date, Invoice number, and anything else worth a column. */
export function SummaryStrip({ columns }: { columns: StripColumn[] }) {
  return (
    <View style={s.strip}>
      {columns.map((column) => (
        <View key={column.label} style={s.stripColumn}>
          <Text style={s.stripLabel}>{column.label}</Text>
          <Text style={column.strong ? s.stripStrong : s.stripValue}>{column.value}</Text>
        </View>
      ))}
    </View>
  );
}

export type TableLine = {
  itemId: string; description: string; qty: string; unitPrice: string; tax: string; amount: string;
};

/** The heavy rule, the column headings, and one row per line. */
export function LineTable({ lines, empty }: { lines: TableLine[]; empty: string }) {
  return (
    <View>
      <View style={s.heavyRule} />
      <View style={s.head} fixed={false}>
        <Text style={[s.headCell, COLUMNS.itemCode]}>Item Code</Text>
        <Text style={[s.headCell, COLUMNS.description]}>Description</Text>
        <Text style={[s.headCell, COLUMNS.quantity]}>Quantity</Text>
        <Text style={[s.headCell, COLUMNS.price]}>Price</Text>
        <Text style={[s.headCell, COLUMNS.tax]}>Tax</Text>
        <Text style={[s.headCell, COLUMNS.amount]}>Amount</Text>
      </View>
      {lines.length === 0 ? (
        <View style={s.row}><Text style={s.cell}>{empty}</Text></View>
      ) : lines.map((line, index) => (
        <View key={`${line.itemId}-${line.description}-${index}`} style={s.row} wrap={false}>
          <Text style={[s.cell, COLUMNS.itemCode]}>{line.itemId}</Text>
          <Text style={[s.cell, COLUMNS.description]}>{line.description}</Text>
          <Text style={[s.cell, COLUMNS.quantity]}>{line.qty}</Text>
          <Text style={[s.cell, COLUMNS.price]}>{line.unitPrice}</Text>
          <Text style={[s.cell, COLUMNS.tax]}>{line.tax}</Text>
          <Text style={[s.cell, COLUMNS.amount]}>{line.amount}</Text>
        </View>
      ))}
    </View>
  );
}

export type TotalRow = {
  label: string; value: string;
  /** Small print under the row above, like "Includes GST 10% of 7.29". */
  note?: boolean;
  /** A rule above this row. */
  rule?: boolean;
  /** The final figure, large and bold. */
  strong?: boolean;
};

/** The bank details and notes on the left; the totals on the right. */
export function LowerBlock({ notes, sections, totals }: {
  /** The lines of the Bank Deposit block; empty on a document nobody pays. */
  sections: string[][];
  notes?: string[];
  totals: TotalRow[];
}) {
  return (
    <View style={s.lower} wrap={false}>
      <View style={s.notes}>
        {sections.map((lines, sectionIndex) => (
          <View key={sectionIndex} style={sectionIndex === 0 ? {} : s.noteGap}>
            {lines.map((line, index) => (
              <Text key={`${line}-${index}`} style={s.noteLine}>{line}</Text>
            ))}
          </View>
        ))}
        {notes?.length ? (
          <View style={sections.length ? s.noteGap : {}}>
            {notes.map((note, index) => (
              <Text key={`${note}-${index}`} style={s.noteLine}>{note}</Text>
            ))}
          </View>
        ) : null}
      </View>
      <View style={s.totals}>
        {totals.map((row) => row.note ? (
          <Text key={row.label} style={s.totalNote}>{row.label} {row.value}</Text>
        ) : (
          <View key={row.label}>
            {row.rule ? <View style={s.totalRule} /> : null}
            <View style={[s.totalRow, row.strong ? { alignItems: "center" } : {}]}>
              <Text style={row.strong ? s.dueLabel : s.totalLabel}>{row.label}</Text>
              <Text style={row.strong ? s.dueValue : s.totalValue}>{row.value}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The heavy rule along the foot of every page, with the page count and the number under it. */
export function DocFooter({ numberLabel, number }: { numberLabel: string; number: string }) {
  return (
    <View style={s.footer} fixed>
      <View style={s.footerRule} />
      <View style={s.footerText}>
        <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        <Text>{`${numberLabel} ${number}`}</Text>
      </View>
    </View>
  );
}

/** A quantity as the table prints it: `100`, `2.5`. */
export function formatQty(value: number): string {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString("en-AU", { maximumFractionDigits: 3 });
}

/** A table amount without the dollar sign: `0.35`, `1,234.50`. */
export function formatAmount(value: number, maxDecimals = 2): string {
  return Number(value ?? 0).toLocaleString("en-AU", {
    minimumFractionDigits: 2, maximumFractionDigits: maxDecimals,
  });
}
