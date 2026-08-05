"use client";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
    >
      {label}
    </button>
  );
}
