"use client";

import { TriangleAlert } from "lucide-react";

/**
 * The last boundary: an error thrown in the root layout itself.
 *
 * It replaces the root layout rather than rendering inside it, so it has to
 * supply its own `<html>` and `<body>` — and, less obviously, it cannot rely on
 * anything the root layout was going to set up. That is the whole reason this
 * file looks different from every other screen in the app:
 *
 * - **Every rule is an inline style.** `globals.css` is imported by the root
 *   layout, which is the thing that just failed; a stylesheet that did not load
 *   is one of the ordinary ways to arrive here, and a screen styled by
 *   `bg-background text-foreground` would then be black-on-white system default
 *   with a rail-shaped hole in it. Colours are the light-theme tokens' own hex
 *   values, written out (`#f4f1ea` is `--background`, `#121a19` is
 *   `--foreground`, `#b52b2b` is `--danger`, `#01696f` is `--action`), so this
 *   screen is the same paper-and-ink as the rest of the product even with no
 *   stylesheet at all.
 * - **The type is a system stack.** The three faces are loaded by `next/font`
 *   in the root layout and exposed as CSS variables there, so neither the fonts
 *   nor `--font-instrument-sans` can be assumed to exist here.
 * - **Light only.** The dark theme is a class the root layout's pre-paint script
 *   puts on `<html>`; that script has not run, so there is nothing to branch on
 *   and an inline style cannot carry a media query. `colorScheme: "light"` keeps
 *   the browser's own chrome in step rather than leaving dark scrollbars around
 *   a paper page.
 *
 * The support-reference rule is `SupportReference`'s, restated rather than
 * imported for the same reason as everything else here: **the error itself is
 * never rendered**, only Next's `digest` hash of it.
 */
export default function GlobalError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-AU">
      <body style={{
        margin: 0,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "4rem 1.5rem",
        backgroundColor: "#f4f1ea",
        color: "#121a19",
        colorScheme: "light",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: "0.9375rem",
        lineHeight: 1.6,
        WebkitFontSmoothing: "antialiased",
      }}>
        <main id="main" style={{ maxWidth: "28rem", textAlign: "center" }}>
          <span aria-hidden style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "3.5rem",
            height: "3.5rem",
            borderRadius: "9999px",
            backgroundColor: "rgba(181, 43, 43, 0.1)",
            color: "#b52b2b",
          }}>
            <TriangleAlert size={26} aria-hidden />
          </span>

          <h1 style={{ margin: "1.25rem 0 0", fontSize: "1.5rem", fontWeight: 600 }}>
            Electro Services could not start
          </h1>
          <p style={{ margin: "0.5rem 0 0", color: "#454945" }}>
            The application failed before any screen could be drawn. Nothing you had already
            saved is affected. If trying again does not help, the site is having a problem
            rather than your device.
          </p>

          <div style={{
            marginTop: "1.75rem",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "0.75rem",
          }}>
            <button type="button" onClick={reset} style={{
              minHeight: "2.75rem",
              padding: "0 1.25rem",
              borderRadius: "0.375rem",
              border: "none",
              backgroundColor: "#01696f",
              color: "#ffffff",
              font: "inherit",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}>
              Try again
            </button>
            <a href="/dashboard" style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: "2.75rem",
              padding: "0 1.25rem",
              borderRadius: "0.375rem",
              border: "1px solid #d9d3c6",
              backgroundColor: "#fbf9f3",
              color: "#121a19",
              fontSize: "0.875rem",
              fontWeight: 500,
              textDecoration: "none",
            }}>
              Go to today
            </a>
          </div>

          <p style={{ margin: "2.5rem 0 0", fontSize: "0.75rem", color: "#454945" }}>
            {error.digest ? (
              <>
                {"Quote support reference "}
                <span style={{
                  padding: "0.125rem 0.375rem",
                  borderRadius: "0.25rem",
                  backgroundColor: "#efebe3",
                  color: "#121a19",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                }}>
                  {error.digest}
                </span>
                {" if you report this."}
              </>
            ) : (
              "This one has no support reference: it happened in the browser rather than on the server."
            )}
          </p>
        </main>
      </body>
    </html>
  );
}
