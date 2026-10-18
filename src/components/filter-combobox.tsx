"use client";

import { useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import { CONTROL, cx } from "@/components/ui";

/**
 * A type-ahead over a long list, posting the chosen id under `name`
 * (Darshan's review, brief 3.10).
 *
 * The customer filter on Customer laundry and Driver visits was a `<select>`
 * of several hundred businesses — scrolled, never searched. This is the same
 * field in a form a person can type into: the text box narrows the options,
 * picking one sets the hidden value the GET form submits, and clearing the box
 * clears the filter. Without JavaScript the hidden input still posts whatever
 * the page rendered with, so a filtered link keeps working.
 */
export function FilterCombobox({
  name, label, value, options, anyLabel, className,
}: {
  name: string;
  label: string;
  value?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** What an empty box means, shown as the placeholder: "Any customer". */
  anyLabel?: string;
  className?: string;
}) {
  const inputId = useId();
  const listId = `${inputId}-list`;
  const initial = options.find((option) => option.value === value);
  const [chosen, setChosen] = useState(initial?.value ?? "");
  const [text, setText] = useState(initial?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const term = text.trim().toLowerCase();
    const pool = term && text !== options.find((o) => o.value === chosen)?.label
      ? options.filter((option) => option.label.toLowerCase().includes(term))
      : options;
    return pool.slice(0, 12);
  }, [text, options, chosen]);

  function choose(option: { value: string; label: string }) {
    setChosen(option.value);
    setText(option.label);
    setOpen(false);
  }

  function clear() {
    setChosen("");
    setText("");
    setOpen(false);
  }

  return (
    <div className={cx("relative", className)}>
      <label htmlFor={inputId} className="sr-only">{label}</label>
      <input type="hidden" name={name} value={chosen} />
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={text}
        placeholder={anyLabel ?? `Any ${label.toLowerCase()}`}
        className={cx(CONTROL, "pr-10")}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setOpen(true);
          if (event.target.value.trim() === "") setChosen("");
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[active]) {
            // Enter chooses the highlighted option; it does not submit the
            // filter with half a name in the box.
            event.preventDefault();
            choose(matches[active]!);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {text ? (
        <button type="button" onClick={clear} aria-label={`Clear ${label.toLowerCase()}`}
                className="absolute right-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center
                           justify-center rounded-md text-muted-foreground hover:text-foreground">
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
      {open && matches.length > 0 ? (
        <ul id={listId} role="listbox" aria-label={label}
            className="absolute z-20 mt-1 max-h-72 w-full min-w-[14rem] overflow-y-auto rounded-lg border
                       bg-surface py-1 shadow-lg">
          {matches.map((option, index) => (
            <li key={option.value} id={`${listId}-${index}`} role="option"
                aria-selected={option.value === chosen}
                // mousedown, not click: the input's blur closes the list first.
                onMouseDown={(event) => { event.preventDefault(); choose(option); }}
                className={cx("flex min-h-11 cursor-pointer items-center px-3 text-sm",
                  index === active ? "bg-surface-muted" : "hover:bg-surface-muted")}>
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
