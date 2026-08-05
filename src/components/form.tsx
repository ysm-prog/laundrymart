"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { CONTROL, cx } from "./ui";

export function Field({
  label, name, hint, error, required, children, className,
}: {
  label: string; name: string; hint?: string; error?: string;
  required?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <div className={cx("space-y-1", className)}>
      {/* 10px rather than the 9px used for chrome labels elsewhere: a field
          label is the thing being read while typing, not decoration on a panel.
          The asterisk is decorative — `required` on the control itself is what
          assistive tech announces. */}
      <label htmlFor={name}
             className="block font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden>*</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

export function Input({
  name, type = "text", defaultValue, placeholder, required, step, min, max, readOnly, inputMode,
  formId,
}: {
  name: string; type?: string; defaultValue?: string | number | null;
  placeholder?: string; required?: boolean; step?: string; min?: string | number;
  max?: string | number; readOnly?: boolean;
  inputMode?: "numeric" | "decimal" | "tel" | "email" | "text";
  /** Associates the input with a <form id=…> elsewhere, so fields can sit visually inside another form without nesting. */
  formId?: string;
}) {
  return (
    <input
      id={name} name={name} type={type} required={required} step={step}
      min={min} max={max} readOnly={readOnly} placeholder={placeholder}
      inputMode={inputMode} form={formId}
      defaultValue={defaultValue ?? undefined} className={CONTROL}
    />
  );
}

export function Textarea({
  name, defaultValue, rows = 3, placeholder,
}: { name: string; defaultValue?: string | null; rows?: number; placeholder?: string }) {
  return (
    <textarea id={name} name={name} rows={rows} placeholder={placeholder}
              defaultValue={defaultValue ?? undefined} className={CONTROL} />
  );
}

export type SelectOption = { value: string; label: string };

export function Select({
  name, options, groups, defaultValue, required, placeholder,
}: {
  name: string;
  options?: ReadonlyArray<SelectOption>;
  /**
   * Grouped choices. Used where a long list has a handful of everyday answers
   * and a long tail — the everyday ones go in the first group so the common
   * case is the first thing read, without hiding the rest behind a toggle.
   */
  groups?: ReadonlyArray<{ label: string; options: ReadonlyArray<SelectOption> }>;
  defaultValue?: string | null; required?: boolean; placeholder?: string;
}) {
  return (
    <select id={name} name={name} required={required}
            defaultValue={defaultValue ?? ""} className={CONTROL}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
      {(groups ?? []).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function Checkbox({
  name, label, defaultChecked, value,
}: { name: string; label: string; defaultChecked?: boolean; value?: string }) {
  // The padded label is the hit area, not just the 16px box — the whole row is
  // tappable, which is what makes a checklist usable one-handed in a truck.
  return (
    <label className="flex min-h-9 items-center gap-2 py-1 text-[12.5px]">
      <input id={name} name={name} type="checkbox" value={value} defaultChecked={defaultChecked}
             className="h-4 w-4 border border-strong accent-primary" />
      {label}
    </label>
  );
}

/** Weekday picker for service patterns — ISO 1=Mon … 7=Sun. */
export function WeekdayPicker({
  name, defaultValue = [],
}: { name: string; defaultValue?: readonly number[] }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <fieldset className="flex flex-wrap gap-1.5">
      <legend className="sr-only">Service days</legend>
      {days.map((day, index) => {
        const value = index + 1;
        const id = `${name}-${value}`;
        return (
          <span key={value}>
            <input type="checkbox" id={id} name={name} value={value}
                   defaultChecked={defaultValue.includes(value)} className="peer sr-only" />
            <label htmlFor={id}
                   className="flex min-h-9 cursor-pointer items-center border px-3 py-1.5 text-sm
                              peer-checked:border-primary peer-checked:bg-primary/10
                              peer-checked:font-medium peer-checked:text-primary
                              peer-focus-visible:outline peer-focus-visible:outline-2">
              {day}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}

/** Disables itself while the server action is in flight. */
export function SubmitButton({
  children = "Save", variant = "primary", pendingLabel = "Saving…",
}: { children?: ReactNode; variant?: "primary" | "danger" | "secondary"; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  // Mirrors BUTTON_VARIANTS in ui.tsx — near-black action, not the teal accent.
  const variants = {
    primary: "bg-action text-action-foreground hover:opacity-90",
    danger: "bg-danger text-white hover:opacity-90",
    secondary: "border border-strong bg-surface hover:bg-surface-muted",
  } as const;
  return (
    <button type="submit" disabled={pending}
            className={cx(
              "inline-flex min-h-9 items-center justify-center px-3 py-1.5 text-[12.5px] font-medium transition",
              "disabled:pointer-events-none disabled:opacity-60", variants[variant],
            )}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-t pt-4">{children}</div>;
}
