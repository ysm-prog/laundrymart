import { describe, expect, it } from "vitest";
import { chooseDeliverySource, describeUnavailable } from "@/lib/routes/delivery-stock";

const VAN = "11111111-1111-1111-1111-111111111111";
const DEPOT = "22222222-2222-2222-2222-222222222222";

describe("chooseDeliverySource", () => {
  it("takes it off the van when the van really has it", () => {
    // The original behaviour, kept intact: anything that did reach `in_transit`
    // — a same-visit swap, or a load step if one is ever built — still goes out
    // from the van, so the ledger keeps naming the vehicle.
    expect(chooseDeliverySource({
      quantity: 12, onVehicle: 20, atDepot: 400, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: "in_transit", vehicleId: VAN });
  });

  it("falls back to the depot when nothing was ever loaded", () => {
    // The whole bug. Every pool on the live deployment was `at_depot`; not one
    // row was `in_transit`, because confirmLoad records no movement. This case
    // used to fail with "only 0 of that item are in transit".
    expect(chooseDeliverySource({
      quantity: 12, onVehicle: 0, atDepot: 400, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: "at_depot", depotId: DEPOT });
  });

  it("falls back whole rather than splitting a short van", () => {
    // Five aboard and twelve going out takes all twelve from the depot, so one
    // delivery line stays one ledger row. The five are swept back by the unload.
    expect(chooseDeliverySource({
      quantity: 12, onVehicle: 5, atDepot: 400, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: "at_depot", depotId: DEPOT });
  });

  it("uses the van when it holds exactly enough", () => {
    expect(chooseDeliverySource({
      quantity: 12, onVehicle: 12, atDepot: 0, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: "in_transit", vehicleId: VAN });
  });

  it("reports rather than overdrawing when neither pool can cover it", () => {
    // move_inventory() would refuse this anyway — the point is that the refusal
    // now names the item and says where the stock is, instead of describing a
    // transit state the operator never saw.
    expect(chooseDeliverySource({
      quantity: 12, onVehicle: 5, atDepot: 3, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: null, onVehicle: 5, atDepot: 3 });
  });

  it("ignores a pool whose location the run does not have", () => {
    // A run with no vehicle cannot draw from a van, and one with no depot
    // cannot draw from a depot, however much stock happens to sit there.
    expect(chooseDeliverySource({
      quantity: 5, onVehicle: 99, atDepot: 0, vehicleId: null, depotId: DEPOT,
    })).toEqual({ from: null, onVehicle: 99, atDepot: 0 });

    expect(chooseDeliverySource({
      quantity: 5, onVehicle: 0, atDepot: 99, vehicleId: VAN, depotId: null,
    })).toEqual({ from: null, onVehicle: 0, atDepot: 99 });
  });

  it("never sources a line of zero from anywhere real", () => {
    // Guarded by the caller, but if it ever arrives here it must not invent a
    // movement: zero is satisfiable from either pool and the caller skips it.
    expect(chooseDeliverySource({
      quantity: 0, onVehicle: 0, atDepot: 0, vehicleId: VAN, depotId: DEPOT,
    })).toEqual({ from: "in_transit", vehicleId: VAN });
  });
});

describe("describeUnavailable", () => {
  it("says where the stock actually is", () => {
    const message = describeUnavailable("Table Cloth — White", 12, 5, 3);
    expect(message).toContain("Table Cloth — White");
    expect(message).toContain("5 on the van");
    expect(message).toContain("3 at the depot");
    expect(message).toContain("12");
  });

  it("does not mention a pool that is empty", () => {
    expect(describeUnavailable("Tea Towel — Check", 12, 0, 4))
      .not.toContain("on the van");
    expect(describeUnavailable("Tea Towel — Check", 12, 4, 0))
      .not.toContain("at the depot");
  });

  it("points at stock when there is none of it anywhere", () => {
    const message = describeUnavailable("Tea Towel — Check", 12, 0, 0);
    expect(message).toContain("no Tea Towel — Check");
    expect(message).toContain("Linen");
  });
});
