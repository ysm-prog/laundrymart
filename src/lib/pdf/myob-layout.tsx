/**
 * The page the laundry's own MYOB invoice draws (brief 1.10, template
 * `Invoice-00321043.pdf`), as one set of building blocks the tax invoice and the
 * adjustment note both use — so the two documents a customer keeps are the same
 * document twice, and a change to one reaches the other.
 *
 * Measured off the template rather than eyeballed: A4, 20pt margins, the business
 * block right-aligned at the top beside the logo, the title row at ~133pt, a grey
 * rounded Bill-to panel indented 46pt, a 4pt black rule, a 39pt grey header band
 * whose money columns say "including tax", a Notes block beside a Tax row and a
 * Total amount in a grey box, and `Page n of N` / `Invoice no … Total amount …`
 * in the footer of every page. Positions are in points; the template's text
 * boxes were read with `pdftotext -bbox` and its fills sampled from a render.
 *
 * Standard PDF fonts only (Helvetica and its bold and oblique), as before:
 * registering a web font fetches at render time, and invoicing must not fail
 * because a font CDN did.
 *
 * Nothing here decides money or wording. The callers decide what the title is,
 * which lines print and what the totals are; this draws them.
 */

import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatAbn } from "@/lib/domain/invoice-profile";
import type { PdfLogo } from "./logo";

const INK = "#000000";
const FOOTER_INK = "#404040";
const BAND = "#EEEEEE";
const PANEL = "#ECECEC";
const RULE = "#E3E3E3";

/** Column edges of the line table, in points from the page's left edge (template). */
const COL = {
  itemId: 76,       // 20 → 96, text at 28
  description: 264, // 96 → 360
  qty: 40.3,        // 360 → 400.3, right-aligned
  unit: 60.8,       // 400.3 → 461.1, right-aligned
  tax: 58.9,        // 461.1 → 520, text at 470.9
  amount: 55,       // 520 → 575, right-aligned
} as const;

export const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica", fontSize: 9, color: INK,
    paddingTop: 20, paddingBottom: 46, paddingHorizontal: 20,
  },
  header: { flexDirection: "row", justifyContent: "space-between", minHeight: 92 },
  logo: { width: 96, height: 90, objectFit: "contain", objectPosition: "left top" },
  business: { alignItems: "flex-end", maxWidth: 320, paddingTop: 2 },
  businessName: { fontFamily: "Helvetica-Bold", fontSize: 14, marginBottom: 6, textAlign: "right" },
  businessLine: { fontSize: 9, lineHeight: 1.15, textAlign: "right" },

  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 20 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 14 },
  metaColumns: { flexDirection: "row" },
  metaColumn: { width: 88, marginLeft: 12, alignItems: "flex-end" },
  metaLabel: { fontFamily: "Helvetica-Bold", fontSize: 10, textAlign: "right" },
  metaValue: { fontSize: 10, marginTop: 5, textAlign: "right" },
  metaValueStrong: { fontSize: 11.5, marginTop: 4, textAlign: "right" },

  banner: {
    marginTop: 8, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: "#FDECEC",
    color: "#991B1B", fontFamily: "Helvetica-Bold", fontSize: 9,
  },

  billRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  billPanel: {
    marginLeft: 46.5, width: 268, minHeight: 78, backgroundColor: PANEL, borderRadius: 6,
    paddingTop: 6, paddingBottom: 8, paddingLeft: 16, paddingRight: 12,
  },
  billItalic: { fontFamily: "Helvetica-Oblique", fontSize: 9, lineHeight: 1.2 },
  billLine: { fontSize: 9, lineHeight: 1.3 },
  details: { width: 200, paddingTop: 4 },
  detailRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 2 },
  detailLabel: { fontSize: 8.5, color: FOOTER_INK, marginRight: 6 },
  detailValue: { fontSize: 8.5, textAlign: "right" },

  thickRule: { marginTop: 9, height: 4, backgroundColor: INK },
  band: {
    flexDirection: "row", marginTop: 8.5, minHeight: 39, backgroundColor: BAND, paddingTop: 4.5,
  },
  head: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  headNote: { fontFamily: "Helvetica-Oblique", fontSize: 8, marginTop: 3 },
  row: {
    flexDirection: "row", paddingTop: 12.5, paddingBottom: 9.5,
    borderBottomWidth: 1, borderBottomColor: RULE,
  },
  cell: { fontSize: 9 },

  colItemId: { width: COL.itemId, paddingLeft: 8, paddingRight: 4 },
  colDescription: { width: COL.description, paddingLeft: 1, paddingRight: 8 },
  colQty: { width: COL.qty, textAlign: "right" },
  colUnit: { width: COL.unit, textAlign: "right" },
  colTax: { width: COL.tax, paddingLeft: 9.8 },
  colAmount: { width: COL.amount, textAlign: "right" },

  lower: { flexDirection: "row", justifyContent: "space-between", marginTop: 8.5 },
  notes: { width: 300 },
  notesHead: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  notesText: { fontSize: 9, lineHeight: 1.15, marginTop: 9 },
  totals: { width: 215 },
  totalRow: { flexDirection: "row", alignItems: "center" },
  totalLabel: { width: 88.4, textAlign: "right", fontSize: 9 },
  totalValue: { width: 126.6, textAlign: "right", fontSize: 9, paddingRight: 8 },
  grandLabel: { width: 88.4, textAlign: "right", fontFamily: "Helvetica-Bold", fontSize: 14 },
  grandBox: {
    marginLeft: 8.6, width: 118, minHeight: 23.5, backgroundColor: BAND,
    justifyContent: "center", paddingRight: 8,
  },
  grandValue: { textAlign: "right", fontFamily: "Helvetica-Bold", fontSize: 14 },
  grandNote: { width: 88.4, textAlign: "right", fontFamily: "Helvetica-Oblique", fontSize: 9, marginTop: 1 },

  footer: {
    position: "absolute", bottom: 20, left: 20, right: 20,
    flexDirection: "row", justifyContent: "space-between", fontSize: 9, color: FOOTER_INK,
  },
});

export type Business = {
  name: string;
  abn: string | null;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  website: string | null;
  logo?: PdfLogo | null;
};

/** Logo top-left; the business's name, address, phone, email, website and ABN right-aligned. */
export function DocHeader({ business }: { business: Business }) {
  return (
    <View style={s.header}>
      <View>
        {business.logo ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- a react-pdf Image takes no alt
          <Image style={s.logo} src={{ data: business.logo.data, format: business.logo.format }} />
        ) : null}
      </View>
      <View style={s.business}>
        <Text style={s.businessName}>{business.name}</Text>
        {business.addressLines.length > 0 ? (
          // The MYOB header prints the address as one line; ours may be two or
          // three, and joining them keeps the block the same height as the logo.
          <Text style={s.businessLine}>{business.addressLines.join(" ")}</Text>
        ) : null}
        {business.phone ? <Text style={s.businessLine}>Phone: {business.phone}</Text> : null}
        {business.email ? <Text style={s.businessLine}>{business.email}</Text> : null}
        {business.website ? <Text style={s.businessLine}>{business.website}</Text> : null}
        {business.abn ? <Text style={s.businessLine}>ABN: {formatAbn(business.abn)}</Text> : null}
      </View>
    </View>
  );
}

export type MetaColumn = { label: string; value: string; strong?: boolean };

/** "Tax invoice" on the left; Invoice number / Issue date / Due date on the right. */
export function TitleRow({ title, columns }: { title: string; columns: MetaColumn[] }) {
  return (
    <View style={s.titleRow}>
      <Text style={s.title}>{title}</Text>
      <View style={s.metaColumns}>
        {columns.map((column) => (
          <View key={column.label} style={s.metaColumn}>
            <Text style={s.metaLabel}>{column.label}</Text>
            <Text style={column.strong ? s.metaValueStrong : s.metaValue}>{column.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export type BillTo = { contact?: string | null; business: string; lines: string[] };
export type Detail = { label: string; value: string };

/** The grey Bill-to panel (contact and business in italics), with the small details beside it. */
export function BillToRow({ billTo, details }: { billTo: BillTo; details: Detail[] }) {
  return (
    <View style={s.billRow}>
      <View style={s.billPanel}>
        {billTo.contact ? <Text style={s.billItalic}>{billTo.contact}</Text> : null}
        <Text style={s.billItalic}>{billTo.business}</Text>
        {billTo.lines.map((line, index) => (
          <Text key={`${line}-${index}`} style={s.billLine}>{line}</Text>
        ))}
      </View>
      <View style={s.details}>
        {details.map((detail) => (
          <View key={detail.label} style={s.detailRow}>
            <Text style={s.detailLabel}>{detail.label}</Text>
            <Text style={s.detailValue}>{detail.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export type TableLine = {
  itemId: string; description: string; qty: string; unitPrice: string; tax: string; amount: string;
};

/** The thick rule, the grey header band, and one row per line. */
export function LineTable({ lines, empty }: { lines: TableLine[]; empty: string }) {
  return (
    <View>
      <View style={s.thickRule} />
      <View style={s.band} fixed={false}>
        <View style={s.colItemId}><Text style={s.head}>Item ID</Text></View>
        <View style={s.colDescription}><Text style={s.head}>Description</Text></View>
        <View style={s.colQty}><Text style={[s.head, { textAlign: "right" }]}>Qty</Text></View>
        <View style={s.colUnit}>
          <Text style={[s.head, { textAlign: "right" }]}>Unit price</Text>
          <Text style={[s.head, { textAlign: "right" }]}>($)</Text>
          <Text style={[s.headNote, { textAlign: "right", marginTop: 1 }]}>including tax</Text>
        </View>
        <View style={s.colTax}><Text style={s.head}>Tax</Text></View>
        <View style={s.colAmount}>
          <Text style={[s.head, { textAlign: "right" }]}>Amount ($)</Text>
          <Text style={[s.headNote, { textAlign: "right" }]}>including tax</Text>
        </View>
      </View>
      {lines.length === 0 ? (
        <View style={s.row}>
          <Text style={[s.cell, { paddingLeft: 8 }]}>{empty}</Text>
        </View>
      ) : lines.map((line, index) => (
        <View key={`${line.itemId}-${line.description}-${index}`} style={s.row} wrap={false}>
          <Text style={[s.cell, s.colItemId]}>{line.itemId}</Text>
          <Text style={[s.cell, s.colDescription]}>{line.description}</Text>
          <Text style={[s.cell, s.colQty]}>{line.qty}</Text>
          <Text style={[s.cell, s.colUnit]}>{line.unitPrice}</Text>
          <Text style={[s.cell, s.colTax]}>{line.tax}</Text>
          <Text style={[s.cell, s.colAmount, { paddingRight: 8 }]}>{line.amount}</Text>
        </View>
      ))}
    </View>
  );
}

export type TotalRow = { label: string; value: string; strong?: boolean };

/**
 * Notes and the payment line on the left; Tax, the boxed Total amount and any
 * paid / credited / balance rows on the right.
 */
export function NotesAndTotals({
  notes, tax, total, after = [],
}: { notes: string[]; tax: string; total: string; after?: TotalRow[] }) {
  return (
    <View style={s.lower} wrap={false}>
      <View style={s.notes}>
        {notes.length > 0 ? (
          <>
            <Text style={s.notesHead}>Notes</Text>
            {notes.map((note, index) => (
              <Text key={`${note}-${index}`} style={index === 0 ? s.notesText : [s.notesText, { marginTop: 4 }]}>
                {note}
              </Text>
            ))}
          </>
        ) : null}
      </View>
      <View style={s.totals}>
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Tax</Text>
          <Text style={s.totalValue}>{tax}</Text>
        </View>
        <View style={[s.totalRow, { marginTop: 9 }]}>
          <Text style={s.grandLabel}>Total amount</Text>
          <View style={s.grandBox}><Text style={s.grandValue}>{total}</Text></View>
        </View>
        <Text style={s.grandNote}>including tax</Text>
        {after.map((row) => (
          <View key={row.label} style={[s.totalRow, { marginTop: 5 }]}>
            <Text style={[s.totalLabel, row.strong ? { fontFamily: "Helvetica-Bold" } : {}]}>{row.label}</Text>
            <Text style={[s.totalValue, row.strong ? { fontFamily: "Helvetica-Bold" } : {}]}>{row.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** `Page n of N` on the left; the document number and its total on the right — every page. */
export function DocFooter({ numberLabel, number, total }: { numberLabel: string; number: string; total: string }) {
  return (
    <View style={s.footer} fixed>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      <Text>{`${numberLabel}: ${number}      Total amount: ${total}`}</Text>
    </View>
  );
}

/** A quantity as the MYOB table prints it: `100`, `2.5`. */
export function formatQty(value: number): string {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString("en-AU", { maximumFractionDigits: 3 });
}

/** A table amount without the dollar sign (the header carries it): `0.35`, `1,234.50`. */
export function formatAmount(value: number, maxDecimals = 2): string {
  return Number(value ?? 0).toLocaleString("en-AU", {
    minimumFractionDigits: 2, maximumFractionDigits: maxDecimals,
  });
}

export type { ReactNode };
