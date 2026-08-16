"use client";

import { useRef, useState } from "react";
import { Badge, CONTROL, Card, Eyebrow, Notice, Stage, cx } from "@/components/ui";

/**
 * The two-step upload: read the files, show what they add up to, then write.
 *
 * The second step is not ceremony. This import's whole failure mode is a number
 * that is wrong but entirely plausible — MYOB's bills export drops a column and
 * every affected row would otherwise load a *date* as its amount — so the plan
 * is built, counted and shown before anything is written. The same code builds
 * the plan both times, so the preview cannot describe a different import from
 * the one that runs.
 *
 * `Stage` is the app's guidance idiom: exactly one step actionable at a time.
 */

type FileSummary = {
  name: string; bytes: number; status: "known" | "redundant" | "unknown" | "duplicate";
  kind: string | null; label: string; detail: string; rows: number;
};
type Problem = { file: string; row: number | null; message: string; fatal: boolean };
type Preview = {
  summaries: FileSummary[];
  notes: string[];
  problems: Problem[];
  problemCount: number;
  tables: { table: string; label: string; rows: number }[];
  parties: {
    customersNew: number; customersExisting: number;
    suppliersNew: number; suppliersExisting: number;
  };
  totals: { receivable: number; payable: number };
  canCommit: boolean;
  written?: { table: string; label: string; rows: number }[];
  openingsCleared?: number;
  error?: string;
};

const MAX_BYTES = 4_000_000;

const money = (value: number) =>
  value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

export function ImportUploader({ tenantName }: { tenantName: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [scope, setScope] = useState<"outstanding" | "all">("outstanding");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"analyse" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const tooBig = total > MAX_BYTES;

  async function send(mode: "analyse" | "commit") {
    setBusy(mode);
    setError(null);
    const body = new FormData();
    body.set("mode", mode);
    body.set("invoiceScope", scope);
    for (const file of files) body.append("files", file);
    try {
      const response = await fetch("/api/import", { method: "POST", body });
      const payload = (await response.json()) as Preview & { error?: string };
      if (payload.error) setError(payload.error);
      if (payload.summaries) {
        setPreview(payload);
        if (mode === "commit" && response.ok) setDone(payload);
      }
      if (!payload.summaries && !payload.error) setError("The import did not answer as expected.");
    } catch {
      setError("The upload did not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  function choose(list: FileList | null) {
    setFiles(list ? [...list] : []);
    setPreview(null);
    setDone(null);
    setError(null);
  }

  const fatal = preview?.problems.filter((problem) => problem.fatal) ?? [];

  return (
    <div className="space-y-4">
      {error ? <Notice tone="danger" title="That did not work">{error}</Notice> : null}

      {done ? (
        <Notice tone="success" title={`Loaded into ${tenantName}`}>
          <ul className="mt-1 space-y-0.5 font-mono text-2xs">
            {done.written?.map((row) => (
              <li key={`${row.table}-${row.label}`}>
                {row.rows.toLocaleString()} × {row.label.toLowerCase()}
              </li>
            ))}
          </ul>
          {done.openingsCleared ? (
            <p className="mt-1.5">
              {done.openingsCleared} opening balances were cleared, because a document now
              carries the same money. Adding the two would have counted one debt twice.
            </p>
          ) : null}
        </Notice>
      ) : null}

      <ol className="space-y-2">
        <Stage
          index={1}
          label="Choose the export files"
          detail="The CSVs and spreadsheets MYOB produces. Drop in as many as you have — each one is recognised by what it contains."
          done={files.length > 0}
        >
          <div className="space-y-2">
            <input
              ref={picker}
              type="file"
              multiple
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className={cx(CONTROL, "file:mr-3 file:border-0 file:bg-transparent file:text-[12.5px] file:font-medium")}
              onChange={(event) => choose(event.target.files)}
            />
            {files.length > 0 ? (
              <p className="font-mono text-2xs text-muted-foreground">
                {files.length} file{files.length === 1 ? "" : "s"} · {(total / 1024).toFixed(0)} KB
              </p>
            ) : null}
            {tooBig ? (
              <Notice tone="warning" title="That is more than 4 MB at once">
                Upload a few files at a time. It is safe to: each upload is matched against what is
                already here by customer name and document number, so nothing is doubled up and the
                order does not matter.
              </Notice>
            ) : null}
          </div>
        </Stage>

        <Stage
          index={2}
          label="Check what it will do"
          detail="Nothing is written yet. This reads the files, matches them against what you already have, and reports what it found."
          done={preview !== null}
        >
          <div className="space-y-3">
            <fieldset className="space-y-1.5">
              <legend className="sr-only">How much invoice history to load</legend>
              {([
                ["outstanding", "Only invoices that still owe money", "The open items. This is what a set of books needs to chase and to reconcile."],
                ["all", "Every invoice ever raised", "The full sales history, including everything already paid. Much larger, and only worth it if you want the history in the app."],
              ] as const).map(([value, label, hint]) => (
                <label key={value} className="flex min-h-9 items-start gap-2 text-[12.5px]">
                  <input
                    type="radio" name="scope" value={value} checked={scope === value}
                    className="mt-1"
                    onChange={() => { setScope(value); setPreview(null); setDone(null); }}
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              disabled={files.length === 0 || tooBig || busy !== null}
              onClick={() => send("analyse")}
              className="inline-flex min-h-9 items-center border border-strong bg-surface px-3 text-[12.5px] font-medium hover:bg-surface-muted disabled:opacity-60"
            >
              {busy === "analyse" ? "Reading…" : "Read the files"}
            </button>
          </div>
        </Stage>

        <Stage
          index={3}
          label="Load it in"
          detail="Writes the rows above. Running it twice is safe — every row is matched on its own number and refreshed in place, never added again."
          done={done !== null}
        >
          {preview ? (
            <div className="space-y-2">
              {!preview.canCommit ? (
                <Notice tone="warning" title="Not ready to load">
                  {fatal.length > 0
                    ? "Fix the problems listed below first."
                    : "There is nothing in these files to write."}
                </Notice>
              ) : (
                <div className="border-l-[5px] border border-l-strong bg-surface-muted px-3 py-2 text-[12.5px]">
                  This writes to <strong>{tenantName}</strong>: {preview.tables.reduce((sum, t) => sum + t.rows, 0).toLocaleString()}
                  {" "}rows across {new Set(preview.tables.map((t) => t.table)).size} tables. Existing rows with the
                  same number are updated in place; nothing is deleted.
                </div>
              )}
              <button
                type="button"
                disabled={!preview.canCommit || busy !== null || done !== null}
                onClick={() => send("commit")}
                className="inline-flex min-h-9 items-center bg-action px-3 text-[12.5px] font-medium text-action-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy === "commit" ? "Loading…" : done ? "Loaded" : "Load into the database"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Read the files first.</p>
          )}
        </Stage>
      </ol>

      {preview ? <PreviewPanels preview={preview} /> : null}
    </div>
  );
}

function PreviewPanels({ preview }: { preview: Preview }) {
  const fatal = preview.problems.filter((problem) => problem.fatal);
  const tone: Record<FileSummary["status"], "success" | "neutral" | "warning" | "danger"> = {
    known: "success", redundant: "neutral", unknown: "warning", duplicate: "danger",
  };

  return (
    <div className="space-y-4">
      <Card title="What each file is" description="Recognised by name, and by the columns it carries if the name has been changed.">
        <ul className="space-y-2">
          {preview.summaries.map((file) => (
            <li key={file.name} className="border-b pb-2 text-[12.5px] last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs break-all">{file.name}</span>
                <Badge tone={tone[file.status]}>{file.label}</Badge>
                {file.status === "known" ? (
                  <span className="font-mono text-2xs text-muted-foreground">
                    {file.rows.toLocaleString()} rows
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{file.detail}</p>
            </li>
          ))}
        </ul>
      </Card>

      {fatal.length > 0 ? (
        <Card title="Problems that stop the import">
          <ul className="space-y-1.5 text-[12.5px]">
            {fatal.map((problem, at) => (
              <li key={at} className="flex gap-2">
                <span className="font-mono text-2xs text-muted-foreground">
                  {problem.file}{problem.row ? `:${problem.row}` : ""}
                </span>
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
          {preview.problemCount > preview.problems.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              …and {preview.problemCount - preview.problems.length} more.
            </p>
          ) : null}
        </Card>
      ) : null}

      {preview.tables.length > 0 ? (
        <Card title="What would be written" description="Rows matched on their own number: an existing one is refreshed, a new one is created.">
          <ul className="space-y-1 font-mono text-2xs">
            {preview.tables.map((table) => (
              <li key={`${table.table}-${table.label}`} className="flex justify-between gap-3">
                <span>{table.label}</span>
                <span>{table.rows.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-[12.5px] sm:grid-cols-4">
            <div>
              <dt><Eyebrow>Customers</Eyebrow></dt>
              <dd className="font-mono">{preview.parties.customersNew} new · {preview.parties.customersExisting} known</dd>
            </div>
            <div>
              <dt><Eyebrow>Suppliers</Eyebrow></dt>
              <dd className="font-mono">{preview.parties.suppliersNew} new · {preview.parties.suppliersExisting} known</dd>
            </div>
            <div>
              <dt><Eyebrow>Owed to you</Eyebrow></dt>
              <dd className="font-mono">{money(preview.totals.receivable)}</dd>
            </div>
            <div>
              <dt><Eyebrow>Owed by you</Eyebrow></dt>
              <dd className="font-mono">{money(preview.totals.payable)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            Check those two totals against Trade Debtors and Trade Creditors in your chart of
            accounts before loading. They are the only figures that prove the rest arrived intact.
          </p>
        </Card>
      ) : null}

      {preview.notes.length > 0 ? (
        <Card title="Worth knowing" description="What the importer found in the export, and what it did about it.">
          <ul className="space-y-1.5 text-[12.5px]">
            {preview.notes.map((note, at) => <li key={at}>{note}</li>)}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
