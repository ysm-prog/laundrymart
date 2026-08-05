import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { Card, PageHeader } from "@/components/ui";

export const metadata = { title: "Administration" };

const SECTIONS = [
  { href: "/admin/depots", title: "Depots", description: "Branches that own routes, vehicles, drivers and stock." },
  { href: "/admin/users", title: "Users and roles", description: "Who can see and do what inside this laundry." },
  { href: "/admin/holidays", title: "Public holidays", description: "Feeds the holiday rules on every service agreement." },
  { href: "/admin/audit", title: "Audit log", description: "Append-only trail of every write in the system." },
];

export default async function AdminPage() {
  await requireCapability("admin.read");

  return (
    <div>
      <PageHeader title="Administration" description="Tenant-wide settings and the compliance trail." />
      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <Link key={section.href} href={section.href} className="block">
            <Card title={section.title}>
              <p className="text-sm text-muted-foreground">{section.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
