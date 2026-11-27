import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_LOT_PRICE, STANDARD_LOT_PRICE_EX_GST, readLotPrice } from "@/lib/domain/lot-booking";
import { can, membershipRolesWith } from "@/lib/roles";

const root = join(__dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("readLotPrice", () => {
  it.each([
    ["40", 40], ["42.5", 42.5], ["42.50", 42.5], [" 45 ", 45], ["$38.90", 38.9], ["0.01", 0.01],
  ])("accepts %j", (raw, price) => {
    expect(readLotPrice(raw)).toEqual({ ok: true, price });
  });

  it.each(["", "   ", "0", "0.00", "-5", "abc", "40.005", "1e2", "40,00"])("refuses %j", (raw) => {
    expect(readLotPrice(raw).ok).toBe(false);
  });

  it("refuses more than the database's check constraint allows", () => {
    expect(readLotPrice(String(MAX_LOT_PRICE)).ok).toBe(true);
    expect(readLotPrice(String(MAX_LOT_PRICE + 1)).ok).toBe(false);
    expect(read("supabase/migrations/0067_lot_price_setting.sql"))
      .toMatch(new RegExp(`unit_price_ex_gst <= ${MAX_LOT_PRICE}\\b`));
  });
});

describe("who may change the lot price", () => {
  const sql = read("supabase/migrations/0067_lot_price_setting.sql");

  it("is the pricing.write holders, in roles.ts and in 0067's policies alike", () => {
    const writers = membershipRolesWith("pricing.write").slice().sort();
    expect(writers).toEqual(["operations_manager", "super_admin"]);
    const arrays = [...sql.matchAll(/has_role\(tenant_id, array\[([^\]]+)\]\)/g)]
      .map((m) => m[1]!.split(",").map((r) => r.trim().replace(/'/g, "")).sort());
    // insert's with check, update's using and with check
    expect(arrays).toHaveLength(3);
    for (const roles of arrays) expect(roles).toEqual(writers);
  });

  it("is read through can_read_pricing, and a driver or the counter cannot see it on screen", () => {
    expect(sql).toMatch(/for select to authenticated\s+using \(\(select public\.can_read_pricing\(tenant_id\)\)\)/);
    expect(can("driver", "pricing.read")).toBe(false);
    expect(can("customer_service", "pricing.read")).toBe(false);
  });

  it("still defaults to the standard $40.00 where nothing is saved", () => {
    expect(sql).toMatch(/public\.standard_lot_price_ex_gst\(\)\s*\);/);
    expect(STANDARD_LOT_PRICE_EX_GST).toBe(40);
  });
});

describe("the seam between the card, the action and the job form", () => {
  const card = read("src/app/(app)/invoices/prices/lot-price-card.tsx");
  const actions = read("src/app/(app)/invoices/prices/actions.ts");
  const loader = read("src/lib/orders/lot-price.ts");
  const newPage = read("src/app/(app)/orders/new/page.tsx");
  const editPage = read("src/app/(app)/orders/[id]/edit/page.tsx");

  it("posts the field the action reads", () => {
    expect(card).toMatch(/name="lot_price_ex_gst"/);
    expect(actions).toMatch(/readLotPrice\(formData\.get\("lot_price_ex_gst"\)\)/);
  });

  it("guards the save on pricing.write and names the tenant", () => {
    const body = actions.slice(actions.indexOf("export async function saveLotPrice"));
    expect(body).toMatch(/assertCapability\("pricing\.write"\)/);
    expect(body).toMatch(/tenant_id: session\.tenantId/);
    expect(body).toMatch(/\.eq\("tenant_id", session\.tenantId\)/);
  });

  it("shows the job form the laundry's saved price rather than the constant", () => {
    for (const page of [newPage, editPage]) {
      expect(page).toMatch(/loadStandardLotPrice\(/);
      expect(page).not.toMatch(/STANDARD_LOT_PRICE_EX_GST/);
    }
    expect(loader).toMatch(/from\("tenant_lot_prices"\)[\s\S]*?\.eq\("tenant_id", tenantId\)/);
  });
});
