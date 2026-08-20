# Operations Standard

- Keep builds and deployments reproducible. Pin dependencies, base images, and tool versions.
- Take configuration from the environment, and keep environments genuinely separated.
- Keep secrets out of version control, out of logs, and give them a rotation path.
- Give every deployable change a rollback or forward-fix path that someone can execute under pressure.
- Expose health and readiness signals a deployment can act on rather than assuming success.
- Keep logs structured, traceable to a request, and free of credentials and unnecessary personal data.
- Alert on user-visible symptoms. Give every alert an owner and a documented response.
- Back up whatever cannot be regenerated, and verify the restore rather than assuming it works.
- Record operational procedures where the people responding will actually find them.
- Prefer operational simplicity. Add infrastructure only when a demonstrated need justifies the cost of running it.
