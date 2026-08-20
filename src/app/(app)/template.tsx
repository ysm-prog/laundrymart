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
      return { tone: parsed.tone, message: parsed.message, link: readLink(parsed) };
    }
  } catch {
    // A mangled cookie is nobody's message — show nothing.
  }
  return null;
}

/**
 * The cookie is not httpOnly, so its link is treated like any client input:
 * only a plain same-site path renders — never a protocol-relative or absolute
 * URL that would turn the toast into an open redirect.
 */
function readLink(parsed: object): Flash["link"] {
  if (!("link" in parsed) || typeof parsed.link !== "object" || parsed.link === null) return undefined;
  const link = parsed.link;
  if (
    "href" in link && typeof link.href === "string" &&
    link.href.startsWith("/") && !link.href.startsWith("//") && !link.href.startsWith("/\\") &&
    "label" in link && typeof link.label === "string" && link.label.length > 0
  ) {
    return { href: link.href, label: link.label };
  }
  return undefined;
}
