import "server-only";
import { XERO_API } from "./config";
import { getXeroTokens } from "./tokens";

/**
 * The laundry's own Xero bank accounts, for the settings picker.
 *
 * Offered as a list rather than a text box because an account *code* is an
 * arbitrary number in somebody else's system — typing "090" from memory and
 * getting it wrong posts real money against the wrong account, and neither this
 * app nor the person would notice until a reconciliation.
 */
export type XeroBankAccount = { code: string; name: string };

export async function listXeroBankAccounts(tenantId: string): Promise<XeroBankAccount[]> {
  const tokens = await getXeroTokens(tenantId);
  if (!tokens) return [];

  try {
    const response = await fetch(
      `${XERO_API}/Accounts?where=${encodeURIComponent('Type=="BANK"')}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Xero-tenant-id": tokens.xeroTenantId,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) return [];

    const body = await response.json() as {
      Accounts?: { Code?: string; Name?: string }[];
    };
    return (body.Accounts ?? [])
      .filter((a): a is { Code: string; Name: string } => Boolean(a.Code && a.Name))
      .map((a) => ({ code: a.Code, name: a.Name }));
  } catch {
    // An empty list renders "could not read your accounts" on the screen, which
    // is honest — a connection problem here should not throw the settings page.
    return [];
  }
}
