/**
 * The exception vocabulary, shared by the job page's office form, the driver's
 * in-run capture and the sync endpoint — one list, so a reason recorded at the
 * kerb is the same reason the office resolves. (Constants live here rather than
 * in `actions.ts` because a "use server" file may only export async functions.)
 */

export const EXCEPTION_REASON_VALUES = [
  "customer_closed", "no_access", "nothing_to_collect", "vehicle_issue",
  "customer_refused", "short_delivery", "other",
] as const;

export type ExceptionReason = (typeof EXCEPTION_REASON_VALUES)[number];

export const EXCEPTION_REASONS: ReadonlyArray<{ value: ExceptionReason; label: string }> = [
  { value: "customer_closed", label: "Customer closed" },
  { value: "no_access", label: "No access" },
  { value: "nothing_to_collect", label: "Nothing to collect" },
  { value: "vehicle_issue", label: "Vehicle issue" },
  { value: "customer_refused", label: "Customer refused" },
  { value: "short_delivery", label: "Short delivery" },
  { value: "other", label: "Other" },
];
