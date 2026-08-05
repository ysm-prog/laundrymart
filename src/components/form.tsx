"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { cx } from "./ui";

/* Flat, square, a stronger hairline than the surrounding rules, on the muted
   fill the pack uses for entry fields. */
const CONTROL =
  "w-full border border-strong bg-surface-muted px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground disabled:opacity-60";

export function Field({
  label, name, hint, error, required, children, className,
}: {
  label: string; name: string; hint?: string; error?: string;
  required?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <div className={cx("space-y-1", className)}>
      <label htmlFor={name}
             className="block font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
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

export function Select({
  name, options, defaultValue, required, placeholder,
}: {
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValue?: string | null; required?: boolean; placeholder?: string;
}) {
  return (
    <select id={name} name={name} required={required}
            defaultValue={defaultValue ?? ""} className={CONTROL}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function Checkbox({
  name, label, defaultChecked,
}: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <input id={name} name={name} type="checkbox" defaultChecked={defaultChecked}
             className="h-3.5 w-3.5 border border-strong accent-primary" />
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
                   className="cursor-pointer rounded-md border px-3 py-1.5 text-sm
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
              "inline-flex items-center justify-center px-3 py-1.5 text-[12.5px] font-medium transition",
              "disabled:pointer-events-none disabled:opacity-60", variants[variant],
            )}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-t pt-4">{children}</div>;
}
