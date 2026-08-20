"use client";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-action px-3 py-2 text-sm font-medium text-action-foreground hover:brightness-110"
    >
      {label}
    </button>
  );
}
