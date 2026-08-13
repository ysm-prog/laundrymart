# Performance Standard

- Measure before optimising, and measure again afterwards. Report what actually improved.
- Optimise against evidence of real usage, not intuition about what is slow.
- Set explicit budgets for latency and payload size on paths where performance matters to users.
- Prefer fixing the access pattern or the algorithm over adding a cache.
- Give every cache a defined invalidation and consistency strategy before introducing it.
- Load data in bounded quantities. Paginate anything that grows with usage.
- Avoid repeated queries and repeated computation inside loops, requests, and renders.
- Keep work that need not block a response off the request path.
- Judge behaviour at realistic data volumes and concurrency, not at development scale.
- Prioritise by user-visible impact. A measurable slow path used constantly matters more than a faster one used rarely.
