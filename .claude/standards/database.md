# Database Standard

- Use clear, consistent names.
- Enforce important integrity rules at the database boundary where appropriate.
- Index based on real query patterns and cardinality.
- Review query plans for important or high-volume queries.
- Make migrations explicit, ordered, and safe for existing data.
- Consider rollback or forward-fix strategy.
- Avoid premature partitioning and denormalisation.
- Define deletion, retention, and audit behaviour intentionally.
