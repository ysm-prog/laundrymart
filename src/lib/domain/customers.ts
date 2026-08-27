/**
 * Who may be picked for new work, and when their status has to be said out loud.
 *
 * Every screen that puts a customer in front of somebody narrows the list, and
 * until 2026-08-27 they did not agree. The Customers screen listed all five
 * statuses; the invoice and contract pickers offered four (`neq archived`); the
 * job form's offered three, silently. A laundry that had just imported its
 * customer base therefore had 508 businesses it could open on one screen and
 * could not find on the next, with nothing on screen explaining the difference
 * — and pressing **New job** on one of those very records worked, because that
 * door hands the id straight to the form. `createOrder` never checked the
 * status at all, so the picker was refusing work the database was happy to take.
 *
 * The rule lives here, pure, so a picker cannot quietly hold its own opinion
 * again: a rule stated inside a query is a rule no unit test can reach.
 */

/**
 * Archiving is the deliberate "put this away" — `archiveCustomer` sets the
 * status *and* stamps `deleted_at`, so an archived customer is already outside
 * every `is("deleted_at", null)` read in the app. Naming it here as well is
 * belt and braces, and it is what the invoice and contract pickers already say.
 *
 * Everything else is a business the laundry still has a relationship with, and
 * laundry may be taken in for any of them. That is not a new permission: it is
 * what `createOrder` has always accepted and what a customer's own record page
 * has always offered.
 */
export function isPickableCustomer(status: string | null | undefined): boolean {
  return status !== "archived";
}

/**
 * True when a picker must show the status beside the name.
 *
 * `active` is the ordinary case and needs no decoration; the other three are
 * facts a counter hand should have before taking laundry in. This is the other
 * half of the same fix — making those customers findable must not also make
 * them look like everybody else, because "inactive" and "on hold" are answers
 * somebody in the office decided and the counter is entitled to see.
 */
export function customerStatusNeedsSaying(status: string | null | undefined): boolean {
  return isPickableCustomer(status) && status !== "active";
}
