import Link from "next/link";
import { requireSession } from "@/lib/auth/context";
import { navigationFor } from "@/lib/nav";
import { Card, Eyebrow, PageHeader } from "@/components/ui";

export const metadata = { title: "Help" };

/**
 * The page that answers "what does this word mean?".
 *
 * The app is full of trade terms that are obvious after a fortnight and opaque
 * on day one — a *stop*, a *run*, a *contract*, *the plant*. The rest of the
 * redesign removes the jargon from the screens; this page is where the words we
 * kept get defined, next to the industry term they replaced, so nobody has to
 * guess whether "contract" is the same thing the last system called a service
 * agreement.
 *
 * Static and read-only: no data, no role gating beyond the rail's own, so it
 * cannot itself become one more screen that turns someone away.
 */

const DAY = [
  {
    title: "Plan the day",
    body: "One button on Today builds the day's runs from your weekly runs and puts the usual driver and truck on each. You only get sent to the planning board if something needs your call.",
    href: "/dashboard", link: "Go to Today",
  },
  {
    title: "The driver drives",
    body: "The driver opens My run on their phone. It works with no signal — everything they record is held on the device and sent when the phone is back on the network.",
    href: "/run", link: "Open My run",
  },
  {
    title: "Deal with problems",
    body: "If a driver cannot finish a stop they flag it without leaving their run. It appears on Today, and under Stops → Problems, until somebody clears it.",
    href: "/operations/exceptions", link: "See problems",
  },
  {
    title: "Bill the work",
    body: "At the end of a billing period, Create this month's invoices turns completed work and contract prices into draft invoices. You check them, issue them, and email them out.",
    href: "/invoices", link: "Go to invoices",
  },
];

const GLOSSARY: Array<{ term: string; also?: string; meaning: string }> = [
  {
    term: "Site", also: "depot, branch",
    meaning: "A place you operate from. Runs, trucks, drivers and stock each belong to one site. Most laundries only ever need one.",
  },
  {
    term: "Customer",
    meaning: "A business you collect from and deliver to. A customer can have several sites of their own and several contacts.",
  },
  {
    term: "Contract", also: "service agreement",
    meaning: "What you have agreed with one customer: which days you collect, which days you deliver, and what they pay. Everything you bill comes from here.",
  },
  {
    term: "Item type", also: "linen item, SKU",
    meaning: "A kind of linen you handle — a queen sheet, a bath towel, a floor mat. Prices set here apply unless a contract overrides them.",
  },
  {
    term: "Weekly run", also: "route template",
    meaning: "The repeating week: which customers one driver visits, in what order, on which weekdays. You set it up once.",
  },
  {
    term: "Run", also: "daily route",
    meaning: "One driver's actual work for one day, built from a weekly run. It has a driver, a truck, and a list of stops.",
  },
  {
    term: "Stop", also: "job",
    meaning: "One visit to one customer on one day. A stop can be a collection, a delivery, or both.",
  },
  {
    term: "Collection", also: "pickup",
    meaning: "Dirty linen taken from a customer, counted at the door, with anything damaged or missing recorded on the spot.",
  },
  {
    term: "Delivery",
    meaning: "Clean linen handed back, with a signature and a photo kept as proof it arrived.",
  },
  {
    term: "Problem", also: "exception",
    meaning: "A stop the driver could not complete — nobody there, no access, wrong linen. Clearing the problem puts the stop back in the queue.",
  },
  {
    term: "In the plant", also: "production batch",
    meaning: "Linen moving through washing, drying, folding and packing. Each stage moves the stock, so what is on the floor and what the system says stay in step.",
  },
  {
    term: "Stock", also: "inventory",
    meaning: "How much of each item type you have and where it is — at a site, on a truck, at a customer, or somewhere in the plant.",
  },
  {
    term: "Invoice",
    meaning: "A bill sent to a customer. A draft can be changed; an issued invoice cannot, and is voided with a reason instead.",
  },
  {
    term: "Credit note",
    meaning: "Money given back against an invoice already issued — the correct way to fix an overcharge, because it leaves the original bill intact.",
  },
  {
    term: "Activity log", also: "audit log",
    meaning: "Every change anyone has made, kept permanently. Nothing is ever removed from it.",
  },
];

const SAFE = [
  "Creating anything — a customer, a contract, a weekly run. Nothing is charged or sent to anyone until you issue an invoice.",
  "Planning a day. Runs can be replanned, and stops moved between runs, right up until a driver starts.",
  "Archiving a customer. They drop out of lists; their history, stops and invoices are all kept.",
];

const FINAL = [
  "Issuing an invoice. After that it can only be voided with a reason, or corrected with a credit note.",
  "Emailing an invoice. The email leaves immediately.",
  "Closing a run. It stops accepting stop updates from the driver.",
  "Voiding an invoice. The number is kept forever so your books have no gaps.",
];

export default async function HelpPage() {
  const session = await requireSession();
  const areas = navigationFor(session.role).filter((item) => item.href !== "/help");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Help"
        description="What the words mean, how a normal day runs, and which buttons you cannot take back."
      />

      <Card title="How a normal day runs" description="Four things happen, in this order.">
        <ol className="space-y-3">
          {DAY.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3 border p-3">
              <span aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center bg-surface-muted
                               text-xs font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{step.body}</p>
                <Link href={step.href}
                      className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">
                  {step.link} →
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Where everything lives" description="The menu on the left, in one place.">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {areas.map((area) => (
            <div key={area.href}>
              <dt>
                <Link href={area.href} className="text-[13px] font-medium text-primary hover:underline">
                  {area.label}
                </Link>
              </dt>
              <dd className="text-xs text-muted-foreground">{area.blurb}</dd>
              {area.children && area.children.length > 1 ? (
                <dd className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                  {area.children.map((child) => (
                    <Link key={child.href} href={child.href}
                          className="text-xs text-muted-foreground underline underline-offset-2
                                     hover:text-foreground">
                      {child.label}
                    </Link>
                  ))}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </Card>

      <Card
        title="What the words mean"
        description="Plain English first, with the trade word this app replaced it with."
      >
        <dl className="divide-y">
          {GLOSSARY.map((entry) => (
            <div key={entry.term} className="grid gap-1 py-2.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
              <dt>
                <span className="text-[13px] font-medium">{entry.term}</span>
                {entry.also ? (
                  <span className="mt-0.5 block"><Eyebrow>also called {entry.also}</Eyebrow></span>
                ) : null}
              </dt>
              <dd className="text-xs text-muted-foreground">{entry.meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Safe to try" description="None of this can cost you anything.">
          <ul className="space-y-2 text-xs text-muted-foreground">
            {SAFE.map((line) => (
              <li key={line} className="border-l-[3px] border-l-success pl-2.5">{line}</li>
            ))}
          </ul>
        </Card>
        <Card title="Cannot be undone" description="The app asks you to confirm each of these.">
          <ul className="space-y-2 text-xs text-muted-foreground">
            {FINAL.map((line) => (
              <li key={line} className="border-l-[3px] border-l-warning pl-2.5">{line}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
