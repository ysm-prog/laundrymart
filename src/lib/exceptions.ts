/**
 * Exception notes with photos, without a migration.
 *
 * A job's exception is two text columns (`exception_reason`, `exception_notes`)
 * and nothing else — there is nowhere structured to put the photo a driver
 * takes of the locked gate. Rather than add a column for Phase B (which is
 * migration-free by design), the photo's storage path travels inside the notes
 * as a `[photo:…]` marker: self-describing in a raw dump, harmless to a reader
 * that doesn't strip it, and reversible the day a real column exists.
 *
 * Every display site goes through `parseExceptionNotes` so the marker never
 * reaches the eye; the photo renders from the path via the usual signed URL.
 */

const PHOTO_MARKER = /\[photo:([^\]\s]+)\]/g;

export function packExceptionNotes(note: string | null | undefined, photoPaths: string[]): string | null {
  const text = note?.trim() ?? "";
  const markers = photoPaths.map((path) => `[photo:${path}]`).join(" ");
  const packed = [text, markers].filter(Boolean).join("\n");
  return packed || null;
}

export function parseExceptionNotes(raw: string | null | undefined): { note: string; photos: string[] } {
  if (!raw) return { note: "", photos: [] };
  const photos = [...raw.matchAll(PHOTO_MARKER)].map((match) => match[1]!);
  const note = raw.replace(PHOTO_MARKER, "").replace(/[ \t]+\n/g, "\n").trim();
  return { note, photos };
}
