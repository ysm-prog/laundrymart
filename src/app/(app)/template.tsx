import { cookies } from "next/headers";
import { FLASH_COOKIE, type Flash } from "@/lib/actions";
import { FlashToast } from "@/components/flash-toast";

/**
 * A template, not part of the layout, on purpose: templates re-render on every
 * navigation — including a server action redirecting back to the same path —
 * while the layout can be preserved. This is the one place the flash cookie
 * set by `fail()`/`done()` is guaranteed to be read exactly when it matters.
 */
export default async function FlashTemplate({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FlashToast flash={await readFlash()} />
      {children}
    </>
  );
}

async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null &&
      "tone" in parsed && (parsed.tone === "success" || parsed.tone === "error") &&
      "message" in parsed && typeof parsed.message === "string"
    ) {
      return { tone: parsed.tone, message: parsed.message };
    }
  } catch {
    // A mangled cookie is nobody's message — show nothing.
  }
  return null;
}
