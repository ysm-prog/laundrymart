import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The golden path (Darshan's BA review, section 5), counting the actions a
 * person takes:
 *
 *   1. create a customer on a round (Board 1) with a billing method, in one
 *      form (3.6);
 *   2. take in two items. A customer's first job has nothing to prefill from,
 *      so it is measured and reported; their **second** — the ordinary weekly
 *      case — is held to the brief's target of **4 actions or fewer**, with the
 *      items, the return date and the prices filled in (3.4);
 *   3. mark it ready **by scanning its docket** into the Laundry board (3.3);
 *      it goes onto Board 1 for the right day by itself (2.2);
 *   4. as Board 1: Start my day, then Delivered with a signature — 2 taps (2.4);
 *   5. it is priced and approved by itself and is on the customer's draft,
 *      with the item's name on the line (2.3, 3.5);
 *   6. Issue is **blocked** while Settings › Invoicing is empty, and — when the
 *      seeded branch's invoice details are supplied — **passes** once they are
 *      set, behind a confirm (1.1, 1.6);
 *   7. Today, Runs and My Runs all show the stop as done (2.1).
 *
 * **Against a seeded Supabase branch behind a Vercel preview, never
 * production.** The seed must hold: an owner and a Board 1 login, Board 1
 * active, and two sellable items (codes in `E2E_ITEM_CODES`, comma-separated)
 * with a house price on the laundry price list, so the job prices cleanly.
 * Settings › Invoicing must start **empty** for step 6's first half, and the
 * branch must have **no Xero connection and emailing off**.
 *
 * What this cannot assert, and says so: the Xero payload. A test must never
 * push to a real Xero, so `LineAmountTypes = Inclusive` and the account codes
 * are proved by the unit tests over `buildInvoicePayload` instead. The month-end
 * button issues only drafts from a **finished** period, which a fresh branch
 * does not have, so step 6 issues the one draft directly — the same
 * `issueOneInvoice` the month-end button calls for each draft.
 *
 * No invoice details are written into this file (the brief's rule): the second
 * half of step 6 reads them from `E2E_INVOICE_*` and is skipped, with an
 * annotation, when they are not set.
 */

const env = {
  owner: process.env.E2E_OWNER_EMAIL, ownerPassword: process.env.E2E_OWNER_PASSWORD,
  board: process.env.E2E_BOARD_EMAIL, boardPassword: process.env.E2E_BOARD_PASSWORD,
  boardName: process.env.E2E_BOARD_NAME ?? "Board 1",
  items: (process.env.E2E_ITEM_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean),
  invoice: {
    abn: process.env.E2E_INVOICE_ABN,
    address: process.env.E2E_INVOICE_ADDRESS,
    accountName: process.env.E2E_INVOICE_ACCOUNT_NAME,
    bsb: process.env.E2E_INVOICE_BSB,
    accountNumber: process.env.E2E_INVOICE_ACCOUNT_NUMBER,
  },
};

test.skip(!process.env.E2E_BASE_URL || !env.owner || !env.board || env.items.length < 2,
  "E2E_BASE_URL, the two logins and two item codes are needed — see the comment above.");

/** Counts what a person does, so the brief's targets are measured rather than claimed. */
class Actions {
  count = 0;
  async click(locator: Locator) {
    this.count += 1;
    await locator.click();
  }
  async fill(locator: Locator, value: string) {
    this.count += 1;
    await locator.fill(value);
  }
  async press(locator: Locator, key: string) {
    this.count += 1;
    await locator.press(key);
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForURL(/\/dashboard|\/my-runs/);
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
  // 3.6: the round, the day and the billing method sit with the essentials.
  await page.locator('[name="collection_board_id"]').first().selectOption({ label: env.boardName });
  await page.locator('[name="collection_weekday"]').first().selectOption({ label: "Monday" });
  await page.locator('[name="billing_method"]').first().selectOption("monthly_consolidated");
  await page.getByRole("button", { name: /create|save/i }).last().click();
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}/);
  const customerId = page.url().match(/customers\/([0-9a-f-]{36})/)![1]!;

  // ---------------------------------------- 2a. the first job, measured
  const first = new Actions();
  await page.goto(`/orders/new?customer=${customerId}`);
  for (const [index, code] of env.items.slice(0, 2).entries()) {
    if (index > 0) await first.click(page.getByRole("button", { name: /add item/i }));
    const search = page.getByPlaceholder("Search by code or name — TOW001").nth(index);
    await first.fill(search, code);
    await search.press("ArrowDown");
    await first.press(search, "Enter");
    await first.fill(page.getByLabel("How many").nth(index), "10");
  }
  // 3.4: the return date is the round's next visit — already filled.
  await expect(page.locator('input[name="expected_delivery_date"]')).not.toHaveValue("");
  await first.click(page.getByRole("button", { name: /^create job/i }));
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}/);
  const orderUrl = page.url().replace(/\?.*$/, "");
  const orderNumber = (await page.getByRole("heading", { level: 1 }).first().innerText())
    .match(/[A-Z]{1,4}\d{5,}/)![0];
  test.info().annotations.push({ type: "first-intake-actions", description: String(first.count) });

  // ------------------------- 2b. the next job, prefilled — target ≤ 4 actions
  const repeat = new Actions();
  await page.goto(`/orders/new?customer=${customerId}`);
  await expect(page.getByText(new RegExp(`Filled in from ${orderNumber}`))).toBeVisible();
  await expect(page.getByLabel("How many").first()).toHaveValue("10");
  await expect(page.locator('input[name="expected_delivery_date"]')).not.toHaveValue("");
  // The owner reads prices, so the running total is on screen before saving.
  await expect(page.getByText(/incl\. GST/).first()).toBeVisible();
  await repeat.click(page.getByRole("button", { name: /^create job/i }));
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}/);
  expect(repeat.count, "a repeat job is taken in within four actions").toBeLessThanOrEqual(4);

  // --------------------------------- 3. scan the docket: ready means assigned
  await page.goto(`${orderUrl}/docket`);
  await expect(page.getByRole("img", { name: `Barcode ${orderNumber}` })).toBeVisible();
  await page.goto("/orders/board");
  const scan = page.locator("#docket");
  await scan.fill(orderNumber);
  await scan.press("Enter");
  await page.waitForLoadState("networkidle");
  await page.goto(orderUrl);
  await expect(page.getByText(new RegExp(`On ${env.boardName}`)).first()).toBeVisible();

  // --------------------------------------------------- 4. the round's day
  await signIn(page, env.board!, env.boardPassword!);
  await page.goto("/my-runs");
  // The job is for the round's next delivering day; walk forward until it appears.
  for (let step = 0; step < 8; step += 1) {
    if (await page.getByText(customerName).count()) break;
    await page.getByRole("link", { name: "Next day" }).click();
    await page.waitForLoadState("networkidle");
  }
  await expect(page.getByText(customerName).first()).toBeVisible();
  const day = new URL(page.url()).searchParams.get("date");

  const start = new Actions();
  await start.click(page.getByRole("button", { name: /start my day/i }).first());
  // The inline confirm repeats the label on its submit button.
  await start.click(page.getByRole("button", { name: /start my day/i }).last());
  expect(start.count, "one button and one confirm").toBe(2);
  await page.waitForLoadState("networkidle");

  const taps = new Actions();
  await taps.click(page.getByRole("button", { name: /^delivered/i }).first());
  const pad = page.locator("canvas").first();
  const box = await pad.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60);
    await page.mouse.up();
  }
  await taps.click(page.getByRole("button", { name: /confirm (short )?deliver/i }));
  await page.waitForLoadState("networkidle");
  expect(taps.count, "one stop takes two taps after Start my day").toBeLessThanOrEqual(2);
  // My Runs: the job is under Completed now.
  const completed = page.locator("section").filter({ has: page.getByRole("heading", { name: /^completed/i }) });
  await expect(completed.getByText(customerName).first()).toBeVisible();

  // ------------------------------------ 5. priced, approved, on the draft
  await signIn(page, env.owner!, env.ownerPassword!);
  await page.goto(orderUrl);
  await expect(page.getByText(/auto-approved/i).first()).toBeVisible();
  await expect(page.getByText(/proof of delivery/i).first()).toBeVisible();
  await expect(page.getByText(/delivered it on/i).first()).toBeVisible(); // 3.8's timeline
  await page.goto("/invoices/drafts");
  const draftCard = () => page.locator("div")
    .filter({ hasText: customerName })
    .filter({ has: page.getByRole("button", { name: /issue now/i }) })
    .last();
  const draft = draftCard();
  await expect(draft).toBeVisible();

  // ------------------------------------------- 6. issue: blocked, then not
  const issue = draft.getByRole("button", { name: /issue now/i });
  await expect(issue).toBeDisabled();
  await expect(draft.getByText(/settings › invoicing/i).first()).toBeVisible();

  const details = env.invoice;
  if (details.abn && details.address && details.accountName && details.bsb && details.accountNumber) {
    await page.goto("/admin/invoicing");
    await page.locator('[name="abn"]').fill(details.abn);
    await page.locator('[name="address_1"]').fill(details.address);
    await page.locator('[name="bank_account_name"]').fill(details.accountName);
    await page.locator('[name="bsb"]').fill(details.bsb);
    await page.locator('[name="account_number"]').fill(details.accountNumber);
    await page.getByRole("button", { name: /save invoice details/i }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/invoices/drafts");
    await draftCard().getByRole("button", { name: /issue now/i }).click();
    // 1.6: pressing Issue asks first — nothing has been issued yet.
    await expect(page.getByRole("button", { name: /keep it as a draft/i })).toBeVisible();
    await page.getByRole("button", { name: /issue now/i }).last().click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerName)).toHaveCount(0);
  } else {
    test.info().annotations.push({
      type: "issue-pass-half",
      description: "skipped: set E2E_INVOICE_ABN/ADDRESS/ACCOUNT_NAME/BSB/ACCOUNT_NUMBER to run it",
    });
  }

  // -------------------------------------------- 7. every screen agrees
  if (day) {
    await page.goto(`/runs?date=${day}`);
    await expect(page.getByText(/already worked/i).first()).toBeVisible();
    await expect(page.getByText(customerName)).toHaveCount(0); // nothing left to move
  }
  await page.goto("/dashboard");
  // Today's inbox: the job is neither waiting for a driver nor for a price.
  await expect(page.getByText(customerName)).toHaveCount(0);
});
