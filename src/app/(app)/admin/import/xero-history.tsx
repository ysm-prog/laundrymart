"use client";

import { useRef, useState } from "react";
import { Button, Card, Notice } from "@/components/ui";
import { formatMoney } from "@/lib/domain/pricing";
import { invoicesToSettle } from "@/lib/domain/xero-history";

/**
 * Bring the MYOB invoice history in from Xero.
 *
 * Driven from the browser, one page per request, because the job outlasts any one
 * function. **Check first reads everything and writes nothing**, and Bring them in
 * is only offered once a check has finished, so the numbers are always seen first.
 * Stopping half way loses nothing: run it again and finished work is skipped.
 */

type Tally = {
  drafts: Set<string>; openings: Set<string>; lines: number; awaitingCount: number; awaitingDue: number;
  newInvoices: number; existingInvoices: number; appRowsLeftAlone: number;
  similar: Map<string, string>; unmatched: Map<string, number>; written: Record<string, number>;
  credits: Set<string>; stillCredit: number; stillCreditAmount: number; newCredits: number;
  creditsWritten: number; creditsUsed: number; creditsUsedAmount: number;
  sharedNumber: number; sharedNumberLeft: number;
};

const emptyTally = (): Tally => ({
  drafts: new Set(), openings: new Set(), lines: 0, awaitingCount: 0, awaitingDue: 0,
  newInvoices: 0, existingInvoices: 0, appRowsLeftAlone: 0, similar: new Map(), unmatched: new Map(), written: {},
  credits: new Set(), stillCredit: 0, stillCreditAmount: 0, newCredits: 0,
  creditsWritten: 0, creditsUsed: 0, creditsUsedAmount: 0, sharedNumber: 0, sharedNumberLeft: 0,
});

type Page = {
  ok: boolean; error?: string; retryAfter?: number; returned: number; drafts: string[]; openings: string[];
  lines: number; awaitingCount: number; awaitingDue: number; newInvoices: number; existingInvoices: number;
  appRowsLeftAlone: number; similar: Array<{ contact: string; customer: string }>;
  unmatched: Array<{ number: string; customer: string }>;
  written: Record<string, number>;
};

type CreditPage = {
  ok: boolean; error?: string; retryAfter?: number; returned: number; numbers: string[];
  stillCredit: number; stillCreditAmount: number; newCredits: number;
  sharedNumber: number; sharedNumberLeft: number; written: number;
};

type Result = {
  tally: Tally; settle: string[]; unknown: string[]; wrote: boolean; settled?: { invoices: number; amount: number };
};

async function post<T>(payload: unknown): Promise<T> {
  const response = await fetch("/api/xero/history", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return await response.json().catch(() => ({ ok: false, error: "The app did not answer." })) as T;
}

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function XeroHistory() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const stop = useRef(false);

  async function run(write: boolean) {
    setRunning(true); setError(null); stop.current = false;
    const tally = emptyTally();
    try {
      for (const phase of ["history", "opening"] as const) {
        for (let page = 1; ; page += 1) {
          if (stop.current) throw new Error("Stopped. Run it again to carry on; finished work is skipped.");
          setProgress(`${phase === "history" ? "Invoices" : "Opening balances"}: page ${page}, ${
            (phase === "history" ? tally.drafts : tally.openings).size.toLocaleString()} so far`);
          const answer = await post<Page>({ step: "page", phase, page, write });
          if (!answer.ok && answer.retryAfter) {
            setProgress(`Xero asked us to wait ${answer.retryAfter} seconds`);
            await wait(answer.retryAfter);
            page -= 1;
            continue;
          }
          if (!answer.ok) throw new Error(answer.error ?? "That page could not be read.");
          if (answer.returned === 0) break;
          answer.drafts.forEach((number) => tally.drafts.add(number));
          answer.openings.forEach((number) => tally.openings.add(number));
          tally.lines += answer.lines;
          tally.awaitingCount += answer.awaitingCount;
          tally.awaitingDue += answer.awaitingDue;
          tally.newInvoices += answer.newInvoices;
          tally.existingInvoices += answer.existingInvoices;
          tally.appRowsLeftAlone += answer.appRowsLeftAlone;
          for (const row of answer.similar) tally.similar.set(row.contact, row.customer);
          for (const row of answer.unmatched) {
            tally.unmatched.set(row.customer, (tally.unmatched.get(row.customer) ?? 0) + 1);
          }
          for (const [key, value] of Object.entries(answer.written)) {
            tally.written[key] = (tally.written[key] ?? 0) + value;
          }
        }
      }

      for (let page = 1; ; page += 1) {
        if (stop.current) throw new Error("Stopped. Run it again to carry on; finished work is skipped.");
        setProgress(`Credit notes: page ${page}`);
        const answer = await post<CreditPage>({ step: "credits", page, write });
        if (!answer.ok && answer.retryAfter) {
          setProgress(`Xero asked us to wait ${answer.retryAfter} seconds`);
          await wait(answer.retryAfter);
          page -= 1;
          continue;
        }
        if (!answer.ok) throw new Error(answer.error ?? "The credit notes could not be read.");
        if (answer.returned === 0) break;
        answer.numbers.forEach((number) => tally.credits.add(number));
        tally.stillCredit += answer.stillCredit;
        tally.stillCreditAmount += answer.stillCreditAmount;
        tally.newCredits += answer.newCredits;
        tally.sharedNumber += answer.sharedNumber;
        tally.sharedNumberLeft += answer.sharedNumberLeft;
        tally.creditsWritten += answer.written;
      }
      const used = await post<{ ok: boolean; error?: string; count?: number; amount?: number }>({
        step: "credits-used", numbers: [...tally.credits], write,
      });
      if (!used.ok) throw new Error(used.error ?? "The credits could not be finished.");
      tally.creditsUsed = used.count ?? 0;
      tally.creditsUsedAmount = used.amount ?? 0;

      setProgress("Working out what has been settled");
      const open = await post<{ ok: boolean; numbers?: string[] }>({ step: "open" });
      const { settle, unknown } = invoicesToSettle({
        openInApp: open.numbers ?? [], drafts: tally.drafts, openings: tally.openings,
      });
      let settled: Result["settled"];
      if (write) {
        const answer = await post<{ ok: boolean; error?: string; settled?: Result["settled"] }>({
          step: "settle", numbers: settle,
          summary: `${tally.drafts.size} invoices and ${tally.openings.size} opening balances read`,
        });
        if (!answer.ok) throw new Error(answer.error ?? "Settling could not finish.");
        settled = answer.settled;
      }
      setResult({ tally, settle, unknown, wrote: write, settled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not finish.");
    } finally {
      setRunning(false); setProgress(null);
    }
  }

  const tally = result?.tally;
  const unmatched = tally ? [...tally.unmatched.entries()].sort((a, b) => b[1] - a[1]) : [];
  const unmatchedInvoices = unmatched.reduce((sum, [, count]) => sum + count, 0);
  const similar = tally ? [...tally.similar.entries()].sort((a, b) => a[0].localeCompare(b[0])) : [];

  return (
    <Card
      title="MYOB invoice history from Xero"
      description="Reads the MYOB invoices held in Xero, with their lines, and what is still owed on each. Check first writes nothing."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={result ? "secondary" : "primary"} size="md"
                  disabled={running} onClick={() => run(false)}>
            Check first
          </Button>
          {result && !result.wrote ? (
            <Button type="button" size="md" disabled={running} onClick={() => run(true)}>
              Bring them in
            </Button>
          ) : null}
          {running ? (
            <Button type="button" variant="secondary" size="md" onClick={() => { stop.current = true; }}>
              Stop
            </Button>
          ) : null}
          {progress ? <span className="text-sm text-muted-foreground">{progress}…</span> : null}
        </div>

        {error ? <Notice tone="warning" title="That did not finish">{error}</Notice> : null}

        {result && tally ? (
          <>
            <p className="text-sm font-medium">{result.wrote ? "Brought in." : "Nothing has been written yet."}</p>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="xero-history-summary">
              {([
                ["Invoices with lines in Xero", tally.drafts.size.toLocaleString()],
                ["Lines on them", tally.lines.toLocaleString()],
                ["Opening balances", tally.openings.size.toLocaleString()],
                ["Still owed on those", `${tally.awaitingCount.toLocaleString()}, ${formatMoney(tally.awaitingDue)}`],
                ["New to the app", tally.newInvoices.toLocaleString()],
                ["Already in the app", tally.existingInvoices.toLocaleString()],
                ["App invoices left alone", tally.appRowsLeftAlone.toLocaleString()],
                ["Open here, settled in MYOB", result.settle.length.toLocaleString()],
                ["Open here, not in Xero", result.unknown.length.toLocaleString()],
                ["Matched by a similar name", `${similar.length.toLocaleString()} contacts`],
                ["New inactive customers", `${unmatched.length.toLocaleString()}, for ${unmatchedInvoices.toLocaleString()} invoices`],
                ["Credit notes from MYOB", tally.credits.size.toLocaleString()],
                ["Credit left on them", `${tally.stillCredit.toLocaleString()}, ${formatMoney(tally.stillCreditAmount)}`],
                ["Credits new to the app", tally.newCredits.toLocaleString()],
                ["Credits on an invoice's number, left off it", `${tally.sharedNumber.toLocaleString()}, ${formatMoney(tally.sharedNumberLeft)} left`],
                ["Credits here, used up in Xero", `${tally.creditsUsed.toLocaleString()}, ${formatMoney(tally.creditsUsedAmount)}`],
                ...(result.wrote ? [["Credits updated", tally.creditsWritten.toLocaleString()]] : []),
                ...(result.settled ? [["Marked paid", `${result.settled.invoices}, ${formatMoney(result.settled.amount)}`]] : []),
                ...Object.entries(tally.written).map(([key, value]) => [key.replace(/_/g, " "), value.toLocaleString()]),
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b py-1">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {similar.length > 0 ? (
              <div className="text-sm" data-testid="xero-history-similar">
                <p className="font-medium">Matched by a similar name</p>
                <ul className="mt-1 divide-y">
                  {similar.map(([contact, customer]) => (
                    <li key={contact} className="grid gap-x-4 py-1 sm:grid-cols-2">
                      <span>{contact}</span>
                      <span className="text-muted-foreground">{customer}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {unmatched.length > 0 ? (
              <div className="text-sm" data-testid="xero-history-unmatched">
                <p className="font-medium">
                  {result.wrote ? "Added as inactive customers" : "These come in as inactive customers"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {unmatched.map(([name, count]) => `${name} (${count})`).join(", ")}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
