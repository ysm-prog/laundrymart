import { CHARGE_TYPES, type ChargeType } from "@/lib/domain/pricing";

/**
 * The charge-account form's payload, read outside the `"use server"` module that
 * saves it.
 *
 * §2's rule, and this repo has paid for it three times: a `"use server"` module
 * can export nothing but server actions, so a payload contract written inside
 * one is unreachable from a unit test — and two of the three that were written
 * that way shipped broken behind a green `verify`.
 *
 * One field per kind of charge, all twelve posted every time, so "what did the
 * operator mean by leaving this blank?" is the only real question and it is
 * answered once, here.
 *
 * **Blank means no default, and no default means the row is removed.** There is
 * deliberately no third state: an "unset" row and an absent row would be two
 * spellings of the same fact, and `chargeTypeAccounts()` would have to know
 * which — the shape `price-form.ts` refuses for the same reason.
 */

export type ChargeAccountEntry = {
  chargeType: ChargeType;
  accountId: string;
};

export type ParsedChargeAccountForm =
  | { ok: true; entries: ChargeAccountEntry[]; cleared: ChargeType[] }
  | { ok: false; error: string };

export const accountField = (chargeType: string) => `account_${chargeType}`;

/**
 * A uuid, loosely — the database is the boundary and its foreign key is what
 * actually decides. This exists to turn a hand-made request into a sentence
 * rather than a Postgres error, and to keep a stray `""` from being read as an
 * id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseChargeAccountForm(formData: FormData): ParsedChargeAccountForm {
  const entries: ChargeAccountEntry[] = [];
  const cleared: ChargeType[] = [];

  for (const chargeType of CHARGE_TYPES) {
    const raw = formData.get(accountField(chargeType));
    // A field the form did not post at all is left exactly as it is, rather than
    // being read as "cleared". Otherwise a release that adds a thirteenth kind of
    // charge would silently wipe the defaults for every one an older cached page
    // does not know about.
    if (raw === null) continue;

    const value = String(raw).trim();
    if (value === "") {
      cleared.push(chargeType);
      continue;
    }
    if (!UUID.test(value)) {
      return { ok: false, error: `That is not an account we recognise for ${chargeType}.` };
    }
    entries.push({ chargeType, accountId: value });
  }

  return { ok: true, entries, cleared };
}
