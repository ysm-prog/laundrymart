/**
 * The instant shell on every navigation — data streams in under <Suspense>.
 *
 * Shaped like the page that is coming (a title, a row of summary cards, a
 * table) so the layout does not jump when the real content lands.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6" aria-busy aria-label="Loading">
      <div className="space-y-2.5">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-muted" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-surface-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[104px] animate-pulse rounded-xl bg-surface-muted" />
        ))}
      </div>
      <div className="h-[22rem] animate-pulse rounded-xl bg-surface-muted" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
