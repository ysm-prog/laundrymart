import { createHash } from "node:crypto";

/**
 * Cell-level rules shared by every MYOB reader.
 *
 * These are ported from `scripts/import/myob-import.py` and must stay identical
 * to it: that script produced the rows this tenant already holds, and an upload
 * through the app has to address the same rows rather than a second copy of
 * them. `myob.test.ts` pins the identity function against ids the database
 * actually contains.
 */

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Namespace for the deterministic ids. Arbitrary, but fixed forever. */
const NAMESPACE = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

/** Raised for a cell that cannot mean what the column says it means. */
export class CellError extends Error {}

/**
 * A trimmed cell, with runs of whitespace inside it collapsed to one space.
 *
 * The collapsing is not cosmetic. Two of these exports write a party's name with
 * a doubled space where the others use one — "Salute Better Solutions P/L  -
 * Pak-Rite" against "…P/L - Pak-Rite" — and since a party's identity here is its
 * name, the pair imports as two suppliers: one holding the bills, the other
 * holding the balance those bills are supposed to explain. That is exactly how a
 * set of books stops reconciling, and it is invisible on screen, because the
 * second space renders as almost nothing.
 */
export function text(value: string | null | undefined): string | null {
  return (value ?? "").replace(/\s+/g, " ").trim() || null;
}

/**
 * A money column.
 *
 * Nothing is clamped: a supplier debit note is money owed back to the business
 * and a customer credit is a negative balance, so both signs are real.
 *
 * Garbage throws rather than reading as zero. The import's whole failure mode is
 * a number that is wrong but plausible — the shifted bills column below is
 * exactly that — so a cell that is not a number at all is the one case where the
 * loudest possible answer is the cheapest.
 */
export function money(value: string | null | undefined): number {
  const raw = (value ?? "").replace(/[\s,$]/g, "");
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new CellError(`${JSON.stringify(value)} is not an amount`);
  return round(parsed);
}

/** Two decimal places, away from binary drift. */
export function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** `dd/mm/yyyy` as MYOB writes it, to the ISO date Postgres wants. */
export function day(value: string | null | undefined): string | null {
  const match = DATE.exec((value ?? "").trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/**
 * Payment terms as the two dates state them, not as the app assumes.
 *
 * A COD customer is not on fourteen days, and saying so would put every one of
 * their invoices into the overdue chase a fortnight late.
 */
export function termsDays(issue: string | null, due: string | null): number {
  if (!issue || !due) return 0;
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${issue}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(days) ? Math.max(days, 0) : 0;
}

/** `CUST00042` — the app's own party-number shape. */
export function partyNumber(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(5, "0")}`;
}

/**
 * RFC 4122 name-based UUID (version 5), byte-for-byte what Python's
 * `uuid.uuid5` produces for the same namespace and name.
 */
export function uuid5(name: string): string {
  const hash = createHash("sha1");
  hash.update(Buffer.from(NAMESPACE.replace(/-/g, ""), "hex"));
  hash.update(Buffer.from(name, "utf8"));
  const bytes = hash.digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join("-");
}

/**
 * The id a party will always have.
 *
 * A party's natural key is its name and there is no unique index on it to
 * conflict against, so the id carries the identity instead. Numbers cannot: they
 * are assigned in sequence, so the same number can land on a different business
 * between one export and the next.
 */
export function ident(tenantId: string, table: string, key: string): string {
  return uuid5(`${tenantId}:${table}:${key}`);
}
