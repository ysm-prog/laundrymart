"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { magicLinkOutcome } from "@/lib/auth/magic-link";
import { sendSignInLink } from "@/lib/auth/send-link";

const credentials = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const emailOnly = z.object({ email: z.string().email("Enter a valid email address") });

function back(params: Record<string, string>): never {
  redirect(`/login?${new URLSearchParams(params).toString()}`);
}

export async function signInWithPassword(formData: FormData): Promise<void> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    back({ error: parsed.error.issues[0]?.message ?? "Check your details and try again." });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // The message stays vague on purpose — never echo which half of the
    // credentials was wrong. But swallowing the cause entirely makes a
    // misconfigured deployment look identical to a typo, which cost real time
    // once. The reason goes to the server log; never the credentials.
    console.error("password sign-in failed", {
      code: error.code, status: error.status, message: error.message,
    });
    back({ error: "That email and password combination was not recognised." });
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function sendMagicLink(formData: FormData): Promise<void> {
  const parsed = emailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) back({ error: parsed.error.issues[0]?.message ?? "Enter a valid email address." });

  // The link is minted by `generateLink()` and delivered by **this app's own
  // mail provider**, not by Supabase's built-in sender — which needs custom
  // SMTP this deployment has never had, and which is why this form said a link
  // was on its way every time without one ever being. See `auth-links.ts`.
  //
  // A `recovery` link also cannot create an account, which keeps the property
  // `shouldCreateUser: false` used to buy: a mistyped address here can no
  // longer mint a real `auth.users` row with no membership behind it — a login
  // that exists, receives mail, and dead-ends on "not linked to a laundry yet".
  // Access is granted by an administrator inviting somebody (§10c), never by
  // turning up at the login screen.
  const origin = (await headers()).get("origin") ?? "";
  const result = await sendSignInLink({ email: parsed.data.email, origin });

  if (!result.ok) {
    // Never the address, and never which half of it was wrong.
    console.error("sign-in link request failed", { failure: result.failure });
  }

  // Success and "no such login" answer identically, so the form cannot be used
  // to enumerate accounts. A broken *deployment* is told plainly: it is true of
  // every address, so it reveals nothing, and swallowing it made a project that
  // has never sent a single email look exactly like one that just sent yours.
  back(magicLinkOutcome(result.ok ? null : result.failure));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
