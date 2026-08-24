import { AcceptInvite } from "./accept-invite";

export async function generateMetadata(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  return {
    title: (await searchParams).type === "recovery"
      ? "Choose a new password"
      : "Accept your invitation",
  };
}

/**
 * Where an invitation **or a sign-in link** lands (roadmap D5).
 *
 * Outside the auth gate — `/auth` is public in `proxy.ts` — because the person
 * following the link has no session until the moment this page gives them one.
 * The work is in the client component beside it; see the note there for why
 * this one screen cannot be server-rendered.
 *
 * One screen serves both because both do the same two things: sign the person
 * in, then offer them a password. `?type=` says which words to use — an
 * invitation is news, a sign-in link is a thing they asked for a minute ago —
 * and the client component has read that parameter since it was written.
 */
export default async function InvitePage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const recovery = (await searchParams).type === "recovery";
  const heading = recovery ? "Choose a new password" : "You have been invited";
  const blurb = recovery
    ? "You are signed in. Set a password now if you want one, or carry straight on."
    : "Set a password and you are in. You can change it later from the sign-in page.";

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

        <h1 className="text-[26px] font-semibold leading-tight">{heading}</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">{blurb}</p>

        <AcceptInvite />
      </div>
    </main>
  );
}
