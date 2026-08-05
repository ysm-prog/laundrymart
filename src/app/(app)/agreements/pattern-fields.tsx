"use client";

import { useState } from "react";
import { Field, Input, Select, Textarea, WeekdayPicker } from "@/components/form";
import type { ServicePattern } from "@/lib/domain/service-calendar";

const TYPES = [
  { value: "weekly", label: "Weekly" },
  { value: "alternate_weekly", label: "Alternate weekly" },
  { value: "monthly_nth", label: "Monthly (nth weekday)" },
  { value: "custom", label: "Custom dates" },
];

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  .map((label, index) => ({ value: String(index + 1), label }));

const NTH = [
  { value: "1", label: "First" }, { value: "2", label: "Second" },
  { value: "3", label: "Third" }, { value: "4", label: "Fourth" },
  { value: "5", label: "Fifth" }, { value: "-1", label: "Last" },
];

/**
 * The one genuinely interactive form in the app: which fields matter depends on
 * the pattern type, so it re-renders client-side. Everything still submits as
 * plain form fields — the server action assembles the JSON.
 */
export function PatternFields({
  prefix, legend, value,
}: { prefix: string; legend: string; value?: ServicePattern }) {
  const [type, setType] = useState<string>(value?.type ?? "weekly");

  const weekdays = value && "weekdays" in value ? value.weekdays : [];
  const anchor = value && value.type === "alternate_weekly" ? value.anchorDate : "";
  const monthlyWeekday = value && value.type === "monthly_nth" ? String(value.weekday) : "1";
  const nth = value && value.type === "monthly_nth" ? String(value.nth) : "1";
  const dates = value && value.type === "custom" ? value.dates.join("\n") : "";

  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{legend}</legend>

      <div className="space-y-1">
        <label htmlFor={`${prefix}_type`} className="block text-sm font-medium">Repeat</label>
        <select
          id={`${prefix}_type`} name={`${prefix}_type`} value={type}
          onChange={(event) => setType(event.target.value)}
          className="w-full rounded-md border bg-surface px-3 py-2 text-sm"
        >
          {TYPES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {type === "weekly" || type === "alternate_weekly" ? (
        <Field label="Service days" name={`${prefix}_weekdays`}>
          <WeekdayPicker name={`${prefix}_weekdays`} defaultValue={weekdays} />
        </Field>
      ) : null}

      {type === "alternate_weekly" ? (
        <Field label="Anchor date" name={`${prefix}_anchor`}
               hint="Any date in a week that IS serviced — alternate weeks are counted from here">
          <Input name={`${prefix}_anchor`} type="date" defaultValue={anchor} />
        </Field>
      ) : null}

      {type === "monthly_nth" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Which" name={`${prefix}_nth`}>
            <Select name={`${prefix}_nth`} options={NTH} defaultValue={nth} />
          </Field>
          <Field label="Weekday" name={`${prefix}_weekday`}>
            <Select name={`${prefix}_weekday`} options={WEEKDAYS} defaultValue={monthlyWeekday} />
          </Field>
        </div>
      ) : null}

      {type === "custom" ? (
        <Field label="Dates" name={`${prefix}_dates`} hint="One YYYY-MM-DD per line">
          <Textarea name={`${prefix}_dates`} rows={4} defaultValue={dates} placeholder="2026-03-02" />
        </Field>
      ) : null}
    </fieldset>
  );
}
