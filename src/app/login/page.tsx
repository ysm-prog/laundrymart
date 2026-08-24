import Link from "next/link";
import { CircleCheck, Route, Shirt, Truck } from "lucide-react";
import { Field, Input, SubmitButton } from "@/components/form";
import { Notice } from "@/components/ui";
import { sendMagicLink, signInWithPassword } from "./actions";
import { ReadingComfort } from "@/components/reading-comfort";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  "no-membership": "Your account is not linked to a laundry yet. Ask an administrator to invite you.",
};

/** The three things the app is for, in the operator's words. */
const HIGHLIGHTS = [
  { icon: Shirt, text: "Take laundry in at the counter and track it to hand-back." },
  { icon: Route, text: "Plan the day's runs and see every stop as it happens." },
  { icon: Truck, text: "Drivers keep working with no signal — it syncs when they're back." },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? (ERRORS[params.error] ?? params.error) : undefined;

  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/*
        The brand panel. Desktop and large tablets only — on a phone it would
        push the actual sign-in form below the fold, which is the one thing a
        login screen must never do.
      */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-primary
                          p-12 text-primary-foreground lg:flex">
        <div aria-hidden
             className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full
                        bg-white/8" />
        <div aria-hidden
             className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full
                        bg-white/5" />

        <div className="relative flex items-center gap-3">
          <span aria-hidden
                className="flex size-10 items-center justify-center rounded-xl bg-white/15
                           text-lg font-bold">
            E
          </span>
          <span className="text-lg font-semibold">Electro Services</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight">
            Everything the laundry is doing today, in one place.
          </h2>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <span aria-hidden
                      className="mt-0.5 flex size-8 shrink-0 items-center justify-center
                                 rounded-lg bg-white/15">
                  <Icon className="size-4" />
                </span>
                <span className="text-[0.9375rem] leading-relaxed text-white/90">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-sm text-white/70">
          Commercial laundry operations · Sydney
        </p>
      </section>

      {/* The form. Centred, capped, and the only thing on screen on a phone. */}
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-[26rem]">
          <div className="mb-8">
            <Link href="/" className="mb-6 inline-flex items-center gap-2.5 lg:hidden">
              <span aria-hidden
                    className="flex size-9 items-center justify-center rounded-lg bg-primary
                               text-base font-bold text-primary-foreground">
                E
              </span>
              <span className="text-base font-semibold">Electro Services</span>
            </Link>
            <h1 className="text-2xl font-semibold sm:text-[1.75rem]">Welcome back</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Sign in with your work email. You will see the parts of the app your role covers.
            </p>
          </div>

          {error ? <div className="mb-5"><Notice tone="danger">{error}</Notice></div> : null}
          {params.ok ? <div className="mb-5"><Notice tone="success">{params.ok}</Notice></div> : null}

          <form action={signInWithPassword} className="space-y-5">
            <Field label="Email address" name="email" required>
              <Input name="email" type="email" required autoComplete="email"
                     placeholder="you@electroservices.com.au" />
            </Field>
            <Field label="Password" name="password" required>
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            <SubmitButton pendingLabel="Signing in…" className="w-full">Sign in</SubmitButton>
          </form>

          {/* The passwordless path, framed as the recovery route it actually is
              — this is also what someone reaches for when they have forgotten
              their password, so it says so. */}
          <div className="mt-8 rounded-xl border bg-surface p-5 shadow-sm">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <CircleCheck className="size-4 text-primary" aria-hidden />
              No password, or forgotten it?
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              We will email you a link that signs you straight in.
            </p>
            <form action={sendMagicLink} className="mt-4 space-y-4">
              <Field label="Email address" name="magic-email">
                <Input id="magic-email" name="email" type="email" required autoComplete="email"
                       placeholder="you@electroservices.com.au" />
              </Field>
              <SubmitButton variant="secondary" pendingLabel="Sending…" className="w-full">
                Email me a sign-in link
              </SubmitButton>
            </form>
          </div>

          {/*
            The reading control belongs on the *first* screen, not only inside
            the app. Somebody who cannot read this page cannot sign in to reach
            the one in the header, and the preference is stored per browser, so
            setting it here carries through to every screen afterwards.
          */}
          <ReadingComfort />
        </div>
      </section>
    </main>
  );
}
