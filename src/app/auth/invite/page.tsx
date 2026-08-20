import { AcceptInvite } from "./accept-invite";

export const metadata = { title: "Accept your invitation" };

/**
 * Where an invitation link lands (roadmap D5).
 *
 * Outside the auth gate — `/auth` is public in `proxy.ts` — because the person
 * following the link has no session until the moment this page gives them one.
 * The work is in the client component beside it; see the note there for why
 * this one screen cannot be server-rendered.
 */
export default function InvitePage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-surface-muted p-4">
      <div className="w-full max-w-md rounded-2xl border bg-surface p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <span aria-hidden
                className="flex size-10 items-center justify-center rounded-xl bg-primary
                           text-lg font-bold text-primary-foreground">
            E
          </span>
          <span className="text-lg font-semibold">Electro Services</span>
        </div>

        <h1 className="text-[26px] font-semibold leading-tight">You have been invited</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Set a password and you are in. You can change it later from the sign-in page.
        </p>

        <AcceptInvite />
      </div>
    </main>
  );
}
