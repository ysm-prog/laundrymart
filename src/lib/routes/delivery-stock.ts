/**
 * Where the clean linen a driver is handing over comes *from*.
 *
 * ## The bug this exists to fix
 *
 * A delivery has always moved stock `in_transit@vehicle → at_customer`, which
 * reads correctly: the linen was on the van, now it is at the customer. The
 * trouble is that **nothing ever put clean linen on the van.**
 *
 * `move_inventory()` has two halves in the run, and only one was built:
 * `lib/routes/unload.ts` sweeps `in_transit → at_depot` when the van comes
 * back, but `confirmLoad` records no movement at all — it stamps
 * `load_confirmed_at` and marks the jobs, and that is all. So `in_transit` is
 * populated *only* by pickups, which are the dirty linen coming the other way.
 *
 * The result on the live project was that **every delivery failed**, with the
 * guard in `move_inventory()` saying so exactly:
 *
 *     only 0 of that item are in transit, so 12 cannot be moved out
 *
 * and a driver standing at a customer with a signature pad and no way to
 * record the drop. Every pool on the deployment was `at_depot` or
 * `at_customer`; not one row was `in_transit`.
 *
 * ## The rule
 *
 * A delivery takes the linen from the van when the van actually has it, and
 * from the run's depot otherwise. Both are true statements about where the
 * linen was a moment ago, and the second is the one that matches how the app
 * really works today: clean linen leaves the plant to `at_depot` and is loaded
 * without anything being recorded, because the load step captures no
 * quantities — the counts are taken at the door, not at the depot.
 *
 * Preferring the van keeps the existing behaviour intact for anything that did
 * get there (a same-visit swap, or a future load step), so this only ever adds
 * a path that used to fail.
 *
 * **A short van falls back whole rather than splitting.** If five are aboard
 * and twelve are being handed over, all twelve come from the depot rather than
 * five from one pool and seven from another. One delivery line then means one
 * ledger row, which is what makes the movement history readable and
 * reconcilable; the five left aboard are swept back by the unload.
 *
 * Deliberately not solved here: a real load manifest. That would let the depot
 * hop be recorded when it happens rather than when the delivery is written, and
 * it needs a screen that captures what goes on the van. Until that exists this
 * is the honest reading of what the app knows.
 */

export type DeliverySource =
  | { from: "in_transit"; vehicleId: string }
  | { from: "at_depot"; depotId: string }
  | { from: null; onVehicle: number; atDepot: number };

export function chooseDeliverySource(input: {
  /** How many are being handed over. */
  quantity: number;
  /** Currently `in_transit` on this run's vehicle. */
  onVehicle: number;
  /** Currently `at_depot` at this run's depot. */
  atDepot: number;
  vehicleId: string | null;
  depotId: string | null;
}): DeliverySource {
  const { quantity, onVehicle, atDepot, vehicleId, depotId } = input;

  if (vehicleId && onVehicle >= quantity) {
    return { from: "in_transit", vehicleId };
  }
  if (depotId && atDepot >= quantity) {
    return { from: "at_depot", depotId };
  }
  return { from: null, onVehicle, atDepot };
}

/**
 * The sentence an operator gets when neither pool can cover the line.
 *
 * Names the item and says where the stock actually is, because the database's
 * own message ("only 0 of that item are in transit") describes a state the
 * screen never showed them and cannot act on.
 */
export function describeUnavailable(
  itemName: string,
  quantity: number,
  onVehicle: number,
  atDepot: number,
): string {
  const held = [
    onVehicle > 0 ? `${onVehicle} on the van` : null,
    atDepot > 0 ? `${atDepot} at the depot` : null,
  ].filter(Boolean).join(" and ");

  return held
    ? `There are only ${held} for ${itemName}, so ${quantity} cannot be delivered. Adjust stock first, or record what actually went out.`
    : `There is no ${itemName} on the van or at the depot, so ${quantity} cannot be delivered. Add it under Linen › Stock first.`;
}
