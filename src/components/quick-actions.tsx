import Link from "next/link";
import type { ComponentType } from "react";
import {
  CircleQuestionMark, PackagePlus, Receipt, Search, Shirt, Truck, UserPlus,
} from "lucide-react";
import { Card } from "./ui";
import { quickActionsFor, type QuickActionIcon } from "@/lib/quick-actions";
import type { Role } from "@/lib/roles";
import { ReadingComfort } from "./reading-comfort";

/**
 * The first thing on the home screen: a short list of jobs, as verbs.
 *
 * See `lib/quick-actions.ts` for why this exists and why it is not a mode. This
 * file is only the drawing of it, and the drawing has one job — a person who
 * has been shown this app once should be able to find the thing they came to do
 * without reading anything else on the page.
 *
 * So: big targets, one plain sentence each, and a single column on a phone. The
 * cards are `Link`s rather than buttons because they navigate, which means they
 * open in a new tab on a long-press and read as links to a screen reader.
 */
const ICONS: Record<QuickActionIcon, ComponentType<{ className?: string }>> = {
  takeIn: PackagePlus,
  deliver: Truck,
  findCustomer: Search,
  addCustomer: UserPlus,
  laundry: Shirt,
  bills: Receipt,
  help: CircleQuestionMark,
};

export function QuickActions({ role }: { role: Role }) {
  const actions = quickActionsFor(role);
  if (actions.length === 0) return null;

  return (
    <Card
      title="What do you want to do?"
      description="Pick one. You can always come back here."
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map((action) => {
          const Icon = ICONS[action.icon];
          return (
            /* `min-w-0`: a grid item defaults to `min-width: auto`, so it
               refuses to shrink below its own min-content width — which at the
               largest text size on a 320px screen pushed the row 6px wider than
               the card holding it. Measured, not guessed. */
            <li key={action.href} className="min-w-0">
              <Link
                href={action.href}
                /* The whole card is the target, not the words in it. `h-full`
                   keeps a row of cards level when one sentence wraps and its
                   neighbour does not.

                   `flex-wrap`, with a floor on the text block, is what keeps
                   this readable at the two extremes together — a 320px phone at
                   the largest text size. There the icon and its gap eat 73 of
                   the 204px available, leaving the sentence about four
                   characters a line. Rather than pick a breakpoint for it, the
                   text simply drops below the icon once it cannot have 9rem,
                   and takes the full width. No breakpoint to get wrong, and it
                   adjusts itself to a size we have not thought of. */
                className="flex h-full min-h-[5.5rem] flex-col gap-1.5 rounded-xl
                           border border-strong bg-surface p-4 shadow-xs transition
                           hover:border-primary hover:bg-primary/5 focus-visible:border-primary"
              >
                {/* The icon shares a line with the label only. Putting the
                    sentence beside it too means the icon's width is subtracted
                    from every line of it, and at the largest text size on a
                    320px screen that left about four characters a line —
                    measured. The label is short and survives the squeeze; the
                    sentence gets the full width of the card. */}
                <span className="flex flex-wrap items-center gap-3">
                  <span aria-hidden
                        className="flex size-11 shrink-0 items-center justify-center rounded-lg
                                   bg-primary/10 text-primary [&_svg]:size-6">
                    <Icon />
                  </span>
                  {/*
                    The label drops below the icon rather than squeezing beside
                    it. At the largest text size on a 320px screen there is
                    about 87px to the right of the icon, and the word
                    "deliveries" alone wants 94 — so it either overflows the
                    card or breaks mid-word, and Chromium has no hyphenation
                    dictionary here, so the break comes out as "deliverie / s".

                    The 6rem floor is what forces the wrap: it is comfortably
                    under the space available at ordinary sizes (so the icon and
                    label sit on one line, which is the normal case) and over
                    the space available at the extreme, where the label takes
                    the card's full width instead. `break-words` stays as the
                    backstop for a label longer than anything here today.
                  */}
                  <span className="min-w-[6rem] flex-1 break-words text-base font-semibold leading-snug">
                    {action.label}
                  </span>
                </span>
                <span className="block text-sm text-muted-foreground">{action.detail}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/*
        The reading control, where somebody who cannot read the screen is
        already looking. It is in the header too, but a person who has never
        used a web application does not read a row of small grey icons at the
        top of a page — and the one person who most needs this is the one least
        likely to go hunting for it.
      */}
      <ReadingComfort />
    </Card>
  );
}
