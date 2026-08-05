/**
 * Server-side PDF rendering.
 *
 * Kept apart from the templates so the one `@react-pdf/renderer` import that
 * touches Node streams lives in a single place — it is listed in
 * `serverExternalPackages`, and a stray import from a client component is a
 * build failure that is much easier to spot with one entry point.
 */

import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { InvoiceDocument } from "./invoice-document";
import type { InvoicePdfData } from "./invoice-data";

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  // renderToBuffer is typed against the <Document> element rather than the
  // component that returns one, so the wrapper has to be re-stated here.
  const document = createElement(InvoiceDocument, { data }) as ReactElement<DocumentProps>;
  return Buffer.from(await renderToBuffer(document));
}

/** `INV00042.pdf` — safe on every filesystem and readable in a mail client. */
export function invoiceFileName(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "") || "invoice"}.pdf`;
}
