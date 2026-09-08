import { Info } from "lucide-react";
import { cx } from "@/components/ui";
import {
  driverInstructions, type InstructedJob,
} from "@/lib/domain/driver-instructions";

/**
 * The instructions block a round reads, on the day list and on the job.
 *
 * One component for both screens, because they are the same sentence being read
 * by the same person thirty seconds apart — and because the previous
 * arrangement, where each screen decided for itself, is how the customer's
 * standing note came to be shown on neither.
 *
 * **Instructions are not a footnote.** The old card rendered
 * `delivery_instructions` alone, unlabelled, in `text-muted-foreground` at the
 * very bottom — the same weight as the item summary above it, and visually a
 * note rather than a thing to act on. This is bordered, tinted, headed
 * *Instructions*, and each line carries the heading that says where it came
 * from, so "ring twice" and "always use the side door" cannot be mistaken for
 * one another.
 *
 * The tone is `info`, deliberately, and not `warning`: most instructions are
 * ordinary standing arrangements, and a page of amber on every card teaches a
 * driver to stop reading them. `Urgent` is already a badge and stays the one
 * thing that shouts.
 *
 * Renders **nothing at all** when there is nothing to say — an empty box headed
 * "Instructions" reads as an instruction that failed to load.
 */
export function DriverInstructions({
  job, className, compact = false,
}: {
  job: InstructedJob;
  className?: string;
  /** The card's denser form: same content, tighter type. */
  compact?: boolean;
}) {
  const instructions = driverInstructions(job);
  if (instructions.length === 0) return null;

  return (
    <section
      aria-label="Delivery instructions"
      className={cx(
        "rounded-lg border border-info/40 bg-info/10 px-3 py-2.5 text-foreground",
        className,
      )}
    >
      <p className={cx(
        "flex items-center gap-1.5 font-semibold",
        compact ? "text-sm" : "text-base",
      )}>
        <Info className="size-4 shrink-0 text-info" aria-hidden />
        Instructions
      </p>

      <dl className="mt-1.5 space-y-1.5">
        {instructions.map((instruction) => (
          <div key={instruction.kind}>
            {/* Sentence case, not the uppercase-tracked treatment: §10b records
                the 2026-08-13 sweep that took that voice out of 28 files for
                reading as a developer console, and names `Eyebrow`'s 12px
                sentence case as *the* supporting-label voice. This is the same
                styling by hand rather than the component, because it has to be a
                `<dt>` inside a description list. */}
            <dt className="text-2xs font-medium text-muted-foreground">
              {instruction.label}
            </dt>
            {/* `whitespace-pre-wrap`: a line break in an instruction is a line
                break somebody meant — a list of three doors is not one sentence. */}
            <dd className={cx(
              "whitespace-pre-wrap font-medium",
              compact ? "text-sm" : "text-base",
            )}>
              {instruction.text}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
