# Architecture

## ADR-001: control-plane boundaries

RatLLM uses Next.js 16.3 App Router for the web/API control plane, PostgreSQL with Drizzle as its source of truth, a database-backed worker for scheduling and orchestration, and LiteLLM solely as the inference deployment target.

Domain rules live in server modules and pure policy functions. Route handlers validate input and translate failures to a consistent envelope. React components render operations data but do not decide ownership, limits, or changes.

The production implementation uses Next.js server routes and domain services behind PostgreSQL/Drizzle. MongoDB and direct Docker-socket mutation are not part of the architecture.

Milestone flow: `LiteLLM → adapter validation → ownership classification → sanitized normalization → PostgreSQL → server-rendered UI`. Smoke tests persist run/results and audit events. RatLLM does write to LiteLLM, in a bounded way: it adds deployments (promotion), blocks/unblocks and deletes them, pushes the lane fallback chains, and — when an operator explicitly adopts one — records itself as the manager in a deployment's metadata. Automation only ever touches deployments RatLLM manages; changes to any other deployment are explicit operator actions, confirmed by typing the deployment's own LiteLLM ID, and every change is recorded as an audit event.
