import { can, type Capability, type Role } from "@/lib/roles";

/**
 * "What do you want to do?" — the everyday jobs, named as jobs.
 *
 * The rail answers *where things live*: eleven or twelve areas named after
 * parts of a laundry business, each opening onto more choices. That is the
 * right map for somebody who already knows the business and is coming back to
 * it. It is the wrong first screen for somebody who has been shown this app
 * once and is standing at a counter with a bag of towels, because it asks them
 * to translate "I need to take this in" into "Jobs", and *Jobs* sits beside
 * *Stops*, *Runs* and *Boards*, three of which also sound like the answer.
 *
 * So this is a short list of **verbs**, in the words somebody would actually
 * use, sitting above the rest of the dashboard. It is deliberately not a mode:
 *
 *  - **Nothing is hidden.** Every rail row, tab and screen stays exactly where
 *    it was. This adds a shortcut; it removes no route. A person who learns the
 *    app scrolls past it, and it costs them one card.
 *  - **There is no flag to set.** CLAUDE.md §19 records a "simple mode" that
 *    was built and rejected, and one of the reasons was that it needed a
 *    tenant-wide `ui_mode` — a switch one person throws for everybody, when
 *    "is this simple enough for me" is a fact about a person. There is nothing
 *    to switch here.
 *  - **It cannot drift from the navigation.** That was the other standing
 *    objection: a second hand-maintained list of "the simple screens" goes
 *    stale the moment a route moves. Every entry names a capability from
 *    `roles.ts` and resolves through the same `can()` the rail and the page
 *    guards use, and `quick-actions.test.ts` asserts that every `href` here is
 *    a real destination inside `NAVIGATION` — so a route that moves fails a
 *    test rather than shipping a card that leads nowhere.
 *
 * Order is by how often the job is done, not by importance. The first card is
 * the one a counter reaches for twenty times a day.
 */
export type QuickAction = {
  /** The job, as a person would say it out loud. Always a verb. */
  label: string;
  /** One plain sentence saying what happens when you press it. */
  detail: string;
  href: string;
  /**
   * Omitted means every signed-in person — which is what "Get help" needs,
   * since no single capability is held by all twelve roles.
   */
  capability?: Capability;
  /** Lucide icon name, resolved in the component. Kept as data so this module
   *  stays importable by the unit tests without pulling in an icon library —
   *  the same arrangement `nav.ts` uses for the rail. */
  icon: QuickActionIcon;
};

export type QuickActionIcon =
  | "takeIn" | "deliver" | "findCustomer" | "addCustomer" | "laundry" | "bills" | "help";

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Take in laundry",
    detail: "Somebody has handed over a bag. Write down what is in it.",
    href: "/orders/new",
    capability: "orders.write",
    icon: "takeIn",
  },
  {
    label: "See today's deliveries",
    detail: "What has to go out, and what has already been dropped off.",
    href: "/my-runs",
    capability: "routes.read",
    icon: "deliver",
  },
  {
    label: "Find some laundry",
    detail: "Look up a bag somebody has left with us, and see if it is ready.",
    href: "/orders",
    capability: "orders.read",
    icon: "laundry",
  },
  {
    label: "Find a customer",
    detail: "Their phone number, their address, and everything they have left with us.",
    href: "/customers",
    capability: "customers.read",
    icon: "findCustomer",
  },
  {
    label: "Add a new customer",
    detail: "A name, a phone number and where they are. That is all it takes.",
    href: "/customers/new",
    capability: "customers.write",
    icon: "addCustomer",
  },
  {
    label: "Send out bills",
    detail: "Charge customers for the laundry we have done for them.",
    href: "/invoices",
    capability: "invoices.read",
    icon: "bills",
  },
  {
    label: "Show me how",
    detail: "What every word in this app means, and how to do a normal day.",
    href: "/help",
    icon: "help",
  },
];

/**
 * The jobs this person can actually do.
 *
 * A card leading to a screen the auth gate would bounce them off is worse than
 * no card: it teaches somebody who is already unsure that they did something
 * wrong. Resolved through `can()` rather than through a per-role list, for the
 * reason `roles.ts` gives about presets — one answer to "what may this person
 * do", derived, never restated.
 */
export function quickActionsFor(role: Role): QuickAction[] {
  return QUICK_ACTIONS.filter((action) => !action.capability || can(role, action.capability));
}
