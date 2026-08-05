import Link from "next/link";
import { Field, Input, SubmitButton } from "@/components/form";
import { Notice } from "@/components/ui";
import { sendMagicLink, signInWithPassword } from "./actions";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  "no-membership": "Your account is not linked to a laundry yet. Ask an administrator to invite you.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? (ERRORS[params.error] ?? params.error) : undefined;

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <div className="mb-6">
        <Link href="/" className="text-sm text-muted-foreground hover:underline">← LaundryMart</Link>
        <h1 className="mt-3 text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use your work email. Access is scoped to your laundry and your role.
        </p>
      </div>

      {error ? <div className="mb-4"><Notice tone="danger">{error}</Notice></div> : null}
      {params.ok ? <div className="mb-4"><Notice tone="success">{params.ok}</Notice></div> : null}

      <form action={signInWithPassword} className="space-y-4 rounded-lg border bg-surface p-4">
        <Field label="Email" name="email" required>
          <Input name="email" type="email" required placeholder="you@laundry.com.au" />
        </Field>
        <Field label="Password" name="password" required>
          <Input name="password" type="password" required />
        </Field>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>

      <form action={sendMagicLink} className="mt-4 space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm font-medium">No password?</p>
        <Field label="Email" name="magic-email">
          <Input name="email" type="email" required placeholder="you@laundry.com.au" />
        </Field>
        <SubmitButton variant="secondary" pendingLabel="Sending…">Email me a sign-in link</SubmitButton>
      </form>
    </main>
  );
}
