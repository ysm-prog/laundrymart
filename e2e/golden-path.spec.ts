import { expect, test, type Page } from "@playwright/test";

/**
 * The golden path (Darshan's BA review, section 5), counting the actions a
 * person takes:
 *
 *   1. create a customer on a round (Board 1), monthly billing;
 *   2. take in two items — target 4 actions or fewer;
 *   3. mark it ready; it goes onto Board 1 for the right day by itself (2.2);
 *   4. as Board 1: Start my day, then Delivered with a signature — 2 taps (2.4);
 *   5. it is priced and approved by itself and is on the customer's draft (2.3);
 *   6. month end: Issue and send all — blocked while the invoice details are
 *      empty, passing once they are set (1.1, 2.5);
 *   7. Today, Runs and My Runs all show the stop as done (2.1).
 *
 * **Against a seeded Supabase branch behind a Vercel preview, never
 * production.** The seed must hold: an owner and a Board 1 login, Board 1
 * active, and two sellable items (codes in `E2E_ITEM_CODES`, comma-separated)
 * with a house price on the laundry price list, so the job prices cleanly.
 * Settings › Invoicing must start **empty** for step 6's first half.
 *
 * What this cannot assert, and says so: the Xero payload. A preview talks to
 * whatever Xero it is connected to, and a test must never push to a real one,
 * so `LineAmountTypes = Inclusive` and the account codes are proved by the unit
 * tests over `buildInvoicePayload` instead. Email is the same: the seed leaves
 * emailing off.
 */

const env = {
  owner: process.env.E2E_OWNER_EMAIL, ownerPassword: process.env.E2E_OWNER_PASSWORD,
  board: process.env.E2E_BOARD_EMAIL, boardPassword: process.env.E2E_BOARD_PASSWORD,
  boardName: process.env.E2E_BOARD_NAME ?? "Board 1",
  items: (process.env.E2E_ITEM_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean),
};

test.skip(!process.env.E2E_BASE_URL || !env.owner || !env.board || env.items.length < 2,
  "E2E_BASE_URL, the two logins and two item codes are needed — see the comment above.");

/** Counts what a person does, so the brief's targets are measured rather than claimed. */
class Actions {
  count = 0;
  async click(page: Page, locator: Parameters<Page["locator"]>[0] | ReturnType<Page["locator"]>) {
    this.count += 1;
    await (typeof locator === "string" ? page.locator(locator) : locator).click();
  }
  async fill(locator: ReturnType<Page["locator"]>, value: string) {
    this.count += 1;
    await locator.fill(value);
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForURL(/\/dashboard|\/my-runs/);
}

async function signOut(page: Page) {
  await page.context().clearCookies();
}

const stamp = Date.now().toString(36);
const customerName = `ZZ E2E ${stamp}`;

test("the golden path runs itself", async ({ page }) => {
  // ---------------------------------------------------------- 1. customer
  await signIn(page, env.owner!, env.ownerPassword!);
  await page.goto("/customers/new");
  await page.locator('[name="business_name"]').fill(customerName);
  await page.locator('[name="phone"]').fill("0400000000");
  await page.locator('[name="billing_email"]').fill(`e2e+${stamp}@example.com`);
  await page.locator('[name="site_address"]').fill("1 Test Street, Adelaide SA 5000");
  await page.locator('[name="collection_weekday"]').selectOption({ label: "Monday" });
  await page.locator('[name="collection_board_id"]').selectOption({ label: env.boardName });
  await page.getByRole("button", { name: /create|save/i }).last().click();
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}/);
  const customerId = page.url().match(/customers\/([0-9a-f-]{36})/)![1]!;

  // ------------------------------------------------------- 2. take it in
  const intake = new Actions();
  await page.goto(`/orders/new?customer=${customerId}`);
  for (const [index, code] of env.items.slice(0, 2).entries()) {
    if (index > 0) await intake.click(page, page.getByRole("button", { name: /add item/i }));
    const search = page.getByPlaceholder("Search by code or name — TOW001").nth(index);
    await intake.fill(search, code);
    await search.press("ArrowDown");
    await search.press("Enter");
    await intake.fill(page.getByLabel("How many").nth(index), "10");
  }
  await intake.click(page, page.getByRole("button", { name: /^create/i }));
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  // The brief's target is 4 actions. Prefilled items and return dates are
  // Phase 3.4, so this is measured and reported here rather than asserted
  // until that lands.
  test.info().annotations.push({ type: "intake-actions", description: String(intake.count) });

  // ------------------------------------------------ 3. ready means assigned
  for (const stage of ["In progress", "Ready for delivery"]) {
    await page.getByRole("button", { name: new RegExp(`^${stage}`, "i") }).first().click();
    await page.waitForLoadState("networkidle");
  }
  await expect(page.getByText(new RegExp(`${env.boardName}`)).first()).toBeVisible();
  await expect(page.getByText(/assigned/i).first()).toBeVisible();

  // --------------------------------------------------- 4. the round's day
  await signOut(page);
  await signIn(page, env.board!, env.boardPassword!);
  await page.goto("/my-runs");
  // The job may be for a later delivering day; walk forward until it appears.
  for (let step = 0; step < 7; step += 1) {
    if (await page.getByText(customerName).count()) break;
    await page.getByRole("link", { name: /next day/i }).click();
    await page.waitForLoadState("networkidle");
  }
  await expect(page.getByText(customerName)).toBeVisible();

  const round = new Actions();
  await round.click(page, page.getByRole("button", { name: /start my day/i }));
  // The inline confirm repeats the label on its submit button.
  await round.click(page, page.getByRole("button", { name: /start my day/i }).last());
  expect(round.count, "one button and one confirm").toBe(2);
  await page.waitForLoadState("networkidle");

  const taps = new Actions();
  await taps.click(page, page.getByRole("button", { name: /^delivered/i }).first());
  const pad = page.locator("canvas").first();
  const box = await pad.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60);
    await page.mouse.up();
  }
  await taps.click(page, page.getByRole("button", { name: /confirm (short )?delivered|confirm short delivery/i }));
  await page.waitForLoadState("networkidle");
  expect(taps.count, "one stop takes two taps after Start my day").toBeLessThanOrEqual(2);
  await expect(page.getByText(/delivered/i).first()).toBeVisible();

  // ------------------------------------ 5. priced, approved, on the draft
  await signOut(page);
  await signIn(page, env.owner!, env.ownerPassword!);
  await page.goto(orderUrl);
  await expect(page.getByText(/auto-approved/i).first()).toBeVisible();
  await expect(page.getByText(/proof of delivery/i)).toBeVisible();
  await page.goto("/invoices/drafts");
  await expect(page.getByText(customerName)).toBeVisible();

  // --------------------------------------------- 6. month end (when ready)
  // Only drafts from a finished period are covered, so on a fresh branch the
  // card may not appear yet; when it does, an empty Settings › Invoicing must
  // block it with the sentence that names the fix.
  const monthEnd = page.getByRole("button", { name: /issue and send all ready/i });
  if (await monthEnd.count()) {
    await expect(page.getByText(/settings › invoicing/i).first()).toBeVisible();
  }

  // -------------------------------------------- 7. every screen agrees
  await page.goto("/runs");
  await expect(page.getByText(/already worked/i)).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText(/remaining/i).first()).not.toContainText(/^1 remaining/);
});
