"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/form";
import { CONTROL, Eyebrow } from "@/components/ui";
import { businessNowTime, businessToday } from "@/lib/domain/timezone";
import type { JobStaff } from "./job-form";

/**
 * Handing the laundry back — the last step of both workflows.
 *
 * The same inline reveal `ConfirmSubmit` uses for final actions, but this one
 * has to capture four things rather than confirm one: when it happened, who did
 * it, and anything worth writing down. Inline rather than a modal because the
 * design system has no overlays, and because this is frequently done on a tablet
 * at the counter with a customer standing there.
 *
 * Date and time default to now and are pickers, not free text — a delivery
 * recorded an hour later still needs to say when it actually happened.
 */
export function CompleteJob({
  action, orderId, delivered, staff, defaultStaffId,
}: {
  action: (formData: FormData) => Promise<void>;
  orderId: string;
  /** True for a delivery job, false for a customer pickup. */
  delivered: boolean;
  staff: JobStaff[];
  defaultStaffId: string;
}) {
  const [open, setOpen] = useState(false);
  const verb = delivered ? "delivered" : "collected";
  const label = delivered ? "Mark as delivered" : "Mark as collected";

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
              className="rounded-lg inline-flex min-h-9 items-center justify-center bg-action px-3 py-1.5
 text-sm font-medium text-action-foreground transition hover:brightness-110">
        {label}
      </button>
    );
  }

  return (
    <form action={action} className="rounded-lg w-full border border-l-[5px] border-l-primary p-3">
      <input type="hidden" name="id" value={orderId} />
      <Eyebrow>Completes this job</Eyebrow>
      <p className="mt-1 text-sm">
        {delivered
          ? "Records the delivery and closes the job. It cannot be moved again afterwards."
          : "Records the customer collecting their laundry and closes the job. It cannot be moved again afterwards."}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-sm font-medium text-foreground">
            Date {verb}
          </span>
          <input name="completed_date" type="date" required defaultValue={businessToday()}
                 max={businessToday()} className={CONTROL} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium text-foreground">
            Time {verb}
          </span>
          <input name="completed_time" type="time" required defaultValue={businessNowTime()}
                 className={CONTROL} />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="block text-sm font-medium text-foreground">
            {delivered ? "Delivered by" : "Handed over by"}
          </span>
          <select name="handled_by" required defaultValue={defaultStaffId} className={CONTROL}>
            {staff.map((member) => (
              <option key={member.id} value={member.id}>{member.label} · {member.role}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="block text-sm font-medium text-foreground">
            Notes <span className="normal-case tracking-normal">(optional)</span>
          </span>
          <input name="note" className={CONTROL}
                 placeholder={delivered ? "Left with the duty manager" : "Collected by their driver"} />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <SubmitButton pendingLabel="Recording…">{label}</SubmitButton>
        <button type="button" onClick={() => setOpen(false)}
                className="rounded-lg min-h-9 border border-strong bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}
