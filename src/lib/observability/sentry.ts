// Observability stub. Wire @sentry/nextjs and tag every event with the tenant so
// incidents are scoped to a tenant, not the whole fleet. Scrub PII/secrets in beforeSend.
export function tagTenant(tenantId: string) { /* Sentry.setTag("tenant", tenantId) */ void tenantId; }
