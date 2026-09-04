# Architecture

## ADR-001: control-plane boundaries

Okame uses Next.js 16.3 App Router for the web/API control plane, PostgreSQL with Drizzle as its source of truth, n8n for orchestration, and LiteLLM solely as the inference deployment target.

Domain rules live in server modules and pure policy functions. Route handlers validate input and translate failures to a consistent envelope. React components render operations data but do not decide ownership, limits, or changes.

The production implementation uses Next.js server routes and domain services behind PostgreSQL/Drizzle. MongoDB and direct Docker-socket mutation are not part of the architecture.

Milestone flow: `LiteLLM → adapter validation → ownership classification → sanitized normalization → PostgreSQL → server-rendered UI`. Smoke tests persist run/results and audit events. Administrative LiteLLM mutation is not enabled yet.
