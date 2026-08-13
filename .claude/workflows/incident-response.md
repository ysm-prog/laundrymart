# Incident Response Workflow

1. Establish impact first: what is broken, for whom, since when, and whether data is at risk. Impact determines urgency, not the apparent size of the cause.
2. Preserve evidence before changing anything. Capture the failing logs, metrics, error identifiers, and recent deployments; a restart often destroys the only record of the cause.
3. Stop the harm before finding the cause. Roll back, disable the feature flag, or block the failing path. Mitigation and diagnosis are separate activities and mitigation comes first.
4. Form a specific hypothesis and check it against the evidence. Correlate with what changed: deployments, configuration, data volume, dependency availability, and scheduled jobs.
5. Confirm the cause rather than assuming it. A change that coincides with the failure is a candidate, not a conclusion.
6. Apply the smallest fix that restores correct behaviour. Under incident conditions, a reversible fix is worth more than a complete one.
7. Verify recovery against the user-visible symptom, not only against the metric that alerted.
8. Assess the damage left behind: incorrect data written during the incident, unsent notifications, partially completed workflows, and anything requiring correction or disclosure.
9. Record the timeline, impact, cause, and remediation while the detail is still available.
10. Convert the incident into work: a regression test for the failure, whatever monitoring would have caught it sooner, and the follow-up fix if the incident fix was a stopgap.

Do not use an incident as justification for broad refactoring. Do not close an incident because the symptom disappeared without an explanation for why it did.

Apply `.claude/standards/operations.md`, `.claude/standards/testing.md`, `.claude/standards/security.md` and `.claude/standards/database.md` throughout.
