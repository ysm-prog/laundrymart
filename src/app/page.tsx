import Link from "next/link";
import {
  ClipboardList, Receipt, Route, ShieldCheck, Shirt, Truck,
} from "lucide-react";

const CAPABILITIES = [
  {
    icon: Route,
    title: "Plan the day in one place",
    description: "Weekly runs become today's runs with a driver, a vehicle and a sequence of stops.",
  },
  {
    icon: ClipboardList,
    title: "Every job tracked",
    description: "Laundry taken in at the counter, followed through the plant, back out to the customer.",
  },
  {
    icon: Truck,
    title: "Drivers work without signal",
    description: "Stops, photos and signatures are captured on the phone and sync when the van is back.",
  },
  {
    icon: Shirt,
    title: "Linen you can account for",
    description: "At the customer, in transit, at the depot, in the plant, in repair — every movement traceable.",
  },
  {
    icon: Receipt,
    title: "Billing that matches the work",
    description: "Rental, wash-only, per-kilo, minimums and levies, straight through to a GST invoice.",
  },
  {
    icon: ShieldCheck,
    title: "Safe by design",
    description: "Each business sees only its own data, and every change is recorded with who made it.",
  },
];

export default function Home() {
  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
      <div className="flex items-center gap-3">
        <span aria-hidden
              className="flex size-11 items-center justify-center rounded-xl bg-primary text-lg
                         font-bold text-primary-foreground">
          E
        </span>
        <span className="text-lg font-semibold">Electro Services</span>
      </div>

      <p className="mt-12 text-sm font-semibold text-primary">Commercial laundry operations</p>
      <h1 className="mt-2 max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">
        Run the whole laundry from one screen.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
        Collections, the plant floor, deliveries and the invoice at the end of it — for laundries
        handling towels, linen, mats, bags, aprons and uniforms.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/login"
              className="inline-flex min-h-11 items-center rounded-lg bg-action px-6 text-sm
                         font-medium text-action-foreground shadow-sm transition hover:brightness-110">
          Sign in
        </Link>
        <Link href="/dashboard"
              className="inline-flex min-h-11 items-center rounded-lg border border-strong bg-surface
                         px-6 text-sm font-medium shadow-xs transition hover:bg-surface-muted">
          Go to today
        </Link>
      </div>

      <dl className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map(({ icon: Icon, title, description }) => (
          <div key={title} className="rounded-xl border bg-surface p-5 shadow-sm">
            <span aria-hidden
                  className="flex size-9 items-center justify-center rounded-lg bg-primary/10
                             text-primary">
              <Icon className="size-[1.15rem]" />
            </span>
            <dt className="mt-3.5 font-semibold">{title}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</dd>
          </div>
        ))}
      </dl>

      <footer className="mt-16 border-t pt-6 text-sm text-muted-foreground">
        Electro Services · Commercial laundry operations
      </footer>
    </main>
  );
}
