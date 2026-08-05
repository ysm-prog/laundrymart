import { redirect } from "next/navigation";
import { z } from "zod";

/**
 * Shared plumbing for server actions.
 *
 * The convention across the app: actions never return error objects to the
 * client. They redirect back to the originating page with `?error=` or `?ok=`,
 * which keeps the pages server-rendered and the messages linkable/refreshable.
 */

export function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export function done(path: string, message: string): never {
  redirect(`${path}?ok=${encodeURIComponent(message)}`);
}

/**
 * Where an action should redirect back to, when the caller knows better than the
 * action does — a two-pane screen wants the pane it was working in, not the
 * record's own page.
 *
 * The value arrives in a form field, so it is treated as hostile: anything that
 * is not a plain same-site path falls back. `//evil.example` is a protocol-
 * relative URL and would otherwise make every action an open redirect.
 */
export function returnTo(formData: FormData, fallback: string): string {
  const value = formData.get("return_to");
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

/** First validation message, or a generic fallback. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Please check the form and try again.";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

/* ------------------------------------------------------------- zod helpers */

/** Empty form inputs arrive as "" — treat them as absent, not as a value. */
export const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

export const optionalUuid = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().uuid().optional(),
);

export const optionalDate = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker").optional(),
);

export const requiredDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker");

export const money = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? 0 : Number(value)),
  z.number().finite().min(0, "Cannot be negative"),
);

export const percent = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? 0 : Number(value)),
  z.number().finite().min(0).max(100, "Must be between 0 and 100"),
);

export const count = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? 0 : Number(value)),
  z.number().int("Whole numbers only").min(0, "Cannot be negative"),
);

export const checkbox = z.preprocess((value) => value === "on" || value === "true", z.boolean());

/**
 * Storage keys posted by the media upload field as JSON in a hidden input.
 *
 * The files themselves went to `/api/media` before the form was submitted, so a
 * server action only ever sees the keys. Malformed input degrades to "no media"
 * rather than failing the whole save — losing the photo of a stop is bad, losing
 * the record of the stop is worse.
 */
export const mediaPaths = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}, z.array(z.string().max(400)).max(8));

/** `formData.getAll(name)` for a multi-checkbox group of ISO weekdays. */
export function weekdaysFrom(formData: FormData, name: string): number[] {
  return formData
    .getAll(name)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7)
    .sort((a, b) => a - b);
}

/** Turn FormData into a plain object Zod can parse. */
export function toObject(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

/** Human message from a Postgres error, without leaking internals. */
export function describeDbError(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "23505":
      return "That value is already in use — pick another.";
    case "23503":
      return "That record is still referenced by something else and cannot be removed.";
    case "42501":
      return "You do not have permission to do that.";
    case "P0001":
      // Our own business-rule triggers raise this with a human-readable message.
      return error.message.replace(/^ERROR:\s*/, "");
    default:
      return error.message;
  }
}
