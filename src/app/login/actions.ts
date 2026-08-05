"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

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
  // Never echo which half of the credentials was wrong.
  if (error) back({ error: "That email and password combination was not recognised." });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function sendMagicLink(formData: FormData): Promise<void> {
  const parsed = emailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) back({ error: parsed.error.issues[0]?.message ?? "Enter a valid email address." });

  const origin = (await headers()).get("origin") ?? "";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  // Same response either way so the form can't be used to enumerate accounts.
  if (error) console.error("magic link request failed", error.message);

  back({ ok: "If that address has an account, a sign-in link is on its way." });
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
