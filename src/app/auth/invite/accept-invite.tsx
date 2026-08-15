"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Field, Input } from "@/components/form";
import { Notice } from "@/components/ui";

/**
 * Accepting an invitation.
 *
 * This is the one screen in the app that has to run in the browser. An
 * invitation link is verified by Supabase and then bounced back here with the
 * new session attached, and it can arrive in three different shapes depending
 * on how the project's email template is configured:
 *
 *  - `#access_token=…&refresh_token=…` — the default. A fragment never reaches
 *    the server, so no route handler can read it. The Supabase browser client
 *    picks it up while it initialises (`detectSessionInUrl`) and writes the
 *    session to the same cookies the server reads.
 *  - `?token_hash=…&type=invite` — the template that uses `{{ .TokenHash }}`.
 *    Exchanged here with `verifyOtp`.
 *  - `?code=…` — the PKCE shape. `/auth/callback` handles this one for magic
 *    links, but an invite has no code verifier waiting in this browser, so it
 *    is exchanged here too rather than bounced.
 *
 * Whichever arrives, the person is signed in by the time the password form
 * appears — so "I'll do this later" is a real option and not a trap.
 */
type Stage = "checking" | "ready" | "expired" | "saved";

export function AcceptInvite() {
  const [stage, setStage] = useState<Stage>("checking");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function settle() {
      const supabase = createClient();
      const url = new URL(window.location.href);
      // Supabase reports a dead link in the fragment on the implicit path and in
      // the query on the others, so both are read before anything else is tried.
      const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
      const linkError = fragment.get("error_description") ?? fragment.get("error")
        ?? url.searchParams.get("error_description") ?? url.searchParams.get("error");
      if (linkError) {
        if (!cancelled) setStage("expired");
        return;
      }

      const tokenHash = url.searchParams.get("token_hash");
      const code = url.searchParams.get("code");

      if (tokenHash) {
        const type = url.searchParams.get("type") === "recovery" ? "recovery" : "invite";
        const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
        if (otpError) {
          if (!cancelled) setStage("expired");
          return;
        }
      } else if (code) {
        const { error: codeError } = await supabase.auth.exchangeCodeForSession(code);
        if (codeError) {
          if (!cancelled) setStage("expired");
          return;
        }
      }

      // Awaits the client's own initialisation, which is what consumes the
      // fragment on the default path — so this covers all three shapes.
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        setStage("expired");
        return;
      }

      // Take the tokens out of the address bar so they are not left in history
      // or carried into a bookmark.
      window.history.replaceState(null, "", "/auth/invite");
      setStage("ready");
    }

    void settle();
    return () => { cancelled = true; };
  }, []);

  async function setPassword(formData: FormData) {
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    setError(null);

    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("Those two passwords are not the same.");

    setSaving(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSaving(false);
      return setError(updateError.message);
    }
    setStage("saved");
    // A full navigation, not a router push: the server has to read the session
    // cookie the browser client just wrote.
    window.location.replace("/dashboard");
  }

  if (stage === "checking") {
    return <p className="text-sm text-muted-foreground">Checking your invitation…</p>;
  }

  if (stage === "expired") {
    return (
      <div className="space-y-4">
        <Notice tone="danger" title="That invitation link has expired">
          Invitation links can only be used once, and they do not last forever. Ask whoever
          invited you to send a new one — or, if you have signed in here before, use the
          sign-in page as usual.
        </Notice>
        <Link href="/login"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border
                         border-strong bg-surface px-5 text-sm font-medium shadow-xs transition
                         hover:bg-surface-muted">
          Go to sign in
        </Link>
      </div>
    );
  }

  if (stage === "saved") {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CircleCheck className="size-4" aria-hidden />
        Password saved. Taking you in…
      </p>
    );
  }

  return (
    <form action={setPassword} className="space-y-4">
      <Field label="Choose a password" name="password" required
             hint="At least 8 characters. You will use this with your email address to sign in.">
        <Input name="password" type="password" required autoComplete="new-password" />
      </Field>
      <Field label="Type it again" name="confirm" required>
        <Input name="confirm" type="password" required autoComplete="new-password" />
      </Field>

      {error ? (
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-danger">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={saving}
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-action
                           px-5 text-sm font-medium text-action-foreground shadow-xs transition
                           hover:brightness-110 disabled:opacity-60">
          {saving ? "Saving…" : "Save and continue"}
        </button>
        {/* Safe to skip: the invitation has already signed them in, and the
            sign-in page can email them a link any time after that. */}
        <a href="/dashboard"
           className="inline-flex min-h-11 items-center px-1 text-sm text-muted-foreground
                      hover:underline">
          I&rsquo;ll do this later
        </a>
      </div>
    </form>
  );
}
