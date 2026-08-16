import { describe, expect, it } from "vitest";
import {
  ORDER_ACTIONS, ORDER_STATUSES, RECEIVED_VIA, RECEIVED_VIA_OPTIONS, TERMINAL_STATUSES,
  actionsFor, checkTransition, describeItem, initialDeliveryRequired, initialReceivedVia,
  isBlankItem,
  isOrderStatus, isOverdue, nextStatuses, receivedInstant, receivedViaOptions,
  summariseItems, validateItem,
  type OrderStatus,
} from "@/lib/domain/laundry-orders";
import { businessToday, toZonedDate, toZonedTime } from "@/lib/domain/timezone";

const DELIVERY = true;
const PICKUP = false;

describe("the status list", () => {
  it("is exactly the seven the workflow allows", () => {
    // Named individually rather than snapshotted: the point of the test is that
    // an eighth ("processing", "awaiting pickup", "overdue", "delivered") cannot
    // be added without someone deliberately editing this line.
    expect([...ORDER_STATUSES]).toEqual([
      "new", "in_progress", "ready_for_delivery", "assigned", "out_for_delivery",
      "completed", "cancelled",
    ]);
  });

  it("does not model overdue, inspection or delivery as statuses", () => {
    // Overdue is a calculation about today's date; inspection is gone from the
    // workflow entirely; "delivered" is what `completed` means for a delivery
    // job. Each of these has been proposed and each would be a duplicate.
    for (const rejected of ["overdue", "inspection", "awaiting_inspection", "delivered",
                            "assigned_to_run", "run_started"]) {
      expect(isOrderStatus(rejected), rejected).toBe(false);
    }
  });

  it("recognises its own members and nothing else", () => {
    expect(isOrderStatus("in_progress")).toBe(true);
    expect(isOrderStatus("overdue")).toBe(false);
    expect(isOrderStatus("pending")).toBe(false);
  });
});

describe("nextStatuses", () => {
  it("gives a delivery job to a driver before it goes out", () => {
    expect(nextStatuses("new", DELIVERY)).toEqual(["in_progress", "cancelled"]);
    expect(nextStatuses("in_progress", DELIVERY)).toEqual(["ready_for_delivery", "cancelled"]);
    expect(nextStatuses("ready_for_delivery", DELIVERY)).toEqual(["assigned", "cancelled"]);
    expect(nextStatuses("assigned", DELIVERY))
      .toEqual(["out_for_delivery", "ready_for_delivery", "cancelled"]);
    expect(nextStatuses("out_for_delivery", DELIVERY)).toEqual(["completed", "cancelled"]);
  });

  it("finishes a customer pickup straight off the shelf", () => {
    expect(nextStatuses("ready_for_delivery", PICKUP)).toEqual(["completed", "cancelled"]);
    // A job nobody is delivering is never assigned and never goes out.
    expect(nextStatuses("in_progress", PICKUP)).not.toContain("out_for_delivery");
    expect(nextStatuses("ready_for_delivery", PICKUP)).not.toContain("assigned");
  });

  it("leaves the two terminal statuses with nowhere to go", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(nextStatuses(terminal, DELIVERY), terminal).toEqual([]);
      expect(nextStatuses(terminal, PICKUP), terminal).toEqual([]);
    }
  });
});

describe("checkTransition", () => {
  it("allows the moves the workflow defines", () => {
    expect(checkTransition("new", "in_progress", DELIVERY).ok).toBe(true);
    expect(checkTransition("in_progress", "ready_for_delivery", PICKUP).ok).toBe(true);
    expect(checkTransition("ready_for_delivery", "assigned", DELIVERY).ok).toBe(true);
    expect(checkTransition("assigned", "out_for_delivery", DELIVERY).ok).toBe(true);
    expect(checkTransition("out_for_delivery", "completed", DELIVERY).ok).toBe(true);
    expect(checkTransition("ready_for_delivery", "completed", PICKUP).ok).toBe(true);
  });

  it("lets an assigned job go back to the ready queue — Remove Assignment", () => {
    // The one backwards edge in the table, and it is not a cancellation: the
    // job keeps its laundry, its customer and its history.
    expect(checkTransition("assigned", "ready_for_delivery", DELIVERY).ok).toBe(true);
  });

  it("will not send a job out before it has a driver", () => {
    const wrong = checkTransition("ready_for_delivery", "out_for_delivery", DELIVERY);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toMatch(/assign this job to a driver/i);
  });

  it("will not assign a customer pickup to a driver", () => {
    const wrong = checkTransition("ready_for_delivery", "assigned", PICKUP);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toMatch(/collecting/i);
  });

  it("refuses to skip the middle of the workflow", () => {
    const skipped = checkTransition("new", "completed", DELIVERY);
    expect(skipped.ok).toBe(false);
    expect(skipped.ok === false && skipped.reason).toMatch(/cannot go from new/i);
  });

  it("refuses to go backwards", () => {
    expect(checkTransition("ready_for_delivery", "in_progress", DELIVERY).ok).toBe(false);
    expect(checkTransition("out_for_delivery", "ready_for_delivery", DELIVERY).ok).toBe(false);
    expect(checkTransition("out_for_delivery", "assigned", DELIVERY).ok).toBe(false);
    expect(checkTransition("assigned", "in_progress", DELIVERY).ok).toBe(false);
  });

  it("will not send a customer pickup out on a van", () => {
    const wrong = checkTransition("ready_for_delivery", "out_for_delivery", PICKUP);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toMatch(/collecting/i);
  });

  it("will not complete a delivery job that never left", () => {
    const wrong = checkTransition("ready_for_delivery", "completed", DELIVERY);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toMatch(/assign this job to a driver/i);
    expect(checkTransition("assigned", "completed", DELIVERY).ok).toBe(false);
  });

  it("treats completed and cancelled as final", () => {
    for (const target of ORDER_STATUSES) {
      expect(checkTransition("completed", target, DELIVERY).ok, `completed → ${target}`).toBe(false);
      expect(checkTransition("cancelled", target, PICKUP).ok, `cancelled → ${target}`).toBe(false);
    }
  });

  it("cancels from every live status", () => {
    for (const from of ["new", "in_progress", "ready_for_delivery", "assigned",
                        "out_for_delivery"] as OrderStatus[]) {
      expect(checkTransition(from, "cancelled", DELIVERY).ok, from).toBe(true);
    }
  });

  it("says so plainly when nothing would change", () => {
    const same = checkTransition("in_progress", "in_progress", DELIVERY);
    expect(same.ok).toBe(false);
    expect(same.ok === false && same.reason).toMatch(/already/i);
  });
});

describe("actionsFor", () => {
  it("offers delivery and pickup jobs their own last step", () => {
    // A ready delivery job has no status button of its own any more: it needs a
    // driver and a date, which is a form, not a status move.
    const ready = actionsFor("ready_for_delivery", DELIVERY).map((action) => action.key);
    expect(ready).not.toContain("dispatch");
    expect(ready).not.toContain("collect");
    expect(ready).not.toContain("deliver");

    const assigned = actionsFor("assigned", DELIVERY).map((action) => action.key);
    expect(assigned).toContain("dispatch");
    // "Mark ready" must not appear on an assigned job: that edge exists, but it
    // is Remove Assignment and it clears four columns besides the status.
    expect(assigned).not.toContain("ready");

    const pickup = actionsFor("ready_for_delivery", PICKUP).map((action) => action.key);
    expect(pickup).toContain("collect");
    expect(pickup).not.toContain("dispatch");
    expect(pickup).not.toContain("deliver");
  });

  it("offers nothing on a finished job", () => {
    expect(actionsFor("completed", DELIVERY)).toEqual([]);
    expect(actionsFor("cancelled", PICKUP)).toEqual([]);
  });

  it("puts cancelling and the send-out override behind the wider capability", () => {
    // Sending a job out from the office steps around the driver's load
    // confirmation, so it is a management override rather than a counter action.
    for (const key of ["cancel", "dispatch"]) {
      expect(ORDER_ACTIONS.find((action) => action.key === key)?.capability, key)
        .toBe("orders.manage");
    }
    // Everything else a counter hand does day to day sits on orders.status.
    for (const action of ORDER_ACTIONS.filter(
      (entry) => !["cancel", "dispatch"].includes(entry.key))) {
      expect(action.capability, action.key).toBe("orders.status");
    }
  });
});

describe("how the laundry arrived", () => {
  it("offers a new job the two real answers, driver pickup first", () => {
    expect(receivedViaOptions()).toEqual(["driver_pickup", "customer_dropoff"]);
    expect(receivedViaOptions(null)).not.toContain("other");
    expect([...RECEIVED_VIA_OPTIONS]).toEqual(["driver_pickup", "customer_dropoff"]);
  });

  it("defaults a new job to pickup by driver, and an existing one to its own value", () => {
    // Most laundry is collected rather than carried in. An existing job answers
    // with what is stored, so an edit cannot re-record how it arrived.
    expect(initialReceivedVia()).toBe("driver_pickup");
    expect(initialReceivedVia(null)).toBe("driver_pickup");
    expect(initialReceivedVia({ received_via: "customer_dropoff" })).toBe("customer_dropoff");
    expect(initialReceivedVia({ received_via: "other" })).toBe("other");
  });

  it("keeps a job's own value in the list, so an edit cannot rewrite it", () => {
    // A job taken in before the choice was narrowed still opens showing how it
    // actually arrived; saving it back writes the same value.
    expect(receivedViaOptions("other")).toEqual(["driver_pickup", "customer_dropoff", "other"]);
    // One that already holds an offered value is not listed twice.
    expect(receivedViaOptions("driver_pickup")).toEqual(["driver_pickup", "customer_dropoff"]);
  });

  it("still accepts every value the column holds", () => {
    // The narrowing is what the form offers, not what the validator allows —
    // a narrower validator would refuse to save an edit to a legacy job.
    expect([...RECEIVED_VIA]).toEqual(["customer_dropoff", "driver_pickup", "other"]);
  });
});

describe("the received instant", () => {
  it("puts a new job on the chosen date, at the time it is being taken in", () => {
    const today = businessToday();
    const stamped = receivedInstant(today);
    expect(toZonedDate(stamped)).toBe(today);
    // No time field is posted, so the value must still be a real instant rather
    // than midnight-in-UTC landing the job on the wrong day.
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("backdates to the chosen day rather than to its midnight", () => {
    expect(toZonedDate(receivedInstant("2026-08-11"))).toBe("2026-08-11");
  });

  it("keeps the time already on a job when only its date is corrected", () => {
    // 8:30am Sydney on 12 August, moved back a day: still 8:30am.
    const existing = "2026-08-11T22:30:00.000Z";
    expect(toZonedTime(existing)).toBe("08:30");
    const corrected = receivedInstant("2026-08-11", existing);
    expect(toZonedDate(corrected)).toBe("2026-08-11");
    expect(toZonedTime(corrected)).toBe("08:30");
  });

  it("falls back to now rather than to midnight if the stored value is unusable", () => {
    expect(toZonedDate(receivedInstant("2026-08-11", "not-an-instant"))).toBe("2026-08-11");
  });
});

describe("the delivery / pickup default", () => {
  it("starts a new job on delivery back to the customer", () => {
    expect(initialDeliveryRequired()).toBe(true);
    expect(initialDeliveryRequired(null)).toBe(true);
  });

  it("leaves an existing job on whichever workflow it is already on", () => {
    // The historical-protection rule: opening a customer-pickup job to change
    // something else must not turn it into a delivery.
    expect(initialDeliveryRequired({ delivery_required: false })).toBe(false);
    expect(initialDeliveryRequired({ delivery_required: true })).toBe(true);
  });
});

describe("item validation", () => {
  const exact = { item_type: "towels", quantity_type: "exact", exact_quantity: 12 };

  it("accepts a counted item", () => {
    expect(validateItem(exact, 1)).toBeNull();
  });

  it("wants a whole positive number when the laundry was counted", () => {
    expect(validateItem({ ...exact, exact_quantity: 0 }, 1)).toMatch(/valid quantity/i);
    expect(validateItem({ ...exact, exact_quantity: -3 }, 1)).toMatch(/valid quantity/i);
    expect(validateItem({ ...exact, exact_quantity: 2.5 }, 1)).toMatch(/valid quantity/i);
    expect(validateItem({ ...exact, exact_quantity: null }, 1)).toMatch(/valid quantity/i);
  });

  it("wants a description when the type is Other", () => {
    expect(validateItem({ ...exact, item_type: "other" }, 1)).toMatch(/describe/i);
    expect(validateItem({ ...exact, item_type: "other", custom_description: "  " }, 1))
      .toMatch(/describe/i);
    expect(validateItem({ ...exact, item_type: "other", custom_description: "Curtains" }, 1))
      .toBeNull();
  });

  it("wants something measurable on a bulk lot", () => {
    const bulk = { item_type: "sheets", quantity_type: "bulk_lot" };
    expect(validateItem(bulk, 2)).toMatch(/how many bags/i);
    expect(validateItem({ ...bulk, bag_count: 3 }, 2)).toBeNull();
    expect(validateItem({ ...bulk, estimated_quantity: 40 }, 2)).toBeNull();
    expect(validateItem({ ...bulk, notes: "Two red bags" }, 2)).toBeNull();
  });

  it("names the row it is complaining about", () => {
    expect(validateItem({ item_type: "", quantity_type: "exact" }, 3)).toMatch(/^Laundry item 3/);
  });

  it("rejects an invented item type or quantity type", () => {
    expect(validateItem({ ...exact, item_type: "duvets" }, 1)).toMatch(/what kind/i);
    expect(validateItem({ ...exact, quantity_type: "approximate" }, 1)).toMatch(/exact quantity or a bulk lot/i);
  });
});

describe("isBlankItem", () => {
  it("treats an untouched row as an abandoned thought, not an error", () => {
    expect(isBlankItem({ item_type: "", quantity_type: "exact" })).toBe(true);
    expect(isBlankItem({ item_type: "towels", quantity_type: "exact" })).toBe(false);
    expect(isBlankItem({ item_type: "", quantity_type: "exact", notes: "check pockets" })).toBe(false);
  });
});

describe("describeItem / summariseItems", () => {
  it("says a counted item the way the counter would", () => {
    expect(describeItem({ item_type: "bath_towels", quantity_type: "exact", exact_quantity: 24 }))
      .toBe("24 × Bath towels");
  });

  it("uses the typed description for Other", () => {
    expect(describeItem({
      item_type: "other", custom_description: "Chef whites",
      quantity_type: "exact", exact_quantity: 6,
    })).toBe("6 × Chef whites");
  });

  it("describes a bulk lot without inventing a count", () => {
    expect(describeItem({ item_type: "sheets", quantity_type: "bulk_lot", bag_count: 1 }))
      .toBe("1 bag of Sheets");
    expect(describeItem({ item_type: "sheets", quantity_type: "bulk_lot", bag_count: 3, estimated_quantity: 40 }))
      .toBe("3 bags of Sheets (about 40)");
    expect(describeItem({ item_type: "linen", quantity_type: "bulk_lot", notes: "one trolley" }))
      .toBe("bulk lot of Linen");
  });

  it("summarises a long list without listing all of it", () => {
    const items = [
      { item_type: "towels", quantity_type: "exact", exact_quantity: 10 },
      { item_type: "sheets", quantity_type: "exact", exact_quantity: 4 },
      { item_type: "bath_mats", quantity_type: "exact", exact_quantity: 2 },
      { item_type: "uniforms", quantity_type: "exact", exact_quantity: 1 },
    ];
    expect(summariseItems(items)).toBe("10 × Towels, 4 × Sheets +2 more");
    expect(summariseItems([])).toBe("No items");
  });
});

describe("isOverdue", () => {
  const today = "2026-08-13";

  it("is late when the due date has gone by and the job is still live", () => {
    expect(isOverdue({ status: "in_progress", due_date: "2026-08-12" }, today)).toBe(true);
    expect(isOverdue({ status: "new", due_date: "2026-08-12" }, today)).toBe(true);
  });

  it("is not late on the day itself", () => {
    expect(isOverdue({ status: "in_progress", due_date: today }, today)).toBe(false);
    expect(isOverdue({ status: "in_progress", due_date: "2026-08-14" }, today)).toBe(false);
  });

  it("never calls a finished or cancelled job late", () => {
    // The rule the summary strip and the badge both depend on: closing a job
    // clears the flag, without anything having to write to the row.
    expect(isOverdue({ status: "completed", due_date: "2026-01-01" }, today)).toBe(false);
    expect(isOverdue({ status: "cancelled", due_date: "2026-01-01" }, today)).toBe(false);
  });

  it("never calls a job with no date late", () => {
    // A customer pickup with no promised collection date is not late; it is
    // simply undated, and inventing a deadline would manufacture an alert.
    expect(isOverdue({ status: "ready_for_delivery", due_date: null }, today)).toBe(false);
  });
});
