import Link from "next/link";

const CAPABILITIES = [
  ["Depot-aware planning", "Route templates become daily routes with a driver, a vehicle and a sequence of stops."],
  ["Service agreements", "Weekly, alternate-weekly, monthly and custom patterns with configurable public-holiday handling."],
  ["Guided driver runs", "Inspection, load confirmation, stops, return and close-out — with the paperwork captured on the spot."],
  ["Inventory across states", "At customer, in transit, at depot, in production, in repair, written off — every movement traceable."],
  ["Billing that matches operations", "Rental, wash-only, per-kg, minimum charges, levies and surcharges, straight through to GST invoices."],
  ["Auditable by design", "Row-level tenant isolation proven by tests, plus an activity trail on every write."],
];

export default function Home() {
  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-sm font-medium text-primary">Commercial laundry operations</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">LaundryMart</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        A logistics and operations platform for laundries that collect, process and deliver
        reusable textiles — towels, linen, mats, bags, aprons and uniforms.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/login"
              className="rounded-md bg-action px-4 py-2 text-sm font-medium text-action-foreground hover:opacity-90">
          Sign in
        </Link>
        <Link href="/dashboard"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-surface-muted">
          Go to dashboard
        </Link>
      </div>

      <dl className="mt-12 grid gap-4 sm:grid-cols-2">
        {CAPABILITIES.map(([title, description]) => (
          <div key={title} className="rounded-lg border bg-surface p-4">
            <dt className="text-sm font-semibold">{title}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">{description}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
