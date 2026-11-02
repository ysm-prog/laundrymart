import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/actions";
import {
  classifyXeroInvoice, creditRow, customerFor, historyRow, normaliseName, openingBaseNumber,
  openingRow, paidForCredit, similarCustomer, usedCredits,
  type HistoryLookups, type HistoryRow, type OpeningRow, type XeroCreditNote, type XeroInvoice,
} from "@/lib/domain/xero-history";
import { OPEN_INVOICE_STATUSES } from "@/lib/domain/statement";
import { XERO_API } from "./config";
import { summariseXeroError } from "./errors";
import { getXeroTokens } from "./tokens";

/**
 * One page of the MYOB history out of Xero, read and optionally written.
 *
 * A page rather than the whole job, because nineteen thousand invoices do not fit
 * in one request: the screen calls this in a loop, so a dropped connection costs a
 * page and the run can simply be started again. Every write is matched on the
 * invoice number and adds lines only to an invoice with none, so a second run
 * changes nothing the first one finished.
 *
 * The tenant is named on every read, because this is a platform admin's session as
 * often as an owner's (§3).
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type HistoryPhase = "history" | "opening";

/** Xero's maximum is 1,000. This keeps one page of lines under a function's limits. */
const PAGE_SIZE = 500;
/** `authenticated` statements stop at eight seconds, and each invoice fires triggers. */
const WRITE_BATCH = 100;

export type PageResult = {
  ok: true;
  /** How many invoices Xero returned. Zero means the phase is finished. */
  returned: number;
  drafts: string[];
  openings: string[];
  rows: number;
  lines: number;
  awaitingCount: number;
  awaitingDue: number;
  newInvoices: number;
  existingInvoices: number;
  appRowsLeftAlone: number;
  /** Contacts matched only by a similar name, for a person to read. */
  similar: Array<{ contact: string; customer: string }>;
  /** Contacts with no customer, who come in as inactive customers. */
  unmatched: Array<{ number: string; customer: string }>;
  written: Record<string, number>;
} | { ok: false; error: string; retryAfter?: number };

async function loadLookups(supabase: Client, tenantId: string): Promise<HistoryLookups> {
  const [{ data: customers }, { data: items }, { data: accounts }] = await Promise.all([
    supabase.from("customers").select("id, business_name, xero_contact_id")
      .eq("tenant_id", tenantId).limit(5000)
      .returns<Array<{ id: string; business_name: string; xero_contact_id: string | null }>>(),
    supabase.from("items").select("id, item_code")
      .eq("tenant_id", tenantId).limit(5000)
      .returns<Array<{ id: string; item_code: string | null }>>(),
    supabase.from("gl_accounts").select("id, code, xero_account_code")
      .eq("tenant_id", tenantId).limit(5000)
      .returns<Array<{ id: string; code: string; xero_account_code: string | null }>>(),
  ]);
  return {
    customerByContact: new Map((customers ?? []).filter((c) => c.xero_contact_id)
      .map((c) => [c.xero_contact_id!, c.id])),
    customerByName: new Map((customers ?? []).map((c) => [normaliseName(c.business_name), c.id])),
    customers: (customers ?? []).map((c) => ({ id: c.id, name: c.business_name })),
    itemByCode: new Map((items ?? []).filter((i) => i.item_code)
      .map((i) => [i.item_code!.toLowerCase(), i.id])),
    accountByCode: new Map((accounts ?? []).map((a) => [a.xero_account_code ?? a.code, a.id])),
  };
}

/** The numbers of every open MYOB invoice here, for working out what has been settled. */
export async function loadOpenImportNumbers(supabase: Client, tenantId: string): Promise<string[]> {
  const numbers: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("invoices").select("invoice_number")
      .eq("tenant_id", tenantId).eq("source", "import").neq("invoice_type", "credit")
      .in("status", [...OPEN_INVOICE_STATUSES]).is("deleted_at", null)
      .order("invoice_number").range(from, from + 999)
      .returns<Array<{ invoice_number: string }>>();
    numbers.push(...(data ?? []).map((row) => row.invoice_number));
    if (!data || data.length < 1000) return numbers;
  }
}

/**
 * A contact Xero has and the app does not comes in as an inactive customer, as the
 * MYOB importer does for a party named only by its documents: their history has to
 * belong to somebody, and it should not be offered in a picker as a live account.
 * The Xero contact id goes on the row, so the next page finds them without a second.
 */
async function addCustomer(
  supabase: Client, tenantId: string, contact: { id: string | null; name: string },
): Promise<{ id: string } | { error: string }> {
  const { data: number, error: numberError } = await supabase
    .rpc("next_number", { t: tenantId, k: "customer", p: "CUST" });
  if (numberError) return { error: describeDbError(numberError) };
  const { data, error } = await supabase
    .from("customers")
    .insert({
      tenant_id: tenantId,
      customer_number: number as string,
      business_name: contact.name,
      status: "inactive",
      xero_contact_id: contact.id,
      xero_contact_name: contact.name,
      notes: "Carried in with the MYOB invoice history from Xero; not on the customer list then.",
    })
    .select("id").single<{ id: string }>();
  return error ? { error: describeDbError(error) } : data;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}

export async function runHistoryPage(
  supabase: Client, tenantId: string,
  input: { phase: HistoryPhase; page: number; write: boolean },
): Promise<PageResult> {
  const tokens = await getXeroTokens(tenantId);
  if (!tokens) return { ok: false, error: "Xero is not connected for this laundry." };

  const query = new URLSearchParams({
    page: String(input.page),
    pageSize: String(PAGE_SIZE),
    order: "InvoiceNumber",
    Statuses: input.phase === "history" ? "DRAFT" : "AUTHORISED,PAID",
    where: 'Type=="ACCREC"',
  });

  let response: Response;
  try {
    response = await fetch(`${XERO_API}/Invoices?${query}`, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Xero-tenant-id": tokens.xeroTenantId,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (cause) {
    return { ok: false, error: `Xero could not be reached. ${cause instanceof Error ? cause.message : ""}`.trim() };
  }

  if (response.status === 429) {
    return {
      ok: false, error: "Xero asked us to slow down.",
      retryAfter: Number(response.headers.get("retry-after")) || 60,
    };
  }
  if (!response.ok) {
    const detail = summariseXeroError(await response.text().catch(() => ""));
    return { ok: false, error: `Xero refused the read (${response.status}). ${detail}`.trim() };
  }

  const invoices = ((await response.json()) as { Invoices?: XeroInvoice[] }).Invoices ?? [];
  const lookups = await loadLookups(supabase, tenantId);

  const history: HistoryRow[] = [];
  const openings: OpeningRow[] = [];
  const unmatched: Array<{ number: string; customer: string }> = [];
  for (const invoice of invoices) {
    const kind = classifyXeroInvoice(invoice);
    // An approved MYOB invoice is both: its lines, and what is owed on it.
    if (input.phase === "history" ? kind === "history" : kind === "approved") {
      const row = historyRow(invoice, lookups);
      if (row) history.push(row);
    }
    if (input.phase === "opening" && (kind === "opening" || kind === "approved")) {
      const row = openingRow(invoice, lookups);
      if (row) openings.push(row);
    }
  }

  const numbers = [...new Set([...history, ...openings].map((row) => row.number))];
  const existing = new Map<string, string>();
  for (const batch of chunk(numbers, 200)) {
    const { data } = await supabase
      .from("invoices").select("invoice_number, source")
      .eq("tenant_id", tenantId).in("invoice_number", batch)
      .returns<Array<{ invoice_number: string; source: string }>>();
    for (const row of data ?? []) existing.set(row.invoice_number, row.source);
  }

  // A new invoice needs a customer. One already here does not, so a contact Xero
  // spells differently only matters for the rows it would have to create.
  const contactOf = new Map(invoices.map((invoice) => [
    openingBaseNumber(invoice.InvoiceNumber) ?? invoice.InvoiceNumber?.trim() ?? "", invoice.Contact,
  ]));
  const similar = new Map<string, string>();
  for (const invoice of invoices) {
    const contact = invoice.Contact;
    if (!contact?.Name || lookups.customerByContact.has(contact.ContactID ?? "")) continue;
    if (lookups.customerByName.has(normaliseName(contact.Name))) continue;
    const match = similarCustomer(contact.Name, lookups.customers);
    if (match) similar.set(contact.Name, match.name);
  }

  const waiting = [...history, ...openings].filter((row) => !existing.has(row.number) && !row.customer_id);
  for (const number of new Set(waiting.map((row) => row.number))) {
    unmatched.push({ number, customer: contactOf.get(number)?.Name ?? "Unknown contact" });
  }

  const added: Record<string, string> = {};
  if (input.write) {
    for (const row of waiting) {
      const contact = contactOf.get(row.number);
      const name = contact?.Name?.trim();
      if (!name) continue;
      if (!added[name]) {
        const outcome = await addCustomer(supabase, tenantId, { id: contact?.ContactID ?? null, name });
        if ("error" in outcome) return { ok: false, error: outcome.error };
        added[name] = outcome.id;
      }
      row.customer_id = added[name]!;
    }
  }

  const written: Record<string, number> = {};
  if (input.write) {
    // The invoice first and what is owed on it second, because the second finds
    // the first by its number.
    const steps = [
      ["import_invoice_history", history],
      ["apply_invoice_openings", openings],
    ] as const;
    for (const [rpc, rows] of steps) {
      for (const batch of chunk<HistoryRow | OpeningRow>([...rows], WRITE_BATCH)) {
        const { data, error } = await supabase.rpc(rpc, { p_tenant: tenantId, p_rows: batch });
        if (error) return { ok: false, error: describeDbError(error) };
        for (const [key, value] of Object.entries((data ?? {}) as Record<string, number>)) {
          written[key] = (written[key] ?? 0) + value;
        }
      }
    }
  }

  const customersAdded = Object.keys(added).length;
  if (customersAdded) written.customers_added = customersAdded;

  const awaiting = openings.filter((row) => row.due > 0);
  const rowsSeen = numbers.map((number) => ({ number }));
  return {
    ok: true,
    returned: invoices.length,
    drafts: history.map((row) => row.number),
    openings: openings.map((row) => row.number),
    rows: numbers.length,
    lines: history.reduce((sum, row) => sum + row.lines.length, 0),
    awaitingCount: awaiting.length,
    awaitingDue: Math.round(awaiting.reduce((sum, row) => sum + row.due, 0) * 100) / 100,
    newInvoices: rowsSeen.filter((row) => !existing.has(row.number)).length,
    existingInvoices: rowsSeen.filter((row) => existing.has(row.number)).length,
    appRowsLeftAlone: rowsSeen.filter((row) => existing.get(row.number) === "app").length,
    similar: [...similar.entries()].map(([contact, customer]) => ({ contact, customer })),
    unmatched,
    written,
  };
}

export type CreditPageResult = {
  ok: true;
  returned: number;
  /** The invoice numbers of the MYOB credits on this page, for `settleUsedCredits`. */
  numbers: string[];
  stillCredit: number;
  stillCreditAmount: number;
  newCredits: number;
  written: number;
} | { ok: false; error: string; retryAfter?: number };

/**
 * One page of Xero's credit notes. A credit's balance is set straight on the row:
 * no guard stands in the way of it, and unlike a line on a closed invoice this is
 * an ordinary write the owner's own client is allowed to make.
 */
export async function runCreditPage(
  supabase: Client, tenantId: string, input: { page: number; write: boolean },
): Promise<CreditPageResult> {
  const tokens = await getXeroTokens(tenantId);
  if (!tokens) return { ok: false, error: "Xero is not connected for this laundry." };

  const query = new URLSearchParams({
    page: String(input.page),
    pageSize: String(PAGE_SIZE),
    order: "CreditNoteNumber",
    where: 'Type=="ACCRECCREDIT"',
  });

  let response: Response;
  try {
    response = await fetch(`${XERO_API}/CreditNotes?${query}`, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Xero-tenant-id": tokens.xeroTenantId,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (cause) {
    return { ok: false, error: `Xero could not be reached. ${cause instanceof Error ? cause.message : ""}`.trim() };
  }
  if (response.status === 429) {
    return {
      ok: false, error: "Xero asked us to slow down.",
      retryAfter: Number(response.headers.get("retry-after")) || 60,
    };
  }
  if (!response.ok) {
    const detail = summariseXeroError(await response.text().catch(() => ""));
    return { ok: false, error: `Xero refused the credit notes (${response.status}). ${detail}`.trim() };
  }

  const notes = ((await response.json()) as { CreditNotes?: XeroCreditNote[] }).CreditNotes ?? [];
  const rows = notes.flatMap((note) => {
    const row = creditRow(note);
    return row ? [row] : [];
  });

  const here = new Map<string, {
    id: string; total: number; amount_credited: number; source: string;
  }>();
  for (const batch of chunk(rows.map((row) => row.number), 200)) {
    const { data } = await supabase
      .from("invoices").select("id, invoice_number, total, amount_credited, source")
      .eq("tenant_id", tenantId).in("invoice_number", batch)
      .returns<Array<{
        id: string; invoice_number: string; total: number; amount_credited: number; source: string;
      }>>();
    for (const row of data ?? []) here.set(row.invoice_number, row);
  }

  const lookups = await loadLookups(supabase, tenantId);
  let written = 0;
  if (input.write) {
    for (const row of rows) {
      const invoice = here.get(row.number);
      if (invoice?.source === "app") continue;
      if (invoice) {
        const { error } = await supabase
          .from("invoices")
          .update({
            ...(row.remaining > 0 ? { invoice_type: "credit" } : {}),
            amount_paid: paidForCredit(
              Number(invoice.total), Number(invoice.amount_credited ?? 0), row.remaining,
            ),
            status: row.remaining > 0 ? "issued" : "paid",
          })
          .eq("id", invoice.id).eq("tenant_id", tenantId);
        if (error) return { ok: false, error: describeDbError(error) };
        written += 1;
        continue;
      }

      // A credit newer than the August export, so the app has never seen it.
      const contact = { id: row.contact_id, name: row.contact };
      const customerId = customerFor(
        { InvoiceID: "", Contact: { ContactID: row.contact_id ?? undefined, Name: row.contact } }, lookups,
      );
      const customer = customerId ? { id: customerId } : await addCustomer(supabase, tenantId, contact);
      if ("error" in customer) return { ok: false, error: customer.error };
      const { error } = await supabase.from("invoices").insert({
        tenant_id: tenantId, customer_id: customer.id, invoice_number: row.number,
        invoice_type: "credit", source: "import", status: row.remaining > 0 ? "issued" : "paid",
        issue_date: row.issue_date ?? undefined, subtotal: row.total, total: row.total,
        amount_paid: paidForCredit(row.total, 0, row.remaining),
        notes: "Imported from a Xero credit note (MYOB).",
      });
      if (error) return { ok: false, error: describeDbError(error) };
      written += 1;
    }
  }

  const open = rows.filter((row) => row.remaining > 0);
  return {
    ok: true,
    returned: notes.length,
    numbers: rows.map((row) => row.number),
    stillCredit: open.length,
    stillCreditAmount: Math.round(open.reduce((sum, row) => sum + row.remaining, 0) * 100) / 100,
    newCredits: rows.filter((row) => !here.has(row.number)).length,
    written,
  };
}

/** Close the app's open credits that Xero no longer holds. Only reports, unless `write`. */
export async function settleUsedCredits(
  supabase: Client, tenantId: string, input: { inXero: string[]; write: boolean },
): Promise<{ count: number; amount: number } | { error: string }> {
  const { data } = await supabase
    .from("invoices").select("id, invoice_number, total, amount_credited, balance")
    .eq("tenant_id", tenantId).eq("source", "import").eq("invoice_type", "credit")
    .in("status", [...OPEN_INVOICE_STATUSES]).is("deleted_at", null)
    .limit(1000)
    .returns<Array<{
      id: string; invoice_number: string; total: number; amount_credited: number; balance: number;
    }>>();
  const rows = data ?? [];
  const used = new Set(usedCredits(rows.map((row) => row.invoice_number), input.inXero));
  const closing = rows.filter((row) => used.has(row.invoice_number));
  if (input.write) {
    for (const row of closing) {
      const { error } = await supabase
        .from("invoices")
        .update({
          amount_paid: paidForCredit(Number(row.total), Number(row.amount_credited ?? 0), 0),
          status: "paid",
        })
        .eq("id", row.id).eq("tenant_id", tenantId);
      if (error) return { error: describeDbError(error) };
    }
  }
  return {
    count: closing.length,
    amount: Math.round(closing.reduce((sum, row) => sum + Number(row.balance), 0) * 100) / 100,
  };
}
