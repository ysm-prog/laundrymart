// Instant shell on every navigation — data streams in under <Suspense>.
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-7 w-48 animate-pulse rounded bg-surface-muted" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-muted" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />
    </div>
  );
}
