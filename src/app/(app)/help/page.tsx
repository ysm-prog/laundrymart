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
    title: "Take the laundry in",
    body: "Create a Job for the customer: what they brought, when they want it back, and whether you are delivering it or they are collecting. It moves New \u2192 In progress \u2192 Ready for delivery as the plant works on it \u2014 press any stage on the job's own page to move it there, including back a stage if it was moved on by mistake.",
    href: "/orders/new", link: "Create a job",
  },
  {
    title: "Give it to a driver",
    body: "Once a job is Ready for delivery, choose a driver and a delivery date. That is the whole handover \u2014 there is no run to create and no run to open. The job becomes Assigned and appears in that driver's My Runs for that day.",
    href: "/orders?run=ready-unassigned", link: "See what needs a driver",
  },
  {
    title: "The driver delivers",
    body: "The driver opens My Runs on their phone, confirms the load, starts the route, and marks each job delivered at the door. Dates and times on it are Adelaide dates and times.",
    href: "/my-runs", link: "Open My Runs",
  },
  {
    title: "Deal with problems",
    body: "If a driver cannot finish a stop they flag it without leaving their run. It appears on Today, and under Stops → Problems, until somebody clears it.",
    href: "/operations/exceptions", link: "See problems",
  },
  {
    title: "Bill the work",
    body: "At the end of the month, Create this month's invoices makes one draft invoice per customer: every item of every job you finished for them, at their price, plus anything their contract charges. You check them, issue them, and email them out.",
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
    term: "My Runs",
    meaning: "One delivery round's own jobs for a day it chooses, grouped into what is still to deliver, what is out, and what is done. It is the round's whole workspace: confirm the load, start the route, open a job, mark it delivered. Dates on it are Adelaide dates.",
  },
  {
    term: "Delivery round", also: "board",
    meaning: "One of your regular delivery rounds \u2014 Board 1, Board 2, and so on. Work is given to the round, not to a person, because whoever drives it changes: leave, sickness, somebody covering. The round has its own login, so whoever is driving it today signs in as the round and sees that day's deliveries. The app still records which person drove it, so you can always answer \"who was holding that parcel?\".",
  },
  {
    term: "Assigned to",
    meaning: "The delivery round that is taking a job out, and the day it is going. Chosen when the job is Ready for delivery. You never create or open a run to do it \u2014 the app arranges the round's day behind the scenes. Older jobs may still name a person instead of a round; that is their history and it is left alone.",
  },
  {
    term: "Confirm Load",
    meaning: "Saying the day's laundry is on the van. It replaced the old vehicle inspection and is not one: no checklist, no pass or fail. A job added after the load is confirmed stays Assigned until it is confirmed again, so nothing is recorded as leaving the site that did not.",
  },
  {
    term: "Start Route",
    meaning: "Saying the van is on the road. Every loaded job moves from Assigned to Out for delivery, so nobody in the office has to mark them out by hand.",
  },
  {
    term: "Driver visit", also: "stop",
    meaning: "One call on one customer on one day, and the paperwork that goes with it \u2014 what was picked up, what was handed over, the signature at the door. A visit is not the same as a customer's laundry: the laundry is the bag, the visit is the trip to the door. Drivers no longer work from visits; they work from the jobs in My Runs.",
  },
  {
    term: "Job", also: "laundry order, ticket, docket",
    meaning: "One customer's laundry, from the moment it lands on the counter to the moment it goes back: what they brought in, when they get it back, and where it is up to. Its seven states are New, In progress, Ready for delivery, Assigned, Out for delivery, Completed and Cancelled. The first five can be picked in any order; the last two are final.",
  },
  {
    term: "Assigned",
    meaning: "A job that has been given to a delivery round for a particular date. It is a real state, and a job cannot be in it without both. Assigning changes nothing about the laundry, the customer, the instructions or the price, and removing an assignment simply puts the job back to Ready for delivery \u2014 it does not cancel it.",
  },
  {
    term: "Expected delivery date",
    meaning: "The day the customer was promised their laundry back. Set when the job is taken in.",
  },
  {
    term: "Assigned delivery date",
    meaning: "The day a job is scheduled to a driver. It starts as the expected delivery date and is usually the same, but an authorised user can move the schedule without moving the promise.",
  },
  {
    term: "Overdue",
    meaning: "A job whose date has gone by and is not finished or cancelled. It is worked out from today's date every time you look — nobody sets it, and it clears itself the moment the job is done.",
  },
  {
    term: "Filter chips",
    meaning: "The row of small buttons above a list. Press one to narrow the list to it, press it again to go back. The number on each says how many rows you would be left with, so nothing surprises you.",
  },
  {
    term: "Clear filters",
    meaning: "Puts everything back. It only appears when something is actually narrowing the list — so if you cannot see it, you are looking at the whole list.",
  },
  {
    term: "Period",
    meaning: "The stretch of time a list is showing. Today, this week, last month and so on, or two dates of your own under Custom range. The dates it works out are printed underneath, so you can always see exactly what you are looking at.",
  },
  {
    term: "This financial year",
    meaning: "1 July to 30 June — the Australian year the books run on, not January to December.",
  },
  {
    term: "Bulk lot",
    meaning: "Laundry taken in by the bag rather than counted piece by piece. A bulk lot still needs a number of bags, a rough count or a note, so there is something to check it back against.",
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
    term: "Rate card", also: "agreement version",
    meaning: "The prices you have agreed with one customer. It is a version of their contract, so changing a price means a new version — and every job already approved keeps the price it was approved at.",
  },
  {
    term: "Laundry price", also: "price list, rate",
    meaning: "What you charge for each item code when a customer has no rate card \u2014 per piece, and optionally per bag for bulk lots. Money \u203a Laundry prices holds your usual prices; a customer who has agreed something different has their own list on their page. A rate card beats both. Change a price and it is used by every job you price or approve from then on, and wherever you pick that item on a charge or an invoice line \u2014 but a job you have already approved keeps the price it was approved at, even on a draft invoice. An item code with no price anywhere falls back to the item's own selling price, and one with neither is left off and reported rather than billed at nothing.",
  },
  {
    term: "Billing method",
    meaning: "How many draft invoices a customer's finished work collects on: a draft per job, or everything rolled onto one weekly, fortnightly or monthly draft. Set on the customer. \"Manual\" is the same, except that Create this month's invoices leaves them out \u2014 you issue theirs yourself.",
  },
  {
    term: "Awaiting review",
    meaning: "A job whose work is finished and whose money is not. Finishing a job never bills anybody — it lands here for somebody to check the charges.",
  },
  {
    term: "Approved",
    meaning: "The charges on a job have been signed off, and they go straight onto that customer's draft invoice. This is the moment the price freezes: after it, the job's charges cannot be changed by anyone, and changing the customer's rate card no longer affects it. It does not create an invoice \u2014 the draft becomes one when you issue it.",
  },
  {
    term: "Invoice",
    meaning: "A bill for a customer, carrying the jobs you approved for them in the period and anything their contract charges. A draft can be changed; an issued invoice cannot, and is voided with a reason instead.",
  },
  {
    term: "Draft invoice",
    meaning: "A customer's bill while it is still filling up. Every job you approve joins theirs for the period, so one month is one draft. Nothing reaches the customer while it is a draft \u2014 and there is no other way for a job to reach an invoice.",
  },
  {
    term: "Issue",
    meaning: "Closing a draft, which is the moment it becomes a real invoice: its date is stamped, its lines are locked, and the next job you approve starts a fresh draft. It does not send anything \u2014 the customer hears nothing until you send.",
  },
  {
    term: "Send",
    meaning: "Emailing an invoice, with its PDF, to the customer. A separate step from generating on purpose, so nothing reaches a customer by accident.",
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
  "Creating anything — a customer, a contract, a job. Nothing is charged or sent to anyone until you issue an invoice.",
  "Assigning a job to a driver, changing the driver, changing the date, or removing the assignment. None of it touches the laundry, the customer or the price, and none of it cancels anything.",
  "Archiving a customer. They drop out of lists; their history, stops and invoices are all kept.",
  "Creating a job and moving it along. Press any stage on the job's page to move it there — forwards, backwards, or skipping one it does not need. Every move is recorded on the job with your name and the time, so a correction is part of the history rather than a hidden edit.",
  "Inviting somebody, or changing what they can see. Settings › People, and you can change your mind at any time.",
  "Completing a job. It never bills anybody — it only puts the job in front of whoever checks the charges.",
  "Pricing a job, re-pricing it, and editing its charges — right up until you approve them.",
  "Changing a laundry price, a customer's rate card or their billing method. No invoice already raised moves, and no job already approved is re-priced.",
  "Creating this month's invoices. They arrive as drafts: you can add and remove lines, and nothing goes to a customer until you issue and email it.",
];

const FINAL = [
  "Approving a job's charges. That is the moment the price freezes — after it, nobody can change what that job cost, and a mistake is fixed with a credit note rather than by editing history.",
  "Issuing an invoice. After that it can only be voided with a reason, or corrected with a credit note.",
  "Emailing an invoice. The email leaves immediately.",
  "Voiding an invoice. The number is kept forever so your books have no gaps.",
  "Completing a job — marking it delivered or collected. A finished job cannot be moved again.",
  "Cancelling a job. It stops appearing in the day's work. Nothing is deleted, but it cannot be reopened.",
  "Removing somebody's access. They can no longer sign in, and their work stays exactly as it was. You can invite them back, but they will need a new invitation.",
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
            <li key={step.title} className="rounded-lg flex items-start gap-3 border p-3">
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
