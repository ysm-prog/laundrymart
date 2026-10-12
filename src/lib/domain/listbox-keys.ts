/**
 * Keyboard rule for the type-ahead pickers (2026-10-12). Two defects in the job
 * form: Enter with nothing highlighted submitted the whole job, and the first
 * ArrowDown landed on the *second* suggestion because the first was already
 * "active" before anybody had pressed anything. So nothing is highlighted until
 * the first arrow, the first ArrowDown highlights the first option, and Enter
 * never reaches the form — it picks the highlighted option or does nothing.
 */
export type ListboxAction =
  | { kind: "move"; active: number }
  | { kind: "pick"; index: number }
  | { kind: "close" }
  | { kind: "swallow" }
  | { kind: "ignore" };

export function listboxKey(key: string, active: number, count: number): ListboxAction {
  if (key === "ArrowDown") {
    return count > 0 ? { kind: "move", active: active < 0 ? 0 : (active + 1) % count } : { kind: "swallow" };
  }
  if (key === "ArrowUp") {
    return count > 0 ? { kind: "move", active: active <= 0 ? count - 1 : active - 1 } : { kind: "swallow" };
  }
  if (key === "Enter") {
    return active >= 0 && active < count ? { kind: "pick", index: active } : { kind: "swallow" };
  }
  if (key === "Escape") return { kind: "close" };
  return { kind: "ignore" };
}
