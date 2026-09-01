"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { done, fail, firstIssue, toObject } from "@/lib/actions";
import { ROLE_CAPABILITIES } from "@/lib/roles";

const BACK = "/notifications";

/**
 * Open a notification: stamp it read, then go where it is handled.
 *
 * This is a form post rather than a link on purpose. A `<Link>` would be
 * prefetched by Next on hover and in the viewport, and a prefetch of a
 * mark-as-read route empties the bell without anybody clicking anything.
 *
 * Any member may open a notification addressed to a capability they hold. The
 * audience filter is repeated here rather than trusted from the list that
 * rendered the form: without it a driver could post the id of a dispatcher's
 * notification and clear it, and a notification silently marked read is one
 * nobody is ever shown again.
 */
export async function openNotification(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const supabase = await createClient();
  const audiences = [...ROLE_CAPABILITIES[session.role]];

  // Read the destination back from the row rather than trusting a posted one:
  // the href in the form is client-supplied, and following it blind would make
  // this an open redirect. 0013 also constrains the stored value to a same-site
  // path, so what comes back cannot leave the app.
  const { data: notification } = await supabase
    .from("notifications")
    .select("id, href")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.id)
    .in("audience", audiences)
    .maybeSingle<{ id: string; href: string }>();

  if (!notification) return fail(BACK, "That notification is no longer there.");

  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notification.id)
    .eq("tenant_id", session.tenantId)
    .is("read_at", null);

  revalidatePath(BACK);
  // Straight to the work, with no flash: the user asked to go somewhere, and a
  // toast saying "marked as read" is noise on top of an action they can see.
  redirect(notification.href);
}

/** Clear the bell in one go. Bounded to what this role was actually shown. */
export async function markAllRead(): Promise<void> {
  const session = await requireSession();
  const audiences = [...ROLE_CAPABILITIES[session.role]];
  if (audiences.length === 0) return done(BACK, "Nothing to clear.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("tenant_id", session.tenantId)
    .in("audience", audiences)
    .is("read_at", null);

  if (error) return fail(BACK, "Those could not be marked as read. Try again.");

  revalidatePath(BACK);
  return done(BACK, "All caught up.");
}
