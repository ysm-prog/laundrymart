/**
 * The one email shell — YSM Hub's paper-and-ink language, in a mail client.
 *
 * Every transactional email this app sends is built on this module: the invoice
 * and its PDF, the delivery confirmation, the overdue chase, the invitation and
 * the sign-in link. Before it, four templates each carried their own copy of the
 * same `<!doctype html>`, the same grey `#f6f7f9` page and the same system font
 * stack — none of which was the brand. Only one of the four used the teal at
 * all, and it used it in one button.
 *
 * **Literal hex, not tokens, and that is not laziness.** `globals.css` drives
 * the app from CSS custom properties; a mail client cannot be relied on for
 * `var()`, for `<style>` blocks, or for anything but inline attributes. So the
 * palette below is YSM Hub's `src/index.css` transcribed byte for byte — the
 * same source CLAUDE.md §10b records the app's own tokens being converted from.
 * Transcribed rather than re-derived from our HSL: those were rounded to one
 * decimal to round-trip, and going back through HSL a second time is how a
 * near-miss creeps in.
 *
 * **The Core IT credit is customer-facing only.** That is YSM Hub's own rule,
 * written at the top of its `lib/_credit.js`: the credit goes on mail a
 * *customer* reads and never on internal or staff mail. An invitation telling a
 * counter hand to choose a password is not marketing surface, so `audience`
 * decides, and the default is the safe one.
 */

/** Customer and tenant names are user input and go straight into markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * YSM Hub's palette, from `ysm-prog/ysm-hub` `src/index.css`.
 *
 * Frozen and exported so the templates cannot quietly reintroduce a literal —
 * `email-branding.test.ts` reads every template and fails on a hex that is not
 * in here, which is the mechanism that stops the drift this module exists to
 * end. Names match the app's own token names rather than YSM's variable names,
 * so a reader moving between `globals.css` and here is not translating twice.
 */
export const EMAIL_PALETTE = Object.freeze({
  /** `--paper` — the page behind the card. */
  paper: "#F4F1EA",
  /** `--app-panel` — the card itself, warm off-white rather than pure white. */
  surface: "#FBF9F3",
  /** `--paper-2` — a sunken row inside the card. */
  surfaceMuted: "#EFEBE3",
  /** `--ink` — headings. */
  ink: "#121A19",
  /** `--ink-2` — body copy. */
  inkBody: "#3A4543",
  /** `--ink-3` — supporting text. 5.4:1 on paper, so it clears AA. */
  inkMuted: "#5F645F",
  /** `--ink-4` — the quietest line on the page. Never load-bearing. */
  inkFaint: "#878C86",
  /** `--rule` / `--rule-soft` — hairlines, in stone rather than cool grey. */
  rule: "#D9D3C6",
  ruleSoft: "#E4DFD3",
  /** `--accent` — the one brand colour. Actions and links, never status. */
  accent: "#01696F",
  accentDeep: "#044247",
  accentTint: "#E3EEEC",
  /** The semantic four, always paired with a written word (§10b). */
  ok: "#2C5C2E",
  okTint: "#E2EBE2",
  warn: "#A8431E",
  warnTint: "#F3E2D8",
  danger: "#B52B2B",
  dangerTint: "#F7E3E3",
} as const);

const P = EMAIL_PALETTE;

/**
 * The font stack.
 *
 * `next/font` self-hosts Instrument Sans for the app; an email cannot carry a
 * webfont anywhere worth relying on, so the stack *names* it for the handful of
 * clients with it installed and falls straight through to the system UI face
 * everywhere else. Naming it costs nothing and is the only way the two ever
 * match; assuming it would be the mistake.
 */
const FONT = "'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
  + "Helvetica,Arial,sans-serif";

/** Who is reading. Decides the Core IT credit, and nothing else. */
export type EmailAudience = "customer" | "staff";

const COREIT_URL = "https://coreit.com.au/";
const COREIT_LABEL = "CoreIT";
const COREIT_PREFIX = "App is developed & designed by ";

/**
 * The Core IT credit, matching `ysm-hub`'s `lib/_credit.js` line for line —
 * same wording, same 11.5px, same centred grey, and only the label hyperlinked.
 *
 * YSM Hub carries a signed per-customer tracking URL here. This app has no
 * counterpart to attribute a click to and no table to record one in, so the
 * link goes straight to coreit.com.au; inventing a tracking scheme nothing
 * reads would be a second thing to keep in step for no answer.
 */
export function coreItCreditHtml(): string {
  return `<p style="text-align:center;margin:18px 0 4px;font-family:${FONT};font-size:11.5px;`
    + `line-height:1.4;color:${P.inkFaint};">`
    + `${COREIT_PREFIX.replace(/&/g, "&amp;")}`
    + `<a href="${COREIT_URL}" style="color:${P.accent};font-weight:600;text-decoration:none;">`
    + `${COREIT_LABEL}</a></p>`;
}

/** Plain text cannot hyperlink, so the label stands alone — no raw URL. */
export function coreItCreditText(): string {
  return COREIT_PREFIX + COREIT_LABEL;
}

/**
 * The hidden line a mail client shows beside the subject in the inbox list.
 *
 * Without it the preview is whatever the first words of the body happen to be,
 * which for a card layout is often the laundry's name repeated — the reader
 * learns nothing from the list. The spacer entity run is the standard trick to
 * stop the client pulling body copy in after it.
 */
function preheader(text: string): string {
  if (!text) return "";
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">`
    + `${escapeHtml(text)}${"&#8203;&nbsp;".repeat(60)}</div>`;
}

export type ShellOptions = {
  audience: EmailAudience;
  /** The masthead. The *laundry's* name — an invoice comes from them, not from us. */
  brandName: string;
  /** The one line under it saying what this is: "Invoice INV00042". */
  eyebrow?: string;
  /** Inbox preview text. Worth writing; the subject is not enough on its own. */
  preview?: string;
  /** The body, already-escaped HTML built from the helpers below. */
  body: string;
  /** The quiet last line inside the card — an ABN, a sender name. */
  footNote?: string;
};

/**
 * Wrap a body in the branded shell.
 *
 * A table-based outer wrapper rather than a bare `<div>`: Outlook on Windows
 * renders through Word, which ignores `max-width` on a div and lets the card
 * run the full width of a maximised window. The table is the thing that has
 * worked in every client for fifteen years, and it costs four lines.
 */
export function emailShell(options: ShellOptions): string {
  const { audience, brandName, eyebrow, preview, body, footNote } = options;

  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
  </head>
  <body style="margin:0;padding:0;background:${P.paper};font-family:${FONT};color:${P.inkBody};">
    ${preheader(preview ?? "")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${P.paper};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
                 style="width:100%;max-width:560px;background:${P.surface};
                        border:1px solid ${P.ruleSoft};border-radius:12px;">
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0;font-family:${FONT};font-size:18px;line-height:1.3;
                           font-weight:600;color:${P.ink};">${escapeHtml(brandName)}</h1>
                ${eyebrow
                  ? `<p style="margin:4px 0 0;font-family:${FONT};font-size:13px;`
                    + `color:${P.inkMuted};">${escapeHtml(eyebrow)}</p>`
                  : ""}
                <div style="height:1px;background:${P.ruleSoft};margin:18px 0 20px;"></div>
                ${body}
                ${footNote
                  ? `<p style="margin:22px 0 0;font-family:${FONT};font-size:12px;`
                    + `color:${P.inkFaint};">${escapeHtml(footNote)}</p>`
                  : ""}
              </td>
            </tr>
          </table>
          ${audience === "customer" ? coreItCreditHtml() : ""}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Body copy. Escapes its own text, so a customer named `A & B` is safe. */
export function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.6;`
    + `color:${P.inkBody};">${escapeHtml(text)}</p>`;
}

/** Supporting copy — the sentence after the point, not the point. */
export function mutedParagraph(text: string): string {
  return `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;`
    + `color:${P.inkMuted};">${escapeHtml(text)}</p>`;
}

/**
 * A status line, always with its word beside it.
 *
 * §10b's rule holds in the inbox as much as on screen: colour never carries the
 * meaning on its own, because a colour-blind reader and a plain-text client
 * both lose it. The tone tints the strip; the sentence says what happened.
 */
export function notice(tone: "ok" | "warn" | "danger", text: string): string {
  const colour = { ok: P.ok, warn: P.warn, danger: P.danger }[tone];
  const tint = { ok: P.okTint, warn: P.warnTint, danger: P.dangerTint }[tone];
  return `<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:${tint};`
    + `font-family:${FONT};font-size:14px;line-height:1.5;color:${colour};">`
    + `${escapeHtml(text)}</p>`;
}

/** The one action. Teal, because teal means "this is the thing to press". */
export function button(href: string, label: string): string {
  return `<p style="margin:20px 0;">`
    + `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 26px;`
    + `border-radius:6px;background:${P.accent};color:#ffffff;font-family:${FONT};`
    + `font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a></p>`;
}

/** A label/value summary — an amount, a due date, a count of towels. */
export function summary(rows: ReadonlyArray<{ label: string; value: string }>): string {
  if (rows.length === 0) return "";
  const cells = rows.map(({ label, value }) => `
        <tr>
          <td style="padding:6px 0;font-family:${FONT};font-size:14px;color:${P.inkMuted};">
            ${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-family:${FONT};font-size:14px;text-align:right;
                     font-weight:600;color:${P.ink};">${escapeHtml(value)}</td>
        </tr>`).join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;border-collapse:collapse;margin:16px 0;
                  border-top:1px solid ${P.ruleSoft};border-bottom:1px solid ${P.ruleSoft};">
        ${cells}
      </table>`;
}

/**
 * Append the Core IT credit to a plain-text body, for a customer email only.
 *
 * The HTML half is handled by the shell; this is the text half, kept beside it
 * so the two cannot disagree about who gets a credit.
 */
export function withTextCredit(audience: EmailAudience, text: string): string {
  return audience === "customer" ? `${text}\n\n${coreItCreditText()}` : text;
}
