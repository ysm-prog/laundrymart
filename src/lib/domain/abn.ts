/**
 * ABN validation (business rule §11).
 *
 * The ATO's check is a weighted modulus: subtract 1 from the first digit,
 * multiply each digit by its position weight, and the total must divide by 89.
 * It catches the transpositions that make a mistyped ABN look plausible.
 */
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

export function normaliseAbn(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function isValidAbn(value: string): boolean {
  const digits = normaliseAbn(value);
  if (!/^\d{11}$/.test(digits)) return false;

  const total = digits.split("").reduce((sum, digit, index) => {
    const n = Number(digit) - (index === 0 ? 1 : 0);
    return sum + n * (WEIGHTS[index] as number);
  }, 0);

  return total % 89 === 0;
}

/** `51 824 753 556` — the format the ATO prints. */
export function formatAbn(value: string): string {
  const digits = normaliseAbn(value);
  if (!/^\d{11}$/.test(digits)) return value;
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
}
