import { redirect } from "next/navigation";

/**
 * There is no Administration landing page any more.
 *
 * It was a menu of four links to four screens — a whole navigation step whose
 * only content was the navigation. Those four are now tabs across the top of
 * Settings, so this route exists solely to keep old links and bookmarks
 * working, and sends them to the first tab.
 *
 * No capability check here on purpose: `/admin/depots` runs the real one, and
 * duplicating it would mean two places to get the gate wrong.
 */
export default function AdminIndexPage() {
  redirect("/admin/depots");
}
