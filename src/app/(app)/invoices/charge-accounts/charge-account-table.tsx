"use client";

import { useState } from "react";
import Link from "next/link";
import { accountLabel, type PickableAccount } from "@/lib/domain/accounts";
import { CHARGE_TYPES, CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import { AccountPicker } from "@/components/coding-pickers";
import { Overlay } from "@/components/overlay";
import { Button, Card, DataTable, Notice } from "@/components/ui";
import { FormActions, SubmitButton } from "@/components/form";
import { accountField } from "./charge-account-form";

/**
 * The default account for each kind of charge, all twelve on one form.
 *
 * **Twelve pickers open at once was the other option, and it is unusable**: each
 * is a type-ahead with a results list and a "search every account" checkbox, so
 * the page would be a column of search boxes with no way to see the twelve
 * answers at a glance — which is the only reason somebody opens this screen.
 * The table is the answer and the picker is a detour, the same arrangement the
 * invoice line's own Code cell uses.
 *
 * State is held here and posted as twelve hidden fields, so the whole map is one
 * save. Twelve one-row forms would let somebody set half a chart and leave, and
 * `parseChargeAccountForm` would have no way to tell a field that was left blank
 * from one that was never on the page.
 */
export function ChargeAccountTable({
  accounts, current, action,
}: {
  accounts: readonly PickableAccount[];
  current: Readonly<Record<string, string | null>>;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [chosen, setChosen] = useState<Record<string, string | null>>(() => ({ ...current }));
  const [editing, setEditing] = useState<ChargeType | null>(null);

  type Row = { type: ChargeType };
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const editingAccount = editing ? byId.get(chosen[editing] ?? "") ?? null : null;
  const dirty = CHARGE_TYPES.some((type) => (chosen[type] ?? null) !== (current[type] ?? null));
  const coded = CHARGE_TYPES.filter((type) => chosen[type]).length;

  return (
    <form action={action}>
      {CHARGE_TYPES.map((type) => (
        <input key={type} type="hidden" name={accountField(type)} value={chosen[type] ?? ""} />
      ))}

      <Card
        title="Default account per kind of charge"
        description={
          "Used when a charge names no item, or the item it names has no income account. "
          + "A charge coded by hand on the job always wins."
        }
      >
        <DataTable
          bare
          rows={CHARGE_TYPES.map((type) => ({ type }))}
          empty={null}
          columns={[
            {
              header: "Kind of charge",
              cell: (row: Row) => CHARGE_TYPE_LABELS[row.type],
            },
            {
              header: "Codes to",
              cell: (row: Row) => {
                const account = byId.get(chosen[row.type] ?? "");
                if (!account) {
                  return <span className="text-muted-foreground">Not coded</span>;
                }
                return (
                  // §10b's 36px floor: a bare inline link around a code measures 18px.
                  <Link href={`/accounts/${account.id}`}
                        className="inline-flex min-h-9 items-center font-mono underline
                                   decoration-dotted underline-offset-2">
                    {accountLabel(account)}
                  </Link>
                );
              },
            },
            {
              header: "",
              align: "right",
              cell: (row: Row) => (
                <Button type="button" variant="ghost" onClick={() => setEditing(row.type)}>
                  {chosen[row.type] ? "Change" : "Set account"}
                </Button>
              ),
            },
          ]}
        />

        {accounts.length === 0 ? (
          <div className="mt-4">
            <Notice tone="info" title="No chart of accounts on file">
              Import your chart of accounts and each kind of charge can be given a default.
            </Notice>
          </div>
        ) : null}
      </Card>

      <FormActions>
        <SubmitButton>Save defaults</SubmitButton>
        {/*
          Not a disabled button when nothing has changed. The action answers "No
          changes to save." either way, and a control that is dead until the page
          notices you have edited it is the sort of thing somebody presses twice
          and then reloads.
        */}
        <span className="text-2xs text-muted-foreground">
          {coded} of {CHARGE_TYPES.length} coded{dirty ? " · unsaved changes" : ""}
        </span>
      </FormActions>

      <Overlay
        open={editing !== null} onClose={() => setEditing(null)} size="sm"
        title={editing ? `Where does ${CHARGE_TYPE_LABELS[editing].toLowerCase()} go?` : ""}
        description="Every charge of this kind that names no item will be coded here."
      >
        {editing ? (
          <div className="space-y-4">
            <AccountPicker
              idPrefix={`charge-${editing}`}
              accounts={accounts}
              chosen={editingAccount}
              noChart={accounts.length === 0}
              onChoose={(account) => {
                setChosen((prior) => ({ ...prior, [editing]: account.id }));
                setEditing(null);
              }}
              onClear={() => setChosen((prior) => ({ ...prior, [editing]: null }))}
            />
            {/*
              Closes the overlay and nothing more — the form is still unsaved, so
              the word is Done rather than Save. Calling it Save here and Save
              again below would be two buttons claiming to do the same thing,
              only one of which writes anything.
            */}
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Done</Button>
          </div>
        ) : null}
      </Overlay>
    </form>
  );
}
