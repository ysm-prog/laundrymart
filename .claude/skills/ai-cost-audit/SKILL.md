---
name: ai-cost-audit
description: Audit model-calling endpoints for prompt-caching coverage and estimated savings, and for the tenant-cache-safety pitfall. Use for "audit AI costs", "reduce AI spend", or before adding an AI feature.
---
Find model calls (`grep -rn "api.anthropic.com" src/`). Per call: model, is there a stable >=1024-token prefix under cache_control, call frequency. Classify NO_CACHE / PARTIAL / GOOD / N/A; estimate savings (cached reads ~90% cheaper). SECURITY: only the tenant-INVARIANT prefix may be cached — a cache_control block built from one tenant's data can surface in another tenant's request (flag HIGH, not a cost win). Don't auto-fix; present findings, fix one endpoint at a time.
