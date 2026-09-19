# RatLLM Full Repository Assessment

**Assessment date:** 2026-09-17 (America/Los_Angeles)  
**Repository revision reviewed:** `b7251a9`  
**Scope:** application architecture, API and worker behavior, PostgreSQL model, LiteLLM integration, provider credentials, discovery, verification, health monitoring, lanes, benchmarks, automation, deployment, security, scalability, testing, and the TypeScript/Python/MCP direction.

## 1. Executive verdict

RatLLM is a functioning prototype/control plane, not yet a production-reliable automation platform.

The important distinction is that most individual workflows exist and several work in the live environment, but the system does not yet provide trustworthy guarantees that the whole loop is healthy. It reports process health independently from integration health, runs long workflows inside web requests, relies on a single polling worker with non-renewing leases, exposes dangerous mutation routes when an optional token is absent, and has several features whose labels overstate what they actually do.

The live server proves that the project is not empty or fundamentally broken:

- all nine automation job types are scheduled and have recent successful executions;
- 26 provider credential references exist, of which 18 were valid at assessment time;
- 102 deployment records, 13,527 smoke tests, 92 lane assignments, 3,888 lane snapshots, and 3,125 run records exist;
- 23 of 26 discovery sources were healthy;
- 54 active deployments were healthy, 5 rate-limited, 1 degraded, and 8 unavailable;
- the current production build and TypeScript typecheck pass;
- all 78 unit tests pass.

However, those numbers also show why the system should not be called “100% working”:

- six configured credentials were invalid and two were unverified;
- three discovery sources were degraded;
- expected capacity conditions generate repeated failed promotion runs;
- the advertised rate-limit learning does not measure rate limits;
- custom discovery sources can be created and “synced” but do not participate in actual candidate discovery;
- the security boundary is optional and currently absent;
- lint is failing and there are no integration or end-to-end tests.

### Overall recommendation

Do not perform a big-bang Python rewrite. First stabilize contracts, security, job semantics, and data ownership. Keep Next.js/TypeScript for the UI. Move orchestration and integration work behind a durable service boundary. That service may be Python if the long-term team preference is Python and the next phase is heavily agentic/MCP-oriented, but the migration should be capability-by-capability with parity tests and a shared API/schema contract.

The principal problem is not TypeScript. The principal problem is that web UI, API mutations, orchestration, scheduling, adapter execution, and operational truth are too tightly coupled.

## 2. Assessment method and limitations

The assessment used:

- source review of all server modules, API routes, schema/migrations, Compose files, tests, and architecture documents;
- a read-only audit of the server PostgreSQL database at `192.168.5.48`;
- functional checks against the local web build connected to the server database;
- the repository's unit tests, lint, typecheck, and production build;
- inspection of current automation schedules, source state, credential validation state, run failures, leases, and deployment health.

No application fixes were made as part of this assessment. The only new repository artifact is this report. Earlier operational setup changed the ignored local `.env` and local container topology; those are not source changes.

Secrets are intentionally omitted. Credentials exposed during troubleshooting must be treated as compromised and rotated under a controlled credential-encryption migration plan.

## 3. Quality-gate results

| Check | Result | Meaning |
|---|---:|---|
| Unit tests | 78 passed | Pure policy functions have useful coverage. |
| TypeScript | Passed | Current source is type-correct. |
| Production build | Passed | Next.js 16.3.4 production compilation succeeds. |
| ESLint | **Failed** | Two `react-hooks/set-state-in-effect` violations in `src/components/search-palette.tsx`. |
| Integration tests | Missing | Database, LiteLLM, provider, worker, and route behavior are not exercised automatically. |
| End-to-end tests | Missing | `test:e2e` exists in `package.json`, but no Playwright tests/configuration are present. |
| Migration tests | Missing | Migrations are not applied to a clean DB and an upgrade fixture in CI. |
| Security tests | Missing | No authorization, SSRF, secret-redaction, or destructive-action regression suite. |

The current test suite is valuable but narrow. It proves helpers and policies, not the automation loop.

## 4. Prioritized findings

Severity definitions:

- **Critical:** plausible unauthorized control, secret loss, or destructive external mutation.
- **High:** correctness/reliability defect that can make automation lie, duplicate work, or operate on the wrong state.
- **Medium:** scalability, maintainability, observability, or product-contract weakness.
- **Low:** quality/documentation issue with limited immediate operational impact.

### F-01 — Critical — Mutation APIs are public when `ADMIN_TOKEN` is absent

**Evidence**

- `proxy.ts:4-8` explicitly allows every request through when `ADMIN_TOKEN` is unset.
- The reviewed server configuration has `ADMIN_TOKEN` commented out.
- Public routes can store/delete provider credentials, change provider configuration, run automation, change LiteLLM configuration, promote candidates, change deployment lifecycle, sync inventory, and probe arbitrary model-source URLs.
- The comment in `src/app/api/litellm/deployments/[id]/route.ts` confirms that a typed phrase is treated as the only guard for destructive actions.

**Impact**

Anyone who can reach the app can change credentials and control LiteLLM. A confirmation phrase is UX friction, not authorization.

**Required improvement**

1. Make authentication fail closed in every non-demo environment.
2. Separate browser session authentication from service-to-service authentication.
3. Require explicit authorization roles for read, operate, credential-admin, and destructive actions.
4. Protect at the route/service layer, not only in Next.js proxy middleware.
5. Add CSRF protection for browser mutations and rate limits for expensive actions.
6. Keep health/readiness public only if network policy requires it; return minimal data.

**Acceptance criteria**

- Starting production without authentication configuration fails startup.
- Every mutation route returns 401/403 without valid authorization.
- Integration tests enumerate all routes and prove their access policy.
- Audit events record a real authenticated principal, not hardcoded `admin`, `user`, or `system` strings.

### F-02 — Critical — Server-side request forgery and arbitrary network probing

**Evidence**

- `src/app/api/settings/model-sources/action/route.ts:14-18` fetches a database-provided URL without address validation.
- `src/app/api/settings/model-sources/route.ts` accepts arbitrary URLs.
- `src/app/api/settings/litellm/route.ts` accepts arbitrary HTTP(S) base URLs, later fetched with a privileged LiteLLM key.
- Custom provider base URLs are arbitrary and are later used for verification and promotion.

**Impact**

An authorized—or currently unauthenticated—caller can probe loopback, LAN services, cloud metadata endpoints, or internal control services. Redirects can bypass naïve initial URL validation.

**Required improvement**

- Create one outbound-request policy used by every adapter.
- Resolve DNS and reject loopback, link-local, multicast, metadata, and private ranges unless the integration is explicitly allowlisted for the deployment.
- Revalidate every redirect target or disable redirects.
- Add per-integration hostname allowlists and egress firewall rules.
- Never forward credentials across a host-changing redirect.

**Acceptance criteria**

- Tests cover IPv4, IPv6, encoded IPs, DNS rebinding, redirects, and cloud metadata addresses.
- Production egress policy limits the worker to approved providers and configured LiteLLM endpoints.

### F-03 — Critical — Weak/exposed secrets and no credential-rotation design

**Evidence**

- The server uses a trivial PostgreSQL password and exposes PostgreSQL on the LAN.
- Live LiteLLM, N8N, internal API, database, and encryption secrets were shared during troubleshooting.
- Provider credentials are encrypted with one application-wide AES-GCM key (`src/server/credentials/crypto.ts`).
- There is no key identifier, keyring, re-encryption job, or rotation procedure.

**Impact**

Compromise of the application encryption key compromises every stored provider credential. Replacing it directly makes existing encrypted values unreadable. Plain PostgreSQL over a LAN also exposes credentials/data to network interception unless the LAN is independently trusted and isolated.

**Required improvement**

- Rotate all exposed service/database secrets immediately.
- Introduce versioned envelope encryption with a key ID and keyring.
- Implement online re-encryption: decrypt with old key, encrypt with active key, verify, then retire old key.
- Prefer a secrets manager/KMS; otherwise mount a root-owned secret file rather than a broadly copied `.env`.
- Require TLS for remote PostgreSQL and restrict port 5432 by firewall/VPN.

**Acceptance criteria**

- A documented rotation drill completes without credential loss.
- Old and new encrypted records can coexist during migration.
- Database connections verify server certificates.
- Secret scanning runs in CI and logs/tests prove no secret-shaped values are emitted.

### F-04 — High — Health endpoints report process health, not operational readiness

**Evidence**

- `/api/health` checks only the app.
- `/api/ready` checks app plus PostgreSQL.
- The app reported ready while LiteLLM was unreachable, its master key was a placeholder, discovery had never run, and all functional tables were empty.

**Impact**

Operators receive a green signal for a control plane that cannot perform its primary work.

**Required improvement**

Define separate health dimensions:

- **liveness:** process event loop responds;
- **readiness:** DB schema compatible and required configuration valid;
- **dependency health:** LiteLLM, provider credentials, worker heartbeat;
- **data freshness:** last discovery, inventory sync, health monitor, lane snapshot;
- **functional status:** counts of degraded sources, invalid credentials, unknown/stale deployments, failed jobs.

Do not make Kubernetes/Docker readiness depend on every external provider, but expose an operational status endpoint and make the UI clearly distinguish degraded from ready.

**Acceptance criteria**

- A missing LiteLLM connection visibly produces `DEGRADED`, not a generic healthy state.
- Worker heartbeat and schedule lag are measured.
- Startup reports uninitialized discovery/inventory explicitly.

### F-05 — High — Deployment modes make split-brain/empty-database operation too easy

**Evidence**

- The default Compose stack starts a local DB and worker.
- Workstation remote mode requires a second Compose overlay and a host-rewritten `DATABASE_URL`.
- The same `.env` syntax has different correct database hostnames on server and workstation.
- This caused the local build to show an empty but apparently healthy application while production data remained on the server.

**Impact**

Operators can unknowingly run two control planes and two schedulers against different databases—or worse, two workers against the same database.

**Required improvement**

- Create explicit profiles/commands: `server`, `workstation-remote`, and `demo`.
- Use separate example files such as `.env.server.example` and `.env.workstation.example`.
- Add a deployment identity and environment banner sourced from DB plus build metadata.
- Add a singleton worker heartbeat/identity table and alert on multiple active workers.
- Refuse workstation startup when `DATABASE_URL` points at `curator-db` under remote mode.

**Acceptance criteria**

- One documented command starts each supported topology.
- UI always shows database host/cluster identity safely (without credentials).
- CI validates the rendered Compose configuration for every profile.

### F-06 — High — Scheduler is not a durable job system

**Evidence**

- `src/server/worker.ts` polls every 10 seconds in one Node process.
- `src/server/automation/service.ts:34` creates a fixed 10-minute lease with no renewal.
- Due jobs execute concurrently with `Promise.allSettled` (`service.ts:53`).
- Manual HTTP calls use the same in-process functions.
- Job payload, progress, attempt, cancellation, checkpoint, and retry policy are not persisted.

**Impact**

Long work can outlive its lease and be started by another worker. A process restart loses in-flight context. HTTP clients remain connected to jobs that can take minutes. Multiple due jobs can saturate provider quotas, LiteLLM, or the five-connection DB pool simultaneously.

The live deep benchmark took about 4.3 minutes, already consuming a meaningful fraction of the fixed lease. Worst-case provider timeouts can exceed it.

**Required improvement**

- Introduce a durable job queue with persisted attempts and visibility timeouts/heartbeats.
- HTTP routes should enqueue and return `202 Accepted` with a run ID.
- Workers should renew leases, checkpoint batches, support cancellation, and use job-specific retry/backoff policies.
- Add global, provider, and integration concurrency controls.
- Add dead-letter handling and a clear distinction between retryable and terminal failures.

**Acceptance criteria**

- Killing a worker mid-job does not lose or duplicate completed work.
- A job longer than ten minutes cannot be executed concurrently.
- UI polls/streams run progress by run ID.

### F-07 — High — Discovery is hardcoded, inefficient, and custom sources are not real discovery sources

**Evidence**

- `src/server/discovery/sources.ts` constructs adapters only from the compile-time `sourceRegistry`.
- `runDiscovery()` filters those compiled adapters using DB enablement; it never constructs adapters from user-created `model_sources` rows.
- The settings API allows `PROVIDER_API`, `OPENAI_COMPATIBLE`, `JSON_FEED`, `MANUAL`, and `CUSTOM_ADAPTER` rows, creating the impression that custom sources participate.
- The source “sync” action only fetches JSON and updates a count; it does not normalize or persist candidates.
- `runDiscovery()` performs per-item existence queries and updates/inserts (`run.ts:44-58`). `findDuplicateCandidate()` reloads all candidates for a provider for each new item.
- Consolidation performs row-by-row provider backfills and duplicate merges.

**Impact**

The product contract is misleading, and discovery cost trends toward quadratic behavior as sources/models grow. Partial failures are difficult to retry independently.

**Required improvement**

- Define a versioned `DiscoveryAdapter` contract with capabilities, configuration schema, credential requirements, pagination, cursor/watermark, normalization, and evidence rules.
- Either implement DB-defined source execution or remove unsupported source types from the UI.
- Stage source results into a temporary table, then use set-based PostgreSQL upserts and reconciliation.
- Preserve per-source cursors and immutable discovery-run/source-run records.
- Bound payload size and item count; stream large catalogs rather than materializing all results.

**Acceptance criteria**

- A custom JSON/OpenAI-compatible source produces candidates end-to-end in an integration test.
- Discovery query count grows approximately with sources/batches, not individual items squared.
- Each source has an independent run status, error class, duration, item count, and retry action.

### F-08 — High — “Rate-limit learning” produces invalid RPM semantics

**Evidence**

- `src/server/rate-limits/learn.ts:12` loads up to 30 smoke-test rows, counts non-429 responses, and stores 70% of that count as `safeRpm`.
- Queries are not ordered, so the selected 30 are not guaranteed to be the most recent.
- No requests-per-minute window is measured.
- TPM is not learned.
- Retry-After and provider rate-limit headers are ignored.
- `sampleCount` repeatedly adds the reused window size, inflating evidence on every run.

**Impact**

Displayed “safe RPM” values can be numerically precise but meaningless. Downstream routing decisions based on them would be unsafe.

**Required improvement**

Until real measurement exists, rename this to smoke-test capacity evidence and stop publishing RPM/TPM estimates. For actual learning:

- ingest LiteLLM usage/response telemetry or perform controlled probes;
- model explicit time windows;
- parse standardized and provider-specific headers;
- record Retry-After, quota reset, request/token counts, and confidence expiration;
- never infer TPM without token usage;
- keep observed evidence immutable and derive current policy separately.

**Acceptance criteria**

- Every displayed limit has source, window, observation time, sample definition, and expiry.
- A deterministic test fixture validates RPM/TPM calculations.
- Re-running derivation over the same evidence does not increase sample count.

### F-09 — High — Inventory lifecycle and health selection disagree

**Evidence**

- `src/server/litellm/sync.ts:84-92` marks missing deployments `REMOVED`/`UNAVAILABLE` but leaves `litellmDeploymentId` populated.
- `src/server/health/monitor.ts:84-88` selects every deployment with a non-null LiteLLM ID and enabled provider; it does not require lifecycle `ACTIVE`.
- Therefore historical/external-removed deployments remain eligible for health probes.
- The manual smoke route tests the shared model alias, whereas the automated monitor deliberately tests the exact deployment ID to avoid misattribution.

**Impact**

The monitor wastes capacity on stale records and may produce confusing historical health changes. Manual and automated tests can attribute results to different physical deployments.

**Required improvement**

- Define one invariant: a live deployment has `lifecycle=ACTIVE` and a current remote ID; historical deployments are never probed.
- Clear or archive remote IDs on removal, or filter every active workflow by lifecycle and last-seen generation.
- Make all per-deployment smoke tests target the exact remote deployment ID.
- Add reconciliation tests for active, blocked, externally deleted, auto-removed, and re-added deployments.

**Acceptance criteria**

- Removed deployments generate zero new smoke tests.
- Manual and scheduled checks hit the same remote target.
- State-transition tests enforce legal lifecycle transitions.

### F-10 — High — Multi-step mutations are not transactional or compensating

**Evidence**

- Promotion performs provider verification, multiple LiteLLM writes, inventory sync, smoke tests, lane assignment writes, fallback writes, and audit writes sequentially.
- Partial target success is intentionally retained, but there is no durable saga/compensation state.
- Fallback synchronization errors are swallowed in `src/server/lanes/promote.ts`.
- Inventory sync writes providers, canonical models, deployments, rate profiles, assignments, missing-state updates, run status, and audit events without a database transaction.

**Impact**

Crashes and partial external failures can leave LiteLLM and PostgreSQL disagreeing. A run can appear successful while fallback propagation failed.

**Required improvement**

- Model external mutations as durable operations with explicit desired state and reconciliation.
- Use DB transactions for local atomic groups.
- Persist each external step and idempotency key before execution.
- Treat fallback failures as visible degraded results, not ignored exceptions.
- Reconciliation should converge from desired state, making retries safe.

**Acceptance criteria**

- Fault-injection tests at every promotion step converge on retry.
- No successful run hides a failed required sub-step.

### F-11 — High — Run status and automation status hide partial failure and expected control flow

**Evidence**

- Discovery is marked failed only when every active source fails; one or many failed sources still yield a successful overall run.
- Auto-promotion records “all recommended lanes are at capacity” as a failed run and repeats attempts.
- In the live last-24-hour sample, 33 candidate promotions failed and 32 succeeded. Many failures were predictable lane-capacity or credential prerequisites.
- Automation job rows still showed `SUCCEEDED` with zero failures because `autoAddIfEligible()` catches promotion exceptions.

**Impact**

The operator cannot infer system health from either the Runs page or automation job status. Expected waiting states create noise while real sub-failures are hidden.

**Required improvement**

- Use richer outcomes: `SUCCEEDED`, `PARTIAL`, `DEFERRED`, `BLOCKED`, `FAILED`, `CANCELLED`.
- Treat lane capacity and missing prerequisites as blocked/deferred decisions with next eligibility, not execution failures.
- Aggregate source and child-operation failures into parent status.
- Persist structured error codes rather than relying on message text.

**Acceptance criteria**

- A discovery run with any failed enabled source is at least `PARTIAL`.
- Capacity-blocked candidates are not retried every hour without a state change.
- Dashboards report actionable failure counts separately from expected deferrals.

### F-12 — Medium — Candidate verification does excessive full-dataset work

**Evidence**

- `verifyDueCandidates()` calls `getModelCandidates()` before filtering due records.
- `getModelCandidates()` loads candidates, providers, credential references, deployments, and lane assignments, then performs substantial matching in memory.
- The due batch is capped at 300 only after full enrichment.

**Impact**

DB reads, heap usage, and CPU scale with the entire candidate universe even when few candidates are due. This will become expensive as catalogs grow.

**Required improvement**

- Promote scheduling fields (`next_check_at`, last status, consecutive success/failure, provider ID) from JSON evidence to indexed columns.
- Query only due candidates in SQL with provider/credential eligibility.
- Claim candidates using `FOR UPDATE SKIP LOCKED` or queue jobs per candidate/provider.
- Keep evidence JSON for source detail, not scheduler indexes.

**Acceptance criteria**

- Verification query volume depends on batch size, not total candidates.
- Two workers cannot verify the same candidate concurrently.

### F-13 — Medium — Server-rendered pages return oversized, unpaginated datasets

**Evidence**

Observed local response sizes against the server DB:

- `/litellm`: approximately 3.7 MB;
- `/models`: approximately 2.55 MB;
- `/providers`: approximately 779 KB.

Queries such as `getModelCandidates()` and `getSourceYield()` load broad tables and perform matching/grouping in application memory. `getDeployments()` uses several correlated subqueries per deployment.

**Impact**

Page latency, memory, React serialization/hydration work, and database load will grow rapidly. The browser receives far more data than it can display at once.

**Required improvement**

- Add cursor pagination, server-side filtering/sorting, and compact list DTOs.
- Move aggregate calculations into indexed SQL/materialized summaries.
- Load details on demand.
- Set performance budgets for query count, response bytes, and p95 latency.

**Acceptance criteria**

- List pages remain below an agreed response budget (for example 200 KB initial payload).
- Load tests cover 10x current candidates, runs, and smoke tests.

### F-14 — Medium — Database model relies too heavily on mutable JSON evidence

**Evidence**

Candidate scheduler state, retry state, provider slug, last status/error, consecutive availability, failure history, removal history, and source detail are stored together in `model_candidates.evidence`.

**Impact**

Important workflow state lacks constraints, indexes, foreign keys, and clear migration semantics. Concurrent writers can overwrite each other's JSON changes.

**Required improvement**

- Separate immutable evidence/events from current workflow state.
- Promote fields used for filtering, ordering, joining, or invariants into typed columns/tables.
- Add optimistic versioning or transactional row locks for state transitions.
- Define retention/partitioning for high-volume `smoke_tests`, `candidate_checks`, audit events, and runs.

**Acceptance criteria**

- Scheduler queries use indexed typed columns.
- Concurrent updates cannot discard unrelated evidence.

### F-15 — Medium — Observability is insufficient for an automation control plane

**Evidence**

- Logging is primarily `console.info/error` with a basic redaction helper.
- No metrics endpoint, distributed tracing, alert rules, worker heartbeat, queue depth, provider latency metrics, or schedule-lag metric exists.
- Correlation IDs are inconsistently generated/propagated across child calls.
- Errors are sometimes swallowed.

**Required improvement**

- Emit structured logs with job/run/source/provider/deployment IDs.
- Add OpenTelemetry traces across HTTP, worker, DB, provider, and LiteLLM operations.
- Add metrics for due/running/failed jobs, schedule lag, source freshness, credential state, probe results, API latency, queue age, DB pool saturation, and reconciliation drift.
- Define alerts and runbooks.

**Acceptance criteria**

- An operator can answer “why is this lane empty?” from one trace/run without querying raw tables.
- Alerts fire on stale discovery, missing worker heartbeat, repeated auth failure, and reconciliation drift.

### F-16 — Medium — Documentation contradicts the implementation

**Evidence**

- `docs/ARCHITECTURE.md` says administrative LiteLLM mutation is not enabled; the code performs add/update/delete/fallback operations.
- `docs/DATABASE.md` and `docs/SECURITY.md` imply credential rows contain references rather than values; the schema stores encrypted credential values.
- Health-monitor comments mention “every few minutes” while the schedule is hourly.
- The README setup path can produce a green but functionally uninitialized system.

**Impact**

Security reviews, deployment decisions, and maintenance work are based on incorrect boundaries.

**Required improvement**

- Convert architecture decisions into current ADRs with status and supersession.
- Generate environment/config reference from the validated schema.
- Add doc checks to release review.
- Document every supported topology and ownership boundary.

### F-17 — Medium — Test coverage does not protect integration behavior

**Evidence**

- Existing tests cover pure helpers/policies only.
- No tests run PostgreSQL migrations, scheduler claims, discovery persistence, credential encryption through APIs, LiteLLM response variants, promotion rollback/reconciliation, SSRF rules, route authorization, or React flows.
- Lint currently fails in `src/components/search-palette.tsx:26` and `:34`.

**Required improvement**

Build a test pyramid:

1. Keep fast policy unit tests.
2. Add PostgreSQL integration tests using isolated containers/databases.
3. Add contract tests for every external adapter using recorded/synthetic fixtures.
4. Add worker/job recovery and concurrency tests.
5. Add Playwright smoke flows for setup, credentials, discovery, promotion, lanes, benchmarks, and runs.
6. Add migration tests for clean install and upgrade from the last supported release.
7. Make lint/typecheck/test/build mandatory in CI.

### F-18 — Medium — Provider/discovery adapters are data-heavy but behavior-light

**Evidence**

- Provider definitions, endpoint wiring, source trust, scraping rules, credential behavior, and UI metadata are split across multiple registries/files.
- Provider verification often proves only a list/auth endpoint, while candidate verification proves chat completion behavior.
- Capability inference relies partly on names and free-text heuristics.

**Impact**

Adding providers is error-prone, validation semantics vary, and “verified” can mean different things across screens.

**Required improvement**

Create one adapter package/manifest per provider with:

- configuration and credential schema;
- discovery support;
- auth verification;
- model listing and normalization;
- completion/tool/vision capability probes;
- rate-limit header parser;
- LiteLLM mapping;
- test fixtures and declared limitations.

Expose verification level explicitly: credential valid, catalog reachable, completion passed, tool call passed, vision passed, etc.

### F-19 — Low/Medium — Setup is not idempotent against an existing volume password

**Evidence**

`scripts/setup.sh` generates a new `.env` when it is absent, but the named PostgreSQL volume may already have a database initialized with a different password. PostgreSQL ignores new initialization environment variables for an existing data directory.

**Impact**

The web/worker restart-loop with authentication failures even though the DB container is healthy.

**Required improvement**

- Detect an existing volume before generating/changing the DB password.
- Provide an explicit recovery command that updates the role password or asks the operator to supply the original value.
- Make setup verify application DB authentication before reporting success.

### F-20 — Low — UI wording and status taxonomy contain stale assumptions

**Evidence**

- The discovery button says “Querying three discovery sources” while 26 sources exist.
- “Pending changes” says plans are not implemented even though several direct mutation/reconciliation paths exist.
- Several screens use “healthy” for materially different checks.

**Required improvement**

Centralize status vocabulary and derive UI copy from actual adapter/job data. Avoid hardcoded counts or implementation claims.

## 5. What is working today

The assessment should not obscure the good foundation:

- PostgreSQL is correctly treated as RatLLM's source of truth rather than sharing LiteLLM tables.
- Ownership boundaries distinguish managed from unmanaged LiteLLM deployments.
- Secrets are redacted from normalized LiteLLM metadata and encrypted at rest.
- Direct-provider checks and through-LiteLLM checks are intentionally separate, which is the correct conceptual model.
- Health checks target exact deployment IDs in the scheduled monitor.
- Lane rules and fallback intent are centralized.
- Automation schedules are staggered and the live worker is executing them on time.
- The source registry carries useful trust/evidence context.
- Pure policy logic has reasonable unit coverage.
- The project compiles and builds cleanly apart from the lint defects.

These pieces are worth preserving through any redesign.

## 6. TypeScript versus Python

### Finding

TypeScript is not preventing AI or MCP functionality. MCP has official TypeScript and Python SDKs, and the current system's core work—HTTP integrations, scheduling, PostgreSQL, reconciliation, and LiteLLM administration—does not intrinsically require Python.

The reason to introduce Python would be organizational and ecosystem-driven:

- the future team expects to build evaluation, embeddings, agents, scientific scoring, or ML/data pipelines in Python;
- Python is the preferred language for new backend contributors;
- the control plane needs a framework such as FastAPI plus Python-native AI libraries;
- a Python MCP server will own tools/resources/prompts that reuse the same application services.

The reason not to rewrite immediately:

- the difficult logic is domain state and external side effects, not language syntax;
- a rewrite would recreate dozens of provider mappings and lifecycle edge cases;
- without contracts and integration tests, parity cannot be proven;
- the existing Next.js UI is productive and should remain TypeScript.

### Recommended target

Use a **hybrid architecture with an explicit service boundary**:

1. **Next.js/TypeScript web application**
   - presentation, authenticated browser session, read APIs/BFF, user interaction;
   - no long-running jobs and no direct provider/LiteLLM orchestration.

2. **Control API/domain service**
   - versioned OpenAPI contract;
   - owns providers, sources, candidates, deployments, lanes, credentials, and desired state;
   - initially can remain TypeScript to reduce migration risk;
   - may be replaced incrementally by Python/FastAPI after contract tests exist.

3. **Durable worker system**
   - executes discovery, verification, health, reconciliation, and benchmarks;
   - job heartbeats, retries, checkpoints, concurrency/rate limits, dead-letter state;
   - Python is a reasonable choice here if future AI/evaluation work is Python-centric.

4. **MCP server**
   - a thin adapter over the control API, not a second implementation of domain logic;
   - begin with read-only tools/resources;
   - mutation tools require explicit confirmation, authorization scopes, idempotency keys, and audit trails;
   - never expose raw provider/LiteLLM credentials to an MCP client.

5. **PostgreSQL**
   - authoritative state and event history;
   - one migration owner;
   - service roles with least privilege;
   - partition/retain high-volume telemetry.

### Migration decision gate

Before choosing the control service language, build the same small vertical slice in both ecosystems:

- list providers/candidates;
- enqueue one verification job;
- persist result and emit progress;
- expose one read-only MCP resource and one guarded tool;
- run contract/load/security tests.

Choose based on operational simplicity, contributor productivity, library needs, and measured behavior—not the assumption that TypeScript cannot support AI.

Official SDK references to use during design:

- Model Context Protocol TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- Model Context Protocol Python SDK: <https://github.com/modelcontextprotocol/python-sdk>
- MCP documentation: <https://modelcontextprotocol.io/docs>

## 7. Recommended target data/workflow model

### Separate desired, observed, and historical state

- **Desired state:** enabled providers/sources, lane membership policy, automation settings.
- **Observed state:** current LiteLLM inventory, current credential status, latest provider/source/deployment health.
- **History/events:** discovery observations, verification attempts, smoke tests, mutations, audits.

Do not overwrite history to represent current state, and do not infer desired state from the last observed row.

### Core workflow entities

- `jobs`: type, priority, state, attempt, idempotency key, owner, heartbeat, schedule, timestamps.
- `job_steps`: source/provider/deployment unit of work and checkpoint.
- `source_runs`: one row per source per discovery run.
- `discovery_observations`: immutable source/model evidence.
- `candidate_state`: typed current verification/promotion state.
- `deployment_observations`: immutable LiteLLM inventory snapshots or changes.
- `credential_versions`: encrypted version, key ID, validation state, activation/retirement.
- `desired_lane_memberships` and `observed_lane_memberships`.

### State machines

Define and test legal transitions for:

- candidate: discovered → verifying → eligible/blocked → promoting → active/quarantined;
- deployment: desired → provisioning → active → degraded/deactivated → removed;
- job: queued → running → succeeded/partial/deferred/failed/cancelled;
- credential: configured → unverified → valid/invalid → rotated/disabled.

## 8. Phased remediation plan

### Phase 0 — Containment and truth (1–3 days)

1. Rotate exposed secrets; plan encryption-key rotation separately.
2. Put the app behind enforced authentication immediately.
3. Restrict PostgreSQL/LiteLLM/N8N network exposure.
4. Disable or restrict arbitrary outbound URL configuration until SSRF defenses exist.
5. Correct health/status language so green means what it says.
6. Fix lint and make the existing checks required.

**Exit condition:** unauthorized mutation and obvious secret/network risks are contained.

### Phase 1 — Establish contracts and tests (1–2 weeks)

1. Publish OpenAPI schemas and stable error codes.
2. Add Postgres integration tests and LiteLLM/provider mock servers.
3. Add end-to-end tests for the critical lifecycle.
4. Define adapter interfaces and workflow state machines.
5. Reconcile documentation with actual behavior.
6. Add environment/deployment identity and configuration validation.

**Exit condition:** current behavior is reproducible and safe to refactor.

### Phase 2 — Durable automation (2–4 weeks)

1. Introduce persistent jobs, heartbeats, retries, checkpoints, and cancellation.
2. Change manual routes to enqueue and return run IDs.
3. Add provider/global concurrency and backoff.
4. Replace full-dataset candidate scheduling with indexed due-state queries.
5. Add structured partial/deferred outcomes.

**Exit condition:** worker restarts and multiple workers do not duplicate or lose work.

### Phase 3 — Discovery and reconciliation redesign (2–4 weeks)

1. Implement the adapter contract and truthful custom-source support.
2. Use staging tables/set-based upserts for discovery.
3. Convert promotion/inventory/fallback operations to desired-state reconciliation.
4. Fix deployment lifecycle/health invariants.
5. Replace the current rate-limit feature with evidence-based semantics or remove the claim.

**Exit condition:** all enabled sources and integrations have measurable, independently retryable execution.

### Phase 4 — Scalability and observability (1–3 weeks)

1. Paginate and slim UI queries.
2. Add telemetry, dashboards, alerts, and runbooks.
3. Add retention/partitioning and backup/restore drills.
4. Load test at 10x current inventory/history.

**Exit condition:** performance and failure recovery meet explicit SLOs.

### Phase 5 — Python/MCP extraction (incremental)

1. Add the control API boundary while current TypeScript services remain authoritative.
2. Implement a read-only MCP server over that API.
3. Move one bounded worker capability to Python and prove contract parity.
4. Continue only where Python produces clear maintenance/ecosystem value.
5. Add scoped, audited mutation tools last.

**Exit condition:** language migration is reversible, observable, and behaviorally equivalent.

## 9. Proposed SLOs and operational acceptance tests

Recommended initial objectives:

- control API availability: 99.9% monthly;
- worker heartbeat age: under 60 seconds;
- scheduled-job start lag: under 2 minutes for hourly jobs;
- discovery freshness: each source within its declared refresh interval plus 10 minutes;
- LiteLLM inventory drift detection: under 10 minutes;
- active deployment health freshness: under 2 hours;
- zero duplicate execution for the same job/idempotency key;
- zero plaintext credentials in logs, API responses, runs, or audit records;
- restore drill proves database plus encryption keys can recover credential access.

Critical end-to-end acceptance scenario:

1. Discover a fixture model from a fixture source.
2. Verify a fixture credential and completion.
3. Accumulate eligibility evidence.
4. Promote into one lane through a fake LiteLLM.
5. Sync inventory and exact deployment ownership.
6. Smoke-test the exact deployment.
7. Populate benchmark and lane snapshot.
8. Simulate rate limit without counting it as a hard failure.
9. Simulate repeated hard failures and removal.
10. Recover/re-add under cooldown/flap rules.
11. Kill/restart the worker during each external mutation and prove convergence.

## 10. Immediate backlog ordered by priority

1. Enforce authentication and role-based authorization.
2. Rotate exposed secrets; design encryption-key migration.
3. Add SSRF/egress controls.
4. Correct operational health/readiness semantics.
5. Make server/workstation/demo deployment modes explicit and safe.
6. Add database/LiteLLM/route integration tests.
7. Introduce durable jobs and renewable leases.
8. Fix run outcome taxonomy and promotion retry noise.
9. Fix lifecycle/health target invariants.
10. Remove or redesign false RPM/TPM claims.
11. Implement truthful adapter-based custom discovery.
12. Optimize discovery and due-candidate queries.
13. Paginate/slim large pages.
14. Add observability/SLOs/runbooks.
15. Update architecture/security/deployment documentation.
16. Prototype the Python worker/control API and MCP adapter behind contracts.

## 11. Final conclusion

RatLLM has a valuable domain model and a surprising amount of working lifecycle logic. Its current weakness is not a lack of features; it is a lack of hard operational boundaries and trustworthy semantics around those features.

The next investment should not be “rewrite TypeScript in Python.” It should be:

1. secure the control plane;
2. define contracts and state machines;
3. make automation durable and observable;
4. make discovery/reconciliation set-based and independently retryable;
5. then extract Python/MCP capabilities incrementally.

Following that order preserves the hard-won provider/lifecycle knowledge already in the repository while making the system safe to extend into a real MCP-enabled AI operations platform.

## 12. Deep assessment: Free Model Source subsystem

### 12.1 The guarantee that is realistically possible

No system can guarantee that a third-party model will remain free or available forever. Providers can change prices, quotas, model IDs, authentication, regions, terms, or endpoints without notice.

RatLLM can and should guarantee something more precise:

1. every enabled source is fetched within its declared freshness objective;
2. every response is validated against a versioned contract;
3. every extracted claim retains immutable provenance;
4. no candidate is called “verified free” without provider-level evidence meeting an explicit policy;
5. no candidate is promoted without a live functional check using the intended credential and endpoint;
6. stale or contradictory evidence automatically lowers confidence and prevents unsafe promotion;
7. source/parser drift is detected within a bounded time;
8. every failure is visible, independently retryable, and covered by a runbook;
9. discovery accuracy, recall, freshness, and downstream yield are measured continuously;
10. a human can reproduce why any candidate was classified, verified, promoted, rejected, or retired.

That is the correct meaning of a reliable free-model discovery platform.

### 12.2 Current live discovery data

At assessment time, the server contained the following important source characteristics:

- 26 configured source rows;
- 23 source rows reporting healthy and 3 degraded;
- 5,835 total current candidate rows across the source breakdown query;
- 332 candidates marked `verified_free=true`;
- those 332 consisted of 26 OpenRouter candidates and 306 models.dev candidates;
- models.dev contributed 3,521 candidates, of which 2,471 had no resolved provider;
- Hugging Face contributed 1,217 candidates, of which 1,090 had no resolved provider;
- community/text sources also produced substantial unresolved/noisy inventory;
- current free-type distribution was heavily `UNKNOWN` (5,266 rows);
- some source rows had not produced a new observation for several days, partly due to their configured refresh intervals and partly because zero-result sources are only marked degraded.

Large inventory is not the same as good discovery. The useful metrics are provider-resolved, independently corroborated, recently verified, functionally callable, genuinely free candidates—not raw candidate count.

### 12.3 Critical discovery trust defects

#### D-01 — Critical — `candidateOnly` is documentation, not an enforced policy

`SourceConfig.candidateOnly` is set on Tier B/C community sources, and comments say those sources can never establish free status or directly enter LiteLLM. Repository search shows no promotion, verification, or eligibility logic reading `candidateOnly`.

Today, a community-source candidate can become promotable after direct checks because promotion policy is based on provider resolution, credential status, endpoint support, model type, and recent check status—not source authority.

**Required fix design**

- Persist `source_authority` and `candidate_only` with every observation.
- Separate “discovered lead” from “free entitlement proven.”
- Require one of:
  - authoritative provider pricing/quota evidence plus a live completion; or
  - an explicit provider model variant whose contract means free (for example a provider-owned `:free` variant), plus a live completion.
- Community corroboration may increase discovery confidence but must never satisfy the free-entitlement gate.
- Enforce the gate in the domain service used by both manual and automatic promotion; never rely only on UI hiding.

#### D-02 — Critical — models.dev entries are incorrectly promoted to “verified free” evidence

`ModelsDevSource` sets `verifiedFree=true` whenever `cost.input` and `cost.output` are zero. The registry description and `docs/models_source.md` explicitly warn that aggregator `$0` metadata does not prove a durable free API entitlement from a serving provider.

The live database shows 306 models.dev rows marked verified-free, accounting for most of the project's “verified free” count.

**Required fix design**

- models.dev zero-cost data must create `PRICE_ZERO_CLAIM`, not `FREE_ENTITLEMENT_VERIFIED`.
- Set source authority to aggregator/canonical metadata, not provider authority.
- Require provider resolution and authoritative entitlement evidence before setting verified-free.
- Reclassify existing candidates with a migration/re-evaluation job; do not merely change future ingestion.
- Preserve the old claim as provenance rather than deleting it.

#### D-03 — High — “Verified free” conflates at least five different claims

The current boolean mixes:

- catalog says price is zero;
- account has recurring free quota;
- model is available under a trial credit;
- credential successfully called the model once;
- model is operationally healthy through LiteLLM.

These are different facts with different expiry and routing implications.

**Required fix design**

Replace the boolean as the source of truth with structured claims and a derived eligibility decision. Keep a compatibility boolean only as a computed projection if needed.

#### D-04 — High — HTML/Markdown extraction is heuristic and lacks parser-drift protection

The generic text adapter:

- searches lines for broad free/focus words;
- matches model-like strings using one shared regular expression;
- stores a nearby text excerpt;
- does not validate page version/structure;
- cannot distinguish a current table row from historical prose, navigation, examples, paid sections, or removed models with high confidence;
- does not persist content hashes or raw snapshots for reproducibility.

This is useful as lead generation, but not authoritative free evidence.

**Required fix design**

- Use provider-specific parsers for authoritative A2 pages.
- Version each parser and its expected DOM/JSON schema.
- Store response content hash, ETag/Last-Modified, parser version, extraction count, and sampled evidence.
- Alert on structural drift, large count changes, empty output, duplicate explosion, or extraction outside expected sections.
- Retain sanitized raw fixtures or object-storage snapshots under a clear retention policy.

#### D-05 — High — zero results are treated as source degradation without explaining why

An authenticated catalog with no key, an intentionally empty provider response, parser drift, a changed schema, and “no free models currently” can all end as zero results/degraded. Some OpenAI-compatible sources silently return `[]` when required credentials are absent.

**Required fix design**

Use explicit source-run outcomes:

- `SUCCESS_WITH_RESULTS`;
- `SUCCESS_EMPTY_CONFIRMED`;
- `SKIPPED_NOT_DUE`;
- `BLOCKED_CREDENTIAL_MISSING`;
- `BLOCKED_CREDENTIAL_INVALID`;
- `FAILED_NETWORK`;
- `FAILED_AUTH`;
- `FAILED_SCHEMA`;
- `FAILED_PARSER_DRIFT`;
- `FAILED_RATE_LIMIT`;
- `PARTIAL`.

#### D-06 — High — absence does not retire or downgrade candidates safely

Candidates are updated when seen, but a source not reporting a model does not create a source-scoped absence observation or expiry decision. Cross-source consolidation also merges evidence into a winner, making it harder to reason about which source still supports the claim.

**Required fix design**

- Store source observations independently from the canonical candidate.
- Track `first_seen`, `last_seen`, consecutive misses, and source-run ID per observation.
- Apply source-specific absence thresholds before marking an observation withdrawn.
- Derive candidate confidence from all active observations.
- Never delete the canonical audit trail merely because one source stops listing a model.

#### D-07 — High — provider identity resolution has low coverage and insufficient confidence semantics

Thousands of models.dev/Hugging Face/community candidates are provider-unresolved. A candidate's model lab, aggregator, serving provider, and credential owner are separate identities but are frequently collapsed into one provider name.

**Required fix design**

- Model `model_lab`, `canonical_model`, `serving_provider`, `aggregator`, and `credential_domain` separately.
- Store resolution method/confidence and competing mappings.
- Require an exact serving-provider mapping before live verification/promotion.
- Add alias tables with reviewed provenance instead of expanding name heuristics indefinitely.

#### D-08 — Medium/High — discovery lacks recall measurement

The system reports how many models it found but has no known-answer set showing what it missed. A parser can silently lose half its models and still report healthy if it returns a nonzero count.

**Required fix design**

- Maintain per-source sentinel models/records expected to be present when applicable.
- Maintain golden fixtures and expected normalized outputs.
- Compare source results against historical baselines using bounded change rules.
- Perform scheduled human sampling of false positives and false negatives.

### 12.4 Required evidence model

Replace “candidate row plus mutable evidence JSON” with explicit claims.

#### Source

```text
source_id
name
owner/provider
authority_class
transport (json_api, openai_models, html, markdown, dataset, manual)
parser_name + parser_version
refresh_policy
credential_requirement
terms/robots/legal notes
enabled
expected_min/max_count
sentinel definitions
```

#### Source run

```text
source_run_id
source_id
job_id
started_at / finished_at
status + structured error code
http status
etag / last_modified / content_hash
parser_version
records_received / accepted / rejected
new / changed / missing counts
warning list
retry_after / next_due_at
```

#### Observation

```text
observation_id
source_run_id
source_id
source_native_id
raw model/provider identifiers
normalized model/provider identifiers
claim_type
claim_value
authority
evidence excerpt/pointer/hash
observed_at
valid_from / expires_at
last_seen_at
withdrawn_at
normalization_version
```

#### Free-access claim

```text
free_access_type
scope (account, provider, model, model_variant, region)
input/output price
currency and unit
quota amount + window
credit amount + recurrence
trial expiration
card/payment requirement
region/account restrictions
data-use restrictions
commercial-use restrictions
authoritative source
last_confirmed_at
expires/recheck_at
confidence
```

#### Functional verification

```text
serving_provider
credential_version_id
endpoint
model_id
request capability (chat, tools, vision, embeddings, etc.)
result category
http status
non-empty semantic validation
latency
provider request ID
rate-limit headers
checked_at
valid_until
```

### 12.5 Correct source authority and promotion rules

Use a rule matrix rather than one source tier:

| Evidence | Proves existence | Proves provider mapping | Proves free entitlement | Proves callable now | May auto-promote |
|---|---:|---:|---:|---:|---:|
| Official provider model API | Yes | Yes | Usually no | No | No |
| Official provider pricing/quota API/doc | Sometimes | Yes | Yes, within stated scope | No | No |
| Official explicit free variant catalog | Yes | Yes | Yes | No | Only after live check |
| models.dev | Yes | Sometimes | No | No | No |
| LiteLLM cost map | Yes | Sometimes | No | No | No |
| Hugging Face provider graph | Yes | Yes-ish | No | No | No |
| Community list | Lead only | Lead only | No | No | Never by itself |
| Successful direct completion | Yes | Yes for tested route | Shows usable entitlement at that moment, not pricing durability | Yes | Only with authoritative free evidence |
| Successful LiteLLM smoke | Yes | Yes | No additional price proof | Yes through router | Operational continuation only |

Auto-promotion should require all of:

1. resolved serving provider and exact model ID;
2. supported chat/target capability;
3. current valid credential or explicitly credential-free provider;
4. authoritative free-access claim that is not expired;
5. successful direct functional verification within its validity window;
6. no policy restriction (region, trial expiry, flap/cooldown, source candidate-only);
7. lane eligibility and capacity;
8. idempotent desired-state operation.

### 12.6 Free-access taxonomy

The current enum should be expanded and precisely defined:

- `PERMANENT_PRICE_ZERO`: provider explicitly prices the model at zero, no known expiration.
- `RECURRING_RATE_LIMITED`: free request/token quota renews on a documented window.
- `RECURRING_CREDIT`: monetary credit renews on a documented window.
- `TRIAL_CREDIT`: one-time monetary credit; requires activation/expiry.
- `TRIAL_QUOTA`: one-time token/request allocation; requires activation/expiry.
- `PROMOTIONAL`: temporary campaign with explicit or unknown end.
- `ACCOUNT_ENTITLEMENT`: free access depends on account plan, region, or signup state.
- `OPEN_WEIGHT_SELF_HOSTED`: weights are available, but hosted inference is not claimed free.
- `AGGREGATOR_FREE_VARIANT`: free only through a named aggregator/variant.
- `UNKNOWN`: no authoritative free entitlement.
- `PAID`: authoritative paid-only evidence.

Never translate “open weights,” “zero cost in an aggregator,” “free signup credit,” and “permanent hosted free API” into the same label.

### 12.7 Source-specific recommendations

#### OpenRouter

- Treat `:free` and provider-returned zero pricing as authoritative only for the OpenRouter route/variant.
- Store pricing object, supported parameters, moderation/data policy, context, and provider routing restrictions.
- Confirm with a live API call using the OpenRouter credential.
- Recheck at least every six hours and react quickly to variant disappearance.
- Do not infer that the underlying direct provider is free.

#### models.dev

- Use for canonical IDs, capabilities, model labs, context, modalities, tools, and discovery leads.
- Never set verified-free directly from cost zero.
- Store canonical/provider relation separately.
- Cross-check serving-provider pricing and run a live provider test.
- Alert on schema or provider-count drift.

#### LiteLLM model cost map

- Use for LiteLLM compatibility and normalized metadata.
- Treat zero price as a lead, not entitlement proof.
- Version by upstream commit/content hash.
- Validate schema and reject malformed/semantically incomplete entries.

#### Official provider model APIs

- Use for exact current model IDs and availability.
- A `/models` listing generally proves presence, not free access.
- Pair with official pricing/quota evidence and direct functional checks.
- Distinguish credential missing from empty catalog.

#### Official pricing/rate-limit pages

- Replace shared regex extraction with provider-specific parsers.
- Persist quota window, region, account class, trial/recurrence, and expiry.
- Add DOM/fixture contract tests and sentinel entries.
- Require manual approval when parser structure changes materially.

#### Hugging Face

- Keep disabled by default unless used as model/provider topology discovery.
- Do not feed its full presence-only catalog into the free verification queue.
- Filter to explicitly free provider records if the upstream contract supplies that field and validate its meaning.

#### Community lists

- Use only to create leads/source suggestions.
- Require authoritative corroboration before changing free state.
- Measure source precision and automatically demote/disable persistently noisy sources.
- Never auto-promote from community evidence alone.

#### Vercel AI Gateway and account-credit providers

- Represent account-level recurring credit, not model-level zero price.
- Store credit recurrence, exhaustion state if observable, and account dependency.
- Avoid marking every listed model as independently free.

#### Cloudflare Workers AI

- Model the account-wide Neurons allocation and account-scoped URL.
- A model catalog entry is not a per-model free entitlement.
- Validate account ID/credential and actual inference separately.

### 12.8 Manual source onboarding procedure

Every new free-model source should follow this reviewed process.

#### Step 1 — Source proposal

Create a source proposal containing:

- owner and official URL;
- authority class and why it is trustworthy;
- exact claims it can and cannot prove;
- auth method and least-privilege credential;
- expected update frequency;
- licensing/terms/robots constraints;
- sample payload/page;
- expected count range and sentinel entries;
- failure and deprecation behavior.

#### Step 2 — Capture fixtures

- Save sanitized representative responses for success, empty, auth failure, rate limit, schema change, malformed content, and pagination.
- Record headers relevant to caching and rate limits.
- Hash fixtures and associate them with adapter/parser versions.

#### Step 3 — Implement adapter contract

The adapter must implement:

```text
validate_config
check_auth
fetch_page(cursor)
parse/validate
normalize
emit_claims
classify_errors
freshness_policy
health/sentinel_check
```

It must never write canonical candidates directly. It emits observations to a staging boundary.

#### Step 4 — Contract/golden tests

- Assert exact normalized results for fixtures.
- Assert that paid/presence-only records are not marked free.
- Assert that candidate-only evidence cannot satisfy promotion.
- Assert pagination, retry, redirect, timeout, and rate-limit behavior.
- Assert no secret appears in errors or stored raw evidence.

#### Step 5 — Shadow mode

Run the new source without affecting candidate eligibility for at least several scheduled cycles.

Measure:

- availability and latency;
- item/count stability;
- provider-resolution rate;
- overlap with trusted sources;
- false-positive sample;
- new useful leads;
- parser warnings and schema drift.

#### Step 6 — Human sample review

Review a statistically useful sample, including:

- random results;
- every result marked free;
- every unresolved provider;
- every novel model/provider;
- every result that would become promotable.

Record reviewer, decision, and reason.

#### Step 7 — Limited activation

- Enable as lead-only first.
- Allow authoritative claim contribution only after accuracy targets are met.
- Allow auto-promotion contribution only if the source type is authorized and all independent gates pass.

#### Step 8 — Ongoing certification

Re-certify on:

- parser/schema version change;
- major count deviation;
- upstream ownership/terms change;
- repeated false positives;
- prolonged outage;
- scheduled quarterly review.

### 12.9 Manual candidate verification procedure

For a candidate that may be free:

1. Identify canonical model, model lab, serving provider, aggregator, and exact provider model ID.
2. Open the authoritative provider pricing/free-tier source.
3. Record free-access type, quota/window, region, account/card requirements, expiration, and restrictions.
4. Confirm the model is listed by the serving provider now.
5. Verify the credential against the provider's auth/model endpoint.
6. Send the smallest safe functional request to the exact target capability.
7. Validate HTTP success and semantic non-empty output; record provider request ID.
8. Capture rate-limit/quota headers without storing sensitive response content.
9. Repeat enough times to distinguish transient success from stable access, respecting provider policy.
10. Promote only when the authoritative entitlement and live functional evidence are both fresh.
11. Verify through the exact LiteLLM deployment ID.
12. Confirm lane assignment/fallback state and record the full decision trail.

The UI should provide a “review dossier” showing all these facts and let a reviewer approve/reject with a reason. Manual approval should not bypass missing identity, unsupported capability, or absent credential safety checks.

### 12.10 Automated discovery pipeline design

Recommended pipeline:

```text
Scheduler
  -> source-run jobs (one independently retryable job per source)
  -> fetch through controlled egress
  -> content-addressed raw snapshot
  -> schema/parser validation
  -> normalized observation staging
  -> quality gates and anomaly checks
  -> transactional publish of observations
  -> identity resolution
  -> claim/corroboration engine
  -> due verification jobs grouped by provider
  -> eligibility decision
  -> desired deployment/lane state
  -> reconciliation with LiteLLM
  -> exact deployment health monitoring
```

Important properties:

- one failing source never blocks successful sources;
- retries do not duplicate observations;
- publishing a source run is atomic;
- each source has its own concurrency/rate-limit policy;
- every stage is replayable from stored observations/snapshots;
- parser code changes can be backtested against historical fixtures;
- canonical state is derived rather than destructively overwritten.

### 12.11 Discovery scalability and optimization plan

#### Database

- Bulk-load staged observations using `COPY` or batched inserts.
- Upsert on source-native identity and observation version.
- Resolve known provider/model aliases in set-based SQL.
- Add indexes on source ID, source-native ID, canonical identity, last seen, claim type, validity, next verification, and provider.
- Partition high-volume observation/check tables by month or source where justified.
- Retain aggregates separately from raw history.

#### Worker

- Queue one source run per job.
- Stream/paginate large APIs.
- Bound memory and payload size.
- Use adaptive provider concurrency and token buckets.
- Honor Retry-After and upstream cache validators.
- Checkpoint pages/cursors.

#### API/UI

- Paginate candidates and observations.
- Provide source-run drill-down rather than embedding all evidence in list pages.
- Precompute source quality/yield summaries.
- Expose stable filterable APIs for MCP and UI clients.

#### Capacity planning

Load-test at minimum:

- 100 sources;
- 1 million observations;
- 100,000 canonical candidates;
- 10,000 active deployments;
- 10 million verification/smoke records;
- concurrent discovery, verification, and inventory reconciliation.

### 12.12 Source reliability SLOs

Define per-source SLOs by class.

Suggested starting objectives:

- machine-readable official APIs: 99% successful scheduled fetches over 30 days;
- official HTML/docs: 97% successful parses over 30 days;
- community sources: best effort, never promotion-authoritative;
- schedule start lag: under 2 minutes;
- freshness: completed within refresh interval + 10 minutes;
- parser/schema drift detection: under one scheduled interval;
- source-run completeness: 100% of enabled due sources receive a terminal run status;
- provenance completeness: 100% of candidates have source run, URL, observed time, parser version, and claim authority;
- promotion evidence: 100% of auto-promoted candidates have fresh authoritative free claim plus fresh functional check;
- stale evidence: 0 candidates remain auto-promotable after evidence expiry;
- secret leakage: 0 occurrences.

### 12.13 Quality metrics that should replace raw discovery count

Per source, measure:

- fetch success and p50/p95 duration;
- freshness/schedule lag;
- raw, accepted, rejected, new, changed, missing counts;
- schema/parser warning rate;
- provider-resolution rate;
- canonical-identity resolution rate;
- authoritative-free-claim rate;
- direct verification pass/rate-limit/auth/failure rates;
- promotion eligibility and success rate;
- 7/30-day post-promotion survival rate;
- false-positive rate from human review;
- unique useful candidates not supplied by stronger sources;
- corroboration overlap;
- cost/request volume imposed on providers.

A source producing thousands of unresolved candidates and no successful verifications should rank below a small source producing ten precise, callable free models.

### 12.14 Monitoring and alerting requirements

Alerts should exist for:

- enabled source overdue beyond freshness SLO;
- repeated fetch/auth/schema/parser failure;
- zero-result anomaly against historical baseline;
- count increase/decrease outside source-specific bounds;
- sentinel model missing;
- provider-resolution rate collapse;
- verified-free count jump without new authoritative evidence;
- evidence expired for active/promotable deployments;
- direct verification disagreement with source claim;
- promoted model becomes paid/removed;
- source URL/host/redirect target changes;
- community source influencing eligibility;
- queue backlog or job retry storm.

### 12.15 Discovery test strategy

#### Unit tests

- schema validation and normalization;
- free-type classification;
- identity mapping;
- authority/promotion gates;
- parser functions;
- error classification;
- expiry and corroboration rules.

#### Adapter contract tests

Run the same suite against every adapter:

- success, empty, malformed, pagination, duplicate, redirect, timeout, 401/403, 404, 429, 5xx;
- secrets never persisted/logged;
- source-native identity stable;
- claims contain required provenance;
- no unsupported free inference.

#### Golden/fixture tests

- provider-specific HTML/JSON fixtures under version control or controlled artifact storage;
- expected exact normalized observations;
- deliberate upstream schema variants;
- before/after fixtures for parser migrations.

#### PostgreSQL integration tests

- atomic source-run publish;
- idempotent replay;
- source absence/withdrawal;
- cross-source corroboration;
- concurrent runs;
- migration/backfill of historical candidates;
- large batch performance.

#### End-to-end tests

- source -> observation -> candidate -> authoritative free claim -> direct check -> promotion -> LiteLLM check;
- community-only lead remains ineligible;
- models.dev zero-cost entry remains unverified until provider proof;
- stale/expired evidence blocks promotion;
- source failure produces partial run and alert;
- worker crash/retry does not duplicate candidates.

#### Production canaries

- controlled known-free fixture/provider if available;
- known-paid negative canary that must never be classified free;
- known non-chat model that must never enter chat lanes;
- sentinel entries for major sources;
- read-only synthetic run before deploying parser changes.

### 12.16 Source incident runbook

When a source degrades:

1. automatically stop that source from contributing new authoritative claims;
2. retain last-known observations but mark freshness/confidence decay;
3. do not immediately delete active models solely due to a source outage;
4. compare HTTP status, content hash, schema warnings, count anomaly, and sentinel results;
5. replay the stored payload against current and previous parser versions;
6. determine network/auth/rate-limit/schema/content/terms cause;
7. patch parser behind shadow mode and golden tests;
8. require review before re-enabling authoritative influence after material drift;
9. record incident timeline and affected candidates;
10. re-evaluate affected eligibility once recovered.

### 12.17 Discovery implementation backlog

Order of implementation:

1. Enforce `candidateOnly`/source authority in the domain promotion gate.
2. Reclassify models.dev zero-price candidates from verified to unconfirmed claims.
3. Introduce structured source-run statuses and per-source immutable runs.
4. Split observations/claims from canonical candidate state.
5. Add explicit evidence expiry and stale gating.
6. Add provider-specific parsers and fixtures for authoritative HTML sources.
7. Add source sentinels, count baselines, and drift alerts.
8. Implement real DB-defined source adapters or remove unsupported custom-source UI.
9. Replace row-by-row ingestion with staging/bulk upserts.
10. Add indexed due-verification state and durable per-provider jobs.
11. Add source quality/yield dashboards and human review workflow.
12. Add continuous production canaries and quarterly source certification.

### 12.18 Discovery completion criteria

The Free Model Source subsystem should not be declared production-ready until:

- every enabled source has a versioned adapter, fixtures, owner, authority definition, freshness policy, and runbook;
- community/aggregator evidence cannot independently produce verified-free or auto-promotion state;
- every verified-free candidate has current authoritative entitlement evidence;
- every promoted candidate additionally has a fresh functional provider check;
- all source runs have independent durable status and provenance;
- parser/source drift is detected and alerted within one refresh interval;
- ingestion is idempotent, replayable, atomic, and performance-tested;
- stale/withdrawn claims automatically remove promotion eligibility;
- the full lifecycle passes integration, failure-injection, and worker-restart tests;
- source quality dashboards make false positives, resolution gaps, freshness, and downstream survival visible.

## 13. Deep assessment: Database consistency, flags/tags, and scalability

### 13.1 Database verdict

The schema has a sound relational core—UUID primary keys, foreign keys, uniqueness constraints, timestamps, and several useful indexes—but PostgreSQL is not yet enforcing many of the business invariants on which automation depends.

The current design has three competing state systems:

1. typed relational columns such as deployment lifecycle and health;
2. mutable JSON fields such as candidate evidence, deployment metadata, lane explanation, and run summary;
3. flags/statuses derived at read time in server or UI code.

That division makes the UI look intelligent while leaving the database unable to guarantee that two services, workers, or future MCP clients reach the same decision.

The database should become the durable source of **facts and workflow state**, while policy services derive decisions from those facts. The UI should render persisted/contracted decisions rather than inventing status categories independently.

### 13.2 Live database integrity findings

The read-only server audit found:

- 19 primary keys, 13 foreign keys, 6 unique constraints/indexes, and **zero application `CHECK` constraints**;
- 23 deployments with `lifecycle=REMOVED` but a non-null LiteLLM deployment ID;
- 114 candidates with `last_seen_at < first_seen_at`;
- 2 smoke-test rows with HTTP status outside 100–599;
- 2,874 candidates with workflow state such as last status, next check, consecutive availability, and required action stored inside JSON evidence;
- 0 rows in `model_capabilities`, even though capability flags are used throughout discovery/lane logic;
- both Drizzle migration history and an `alembic_version` table, indicating unclear migration ownership/history;
- high sequential-scan counts on very small reference tables, which is not currently expensive but illustrates frequent polling/read amplification;
- `candidate_checks`, `sync_runs`, `model_candidates`, and `smoke_tests` are already the largest relations and will dominate future storage/retention needs.

Current approximate relation sizes were modest (under 10 MB each), so there is time to correct the model before scale makes migration difficult.

### 13.3 Core schema design principles

The redesign should follow these rules:

1. **One authoritative representation per fact.** Do not store the same lifecycle in a column and JSON metadata.
2. **Typed columns for anything filtered, sorted, joined, constrained, scheduled, or displayed as current state.**
3. **JSON only for opaque upstream payloads, versioned evidence, and non-queryable diagnostics.**
4. **Immutable events/observations; mutable projections.** History should be append-only, while current-state tables are derived/updated transactionally.
5. **State transitions are explicit.** Use transition services and database guards, not arbitrary updates.
6. **Tags are not state.** Tags describe; flags identify actionable findings; lifecycle/status drives workflow.
7. **Desired state and observed state are separate.** Especially for LiteLLM deployments and lane membership.
8. **Every external identity has a source/system namespace.** Avoid ambiguous string IDs.
9. **Every automated decision has evidence, policy version, and timestamp.**
10. **One migration owner.** Drizzle or Alembic, never both for the same schema.

### 13.4 Flags, tags, labels, capabilities, and statuses must be distinct

These concepts should not share one generic JSON or string field.

#### Status

A mutually exclusive current workflow/health state with legal transitions.

Examples:

- deployment lifecycle: active, deactivated, removed;
- job state: queued, running, succeeded, partial, deferred, failed, cancelled;
- credential state: unverified, valid, invalid, disabled, rotated.

Status must be a typed column or foreign key and should have transition validation.

#### Flag/finding

An actionable condition that can coexist with other findings and has its own lifecycle.

Examples:

- credential invalid;
- discovery evidence stale;
- provider unresolved;
- parser drift detected;
- lane below redundancy;
- deployment flapping;
- free entitlement expired;
- LiteLLM inventory drift.

Flags should be durable rows, not UI `if` expressions.

#### Tag

A controlled descriptive classification used for search/policy grouping.

Examples:

- `open-weight`;
- `reasoning`;
- `vision`;
- `community-lead`;
- `trial-only`;
- `self-hosted`;
- `safety-model`.

Tags do not directly trigger workflow transitions unless a versioned policy explicitly references them.

#### User label

Free-form operator metadata such as `team-a`, `do-not-use`, `experimental`, or `preferred`. User labels must be namespaced and audited.

#### Capability assertion

A claim that a model/deployment supports something, with evidence and confidence.

Examples:

- chat completion;
- tools/function calling;
- vision input;
- JSON/structured output;
- streaming;
- embeddings;
- speech.

Capabilities are not generic tags because they require provenance, tested/declared distinction, confidence, and expiry.

### 13.5 Centralized flag/finding schema

Introduce a durable finding model similar to:

```sql
create table finding_definitions (
  code text primary key,
  title text not null,
  description text not null,
  default_severity text not null,
  category text not null,
  entity_types text[] not null,
  remediation text,
  check (code ~ '^[A-Z][A-Z0-9_]+$'),
  check (default_severity in ('INFO','WARNING','ERROR','CRITICAL'))
);

create table entity_findings (
  id uuid primary key default gen_random_uuid(),
  code text not null references finding_definitions(code),
  entity_type text not null,
  entity_id uuid not null,
  severity text not null,
  status text not null default 'OPEN',
  source text not null,
  policy_version text not null,
  evidence jsonb not null default '{}'::jsonb,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  resolution text,
  check (severity in ('INFO','WARNING','ERROR','CRITICAL')),
  check (status in ('OPEN','ACKNOWLEDGED','SUPPRESSED','RESOLVED')),
  check (last_detected_at >= first_detected_at)
);

create unique index entity_findings_open_uidx
  on entity_findings(entity_type, entity_id, code)
  where status in ('OPEN','ACKNOWLEDGED','SUPPRESSED');
```

In a strict relational model, polymorphic `entity_type/entity_id` cannot have a normal foreign key. There are three acceptable patterns:

1. a common `entities` registry referenced by all domain tables;
2. separate finding tables per entity class;
3. a polymorphic table plus a trigger validating entity existence.

For RatLLM, a common entity registry is likely unnecessary overhead at present. Separate finding tables or a carefully tested polymorphic table are both reasonable. Do not accept orphaned findings silently.

The overview “incidents” should query open findings. The UI should not reconstruct incidents from provider/lane values independently.

### 13.6 Controlled tags and labels

Recommended schema:

```sql
create table tag_definitions (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  slug text not null,
  display_name text not null,
  description text,
  color_token text,
  system_managed boolean not null default false,
  created_at timestamptz not null default now(),
  unique(namespace, slug),
  check (namespace ~ '^[a-z][a-z0-9_-]*$'),
  check (slug ~ '^[a-z0-9][a-z0-9._-]*$')
);

create table entity_tags (
  tag_id uuid not null references tag_definitions(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  assigned_by text not null,
  source text not null,
  confidence numeric(4,3),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key(tag_id, entity_type, entity_id),
  check (confidence is null or confidence between 0 and 1),
  check (expires_at is null or expires_at > created_at)
);
```

Recommended namespaces:

- `capability/*` only if used as a display projection; authoritative capability data remains in assertions;
- `access/*` for free-access classification projections;
- `model-type/*` for chat, guard, embedding, reranker, audio, image;
- `source/*` for official, aggregator, community;
- `operator/*` for user-managed labels;
- `policy/*` for explicit opt-in/opt-out labels.

Never allow arbitrary UI colors or spelling variants to become independent tags. Use a definition registry and aliases/deprecation fields.

### 13.7 Capability model redesign

The current `model_capabilities` table is unused, while candidate booleans and raw metadata carry partial capability state.

Replace it with assertion-based semantics:

```sql
create table capability_definitions (
  code text primary key,
  description text not null,
  value_type text not null default 'BOOLEAN'
);

create table capability_assertions (
  id uuid primary key default gen_random_uuid(),
  canonical_model_id uuid references canonical_models(id) on delete cascade,
  deployment_id uuid references model_deployments(id) on delete cascade,
  capability_code text not null references capability_definitions(code),
  supported boolean not null,
  assertion_type text not null,
  source_observation_id uuid,
  test_result_id uuid,
  confidence numeric(4,3) not null,
  observed_at timestamptz not null,
  valid_until timestamptz,
  policy_version text,
  check ((canonical_model_id is not null)::int + (deployment_id is not null)::int = 1),
  check (assertion_type in ('DECLARED','INFERRED','TESTED','MANUAL')),
  check (confidence between 0 and 1),
  check (valid_until is null or valid_until > observed_at)
);
```

Create a current-capability view/materialized projection that selects the strongest fresh assertion using precedence such as tested > authoritative declared > inferred > community/manual, with explicit conflict reporting.

Lane eligibility must consume this projection, not candidate booleans or name heuristics directly. Heuristics may emit low-confidence assertions and findings requiring review.

### 13.8 Promote JSON-managed workflow state into columns

The following `model_candidates.evidence` values are workflow state and should become typed columns or related rows:

- `testedAt` → `last_checked_at`;
- `lastStatus` → `verification_status`;
- `lastHttpStatus` → latest check projection, not canonical candidate state;
- `lastError` → latest check/error relation;
- `retryAt` / `nextCheckAt` → `next_check_at`;
- `providerSlug` → provider foreign key already exists; remove duplicate;
- `requiredAction` → open finding/action table;
- `everFailed` → derived from checks or a maintained projection;
- `consecutiveAvailable` → projection with transactionally maintained value;
- `removalHistory` → deployment/candidate lifecycle events;
- `corroboratingSources` → observation/source relations.

Benefits:

- indexed scheduling queries;
- database constraints;
- safe concurrent updates;
- no lost JSON keys from read-modify-write races;
- language-independent use by TypeScript, Python, and MCP services.

### 13.9 Split canonical identity, provider offering, and deployment

Current tables partially conflate these layers.

Recommended hierarchy:

```text
model_labs
  -> canonical_models
      -> model_versions/variants (optional but useful)
          -> provider_model_offerings
              -> router_deployments
                  -> lane_memberships
```

#### `provider_model_offerings`

Represents one provider serving one model ID:

```text
id
provider_id
canonical_model_id
provider_model_id
region/account scope
endpoint/profile
availability state
first_seen/last_seen/withdrawn
free-access decision ID
```

#### `router_deployments`

Represents a LiteLLM deployment instance:

```text
id
offering_id
router_instance_id
remote_deployment_id
model_group/alias
ownership
desired lifecycle
observed lifecycle
generation/version
first/last observed
```

This prevents one canonical model from being confused with a specific provider entitlement or router deployment.

### 13.10 Separate desired and observed state

For external systems, one lifecycle column is not enough.

Use:

- `desired_state`: what RatLLM intends (`ACTIVE`, `BLOCKED`, `ABSENT`);
- `observed_state`: what the last LiteLLM inventory reports;
- `reconcile_status`: `IN_SYNC`, `DRIFTED`, `APPLYING`, `FAILED`, `UNKNOWN`;
- `observed_generation` and `desired_generation`;
- `last_reconciled_at` and `last_reconcile_error_code`.

The current 23 removed deployments retaining remote IDs demonstrate why the distinction matters: the DB cannot tell whether the ID is historical, still observed, or pending deletion.

### 13.11 State-transition enforcement

Define legal transitions and enforce them in one domain service plus database checks/triggers where practical.

Example deployment transitions:

```text
PROVISIONING -> ACTIVE | PROVISION_FAILED
ACTIVE -> DEGRADED | DEACTIVATED | REMOVING
DEGRADED -> ACTIVE | DEACTIVATED | REMOVING
DEACTIVATED -> ACTIVE | REMOVING
REMOVING -> REMOVED | REMOVE_FAILED
REMOVED -> PROVISIONING (new generation, preferably new row)
```

Do not allow arbitrary `ACTIVE -> REMOVED` column updates without a lifecycle event and actor/reason.

Use an append-only table:

```sql
create table entity_state_transitions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  from_state text,
  to_state text not null,
  reason_code text not null,
  actor_type text not null,
  actor_id text,
  job_id uuid,
  correlation_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### 13.12 Required database constraints

Add constraints only after auditing/backfilling existing data. Recommended checks include:

#### General timestamps

```sql
check (updated_at >= created_at)
check (finished_at is null or started_at is null or finished_at >= started_at)
check (last_seen_at >= first_seen_at)
```

#### Numeric ranges

```sql
check (context_window is null or context_window > 0)
check (max_output_tokens is null or max_output_tokens > 0)
check (latency_ms is null or latency_ms >= 0)
check (first_token_ms is null or first_token_ms >= 0)
check (http_status is null or http_status between 100 and 599)
check (score is null or score between 0 and 1)
check (confidence_score between 0 and 1)
check (priority between 0 and 100)
check (minimum_healthy >= 0)
check (maximum_deployments >= 0)
check (minimum_healthy <= maximum_deployments)
check (sample_count >= 0)
check (rpm_limit is null or rpm_limit > 0)
check (tpm_limit is null or tpm_limit > 0)
```

#### Lifecycle consistency

Exact rules depend on desired/observed redesign. Under the current model, at minimum:

```sql
check (not managed or managed_by is not null)
check (lifecycle <> 'ACTIVE' or litellm_deployment_id is not null)
```

Do not immediately add `REMOVED -> remote ID null` until historical identity is split into a separate column/table.

#### Credential consistency

```sql
check (environment_variable ~ '^[A-Z][A-Z0-9_]*$')
check (not disabled or valid is distinct from true)
check (last_validated_at is not null or valid is null)
```

Store encryption format/key ID explicitly and constrain supported versions.

#### Source consistency

```sql
check (priority >= 0)
check (discovered_model_count >= 0)
check (url is not null or type = 'MANUAL')
```

### 13.13 Uniqueness and identity improvements

#### Deployment identity

The current composite unique index includes nullable `litellm_deployment_id`; PostgreSQL treats nulls as distinct, allowing duplicate historical-null identities.

Use separate indexes:

```sql
create unique index router_deployment_remote_uidx
  on model_deployments(litellm_deployment_id)
  where litellm_deployment_id is not null;

create unique index active_offering_alias_uidx
  on model_deployments(provider_id, provider_model_id, litellm_model_name)
  where lifecycle in ('ACTIVE','DEACTIVATED');
```

Historical generations should have explicit generation IDs rather than relying on nullable uniqueness.

#### Candidate identity

`(source, model_ref)` is only source-local identity. Add a source foreign key rather than text, and retain a canonical identity resolution table. Do not merge away independent source observations.

#### Source definitions

Add uniqueness on stable adapter/source key. Name and URL are not stable identifiers.

#### Automation/job identity

Use a typed job definition key and non-null idempotency key for external mutations. The current nullable unique idempotency key permits unlimited rows with null.

### 13.14 Index redesign

Indexes should follow actual worker/UI queries.

Recommended candidates:

```sql
-- Due candidate scheduling
create index candidate_due_idx
  on model_candidates(next_check_at, provider_id)
  where verification_enabled and next_check_at is not null;

-- Active deployment health rotation
create index deployment_health_due_idx
  on model_deployments(last_tested_at nulls first)
  where lifecycle='ACTIVE' and litellm_deployment_id is not null;

-- Latest check lookup
create index candidate_checks_latest_idx
  on candidate_checks(candidate_id, created_at desc) include(status, http_status);

-- Run list/filter
create index sync_runs_type_status_created_idx
  on sync_runs(type, status, created_at desc);

-- Open findings
create index entity_findings_open_idx
  on entity_findings(severity, last_detected_at desc)
  where status in ('OPEN','ACKNOWLEDGED');

-- Source observations
create index observations_current_idx
  on source_observations(source_id, last_seen_at desc)
  where withdrawn_at is null;
```

Review correlated subqueries in `getDeployments()` with `EXPLAIN (ANALYZE, BUFFERS)`. For larger scale, maintain deployment health/latency summary projections rather than calculating several correlated aggregates per row.

Do not add indexes speculatively. Capture `pg_stat_statements`, slow-query logs, and representative load tests, then verify benefit and write cost.

### 13.15 Time-series/history retention and partitioning

Likely high-growth tables:

- candidate checks;
- smoke tests;
- source observations/source runs;
- sync/job runs;
- audit/state transition events;
- lane snapshots.

Recommended policy:

1. retain high-resolution operational checks for 30–90 days;
2. roll up daily/weekly availability and latency aggregates;
3. retain decision/audit/state-transition history longer;
4. partition large append-only tables monthly by `created_at` once volume justifies it;
5. archive or drop partitions rather than issuing huge deletes;
6. preserve evidence required to explain active decisions.

The current maintenance job deletes old runs but not associated high-volume histories consistently. Retention should be declarative per table and tested for referential behavior.

### 13.16 Audit integrity

Current audit rows use free-text actor/action/entity fields and mutable JSON without an authenticated principal model.

Improve with:

- actor foreign key/type, session/API key/job identity;
- action definition registry;
- request/job/correlation IDs;
- before/after schema version;
- append-only database permissions;
- optional hash chaining or external immutable export for high assurance;
- explicit secret-redaction validation.

Application roles should be unable to update/delete audit rows. A retention/archival role may manage partitions under a controlled process.

### 13.17 Settings and policy schema

`system_settings(key, value jsonb)` is flexible but provides no per-setting schema, type, version, scope, or validation at the DB boundary.

Recommended model:

```text
setting_definitions
  key, value_type, schema_version, JSON schema, default, secret flag, description

setting_values
  definition key, scope type/id, value, version, updated_by, timestamps
```

Secrets should never be stored in generic settings JSON. Use credential/secret references.

Policy definitions (auto-add, remove thresholds, lane scoring) should be versioned so every decision records the policy version that produced it.

### 13.18 Database access roles and row security

Create least-privilege roles:

- `ratllm_migrator`: DDL/migrations only;
- `ratllm_api`: read plus authorized user-facing writes;
- `ratllm_worker`: job claims, observations, checks, reconciliation state;
- `ratllm_readonly`: dashboards/reporting;
- `ratllm_auditor`: read audit/security data;
- backup/replication role.

Do not give the web application schema-owner privileges. If multi-user/tenant functionality is planned, introduce tenant/account foreign keys and row-level security before data exists at scale. Do not retrofit tenancy through JSON tags.

### 13.19 Migration ownership and tooling

The live DB contains both Drizzle history and `alembic_version`. Before a Python service is introduced:

1. decide which tool owns schema migrations;
2. inventory whether Alembic represents an old/parallel backend;
3. record a schema baseline and checksum;
4. prevent both services from running DDL at startup;
5. run migrations as an explicit deployment job under the migrator role;
6. require backward-compatible expand/contract migrations for rolling deploys.

It is acceptable for a Python service to use SQLAlchemy against a Drizzle-owned schema, or for both to use generated contracts, but only one migration system may be authoritative.

### 13.20 Zero-downtime schema-hardening procedure

Never add strict constraints directly to dirty live data.

Use this sequence for each change:

1. **Profile:** query invalid/null/duplicate distributions and capture counts.
2. **Expand:** add nullable columns/new tables/indexes concurrently where supported.
3. **Dual write:** update application services to write old and new representations.
4. **Backfill:** batch by primary key with checkpoints and rate limits.
5. **Validate:** compare old/new projections and publish mismatch metrics.
6. **Repair/quarantine:** fix invalid rows or move them to an explicit review state.
7. **Constraint as NOT VALID:** add PostgreSQL constraints without blocking historical validation where supported.
8. **Validate constraint:** validate after clean backfill.
9. **Read switch:** move readers to new schema behind a feature flag.
10. **Stop old writes:** remove dual write after an observation window.
11. **Contract:** remove old JSON keys/columns in a later release.
12. **Rollback drill:** prove the prior application version can operate during the expand phase.

Use `CREATE INDEX CONCURRENTLY` outside a transaction for large live tables. Drizzle migration tooling/process must explicitly support this operational requirement.

### 13.21 Immediate data cleanup required before constraints

Create reviewed repair migrations/jobs for:

- 114 inverted candidate first/last-seen timestamps;
- 2 invalid smoke-test HTTP statuses (likely `0` should become null with a separate network-error code);
- 23 removed deployments retaining remote IDs—first distinguish historical ID from currently observed ID;
- candidate workflow fields currently in evidence JSON;
- source strings to source foreign keys;
- capability booleans/evidence to capability assertions;
- models.dev/community free-verification reclassification;
- any orphan/stale Alembic migration marker after migration ownership is resolved.

Every repair should emit an audit/migration report with before/after counts and should be rehearsed on a restored production snapshot.

### 13.22 Backup, restore, and disaster recovery

Database consistency is not guaranteed without recovery testing.

Required controls:

- automated encrypted PostgreSQL backups;
- point-in-time recovery/WAL retention appropriate to the RPO;
- separate protected backup of active and retired encryption keys;
- scheduled restore drills into an isolated environment;
- logical integrity checks after restore;
- documented RPO/RTO;
- pre-migration backup and rollback plan;
- checksum/count validation for critical tables.

Restoring the DB without the matching credential-encryption key is not a successful restore.

### 13.23 Database observability

Monitor:

- connection pool utilization/waits;
- slow queries and `pg_stat_statements`;
- sequential scans on growing tables;
- index hit ratio and unused indexes;
- dead tuples, vacuum/analyze lag, table/index bloat;
- lock waits/deadlocks;
- transaction duration;
- replication/backup lag;
- table/partition growth;
- constraint violations and backfill progress;
- job claim/heartbeat contention.

Add query-level performance tests for every large page and worker batch.

### 13.24 Proposed schema modules

Organize migrations and ownership by bounded context:

```text
identity/
  model_labs, canonical_models, model_aliases

providers/
  providers, provider_endpoints, credentials, credential_versions

discovery/
  sources, source_runs, source_observations, claims, identity_resolutions

verification/
  verification_jobs/results, capability_assertions

routing/
  provider_offerings, desired_deployments, observed_deployments,
  lanes, desired_lane_memberships, observed_lane_memberships

automation/
  job_definitions, jobs, job_attempts, job_steps, schedules, leases/heartbeats

operations/
  findings, state_transitions, audits, settings/policy_versions

telemetry/
  smoke_tests, latency/availability rollups, rate-limit observations
```

This is logical organization; it does not require separate PostgreSQL schemas immediately. Start with table ownership/contracts and introduce DB schemas only if permissions/team boundaries benefit.

### 13.25 Database testing strategy

#### Schema tests

- every FK action is intentional;
- all check constraints reject invalid boundaries;
- uniqueness works with nulls and lifecycle conditions;
- state-transition functions reject illegal transitions;
- tags/findings cannot orphan;
- secrets cannot enter non-secret JSON columns through service contracts.

#### Migration tests

- clean install from zero;
- upgrade from every supported release/baseline;
- production-like dirty fixture backfill;
- migration idempotency/failure recovery;
- rollback compatibility during expand/contract;
- lock duration and runtime budgets.

#### Concurrency tests

- two workers claim the same due job/candidate;
- simultaneous discovery publication;
- credential rotation during verification;
- promotion and inventory sync overlap;
- lane reconciliation and health removal overlap;
- optimistic version conflict handling.

#### Property/invariant tests

- active deployments always have a current observed identity;
- removed deployments are never health-tested;
- one open finding per entity/code;
- tag assignments are unique;
- last-seen never precedes first-seen;
- derived projections match event history;
- replay produces the same canonical state.

#### Performance tests

- explain-plan assertions for due jobs, candidate lists, deployment summaries, and run history;
- 10x/100x data fixtures;
- backfill/partition maintenance under concurrent reads/writes;
- response and query budgets.

### 13.26 Database remediation phases

#### DB Phase A — Baseline and protect

- declare one migration owner;
- snapshot schema and production distributions;
- add backup/restore drill;
- add DB roles and remove schema-owner privileges from runtime;
- begin `pg_stat_statements`/slow-query monitoring.

#### DB Phase B — Fix truth/invariants

- clean invalid timestamps/statuses/lifecycle identities;
- introduce desired vs observed deployment state;
- add constraints using NOT VALID/validate flow;
- standardize typed status/error codes.

#### DB Phase C — Move workflow state out of JSON

- add candidate verification scheduling columns;
- add immutable source observations/claims;
- add state transitions and policy versions;
- dual write, backfill, compare, switch reads.

#### DB Phase D — Central flags/tags/capabilities

- add finding definitions/entity findings;
- add controlled tags/user labels;
- add capability assertions/current projection;
- replace UI-only incident/status logic.

#### DB Phase E — Scale history

- durable jobs/attempts/steps;
- aggregation/retention policy;
- pagination/materialized summaries;
- partition high-volume histories when thresholds are reached.

### 13.27 Database production-readiness criteria

The DB layer is ready when:

- one migration tool and migrator role own schema evolution;
- all current invalid rows are repaired or explicitly quarantined;
- core numeric/time/lifecycle invariants are database-enforced;
- scheduler fields are typed and indexed, not JSON;
- source observations and claims are immutable and provenance-linked;
- desired and observed external state are distinct;
- UI/MCP/API clients consume the same persisted findings/status contract;
- tags and labels use controlled definitions and audited assignment;
- capabilities have evidence/confidence/expiry;
- concurrent workers cannot duplicate claims or lose updates;
- retention/partitioning and query budgets are tested at projected scale;
- backups plus encryption keys are restored successfully in drills;
- migration and invariant suites run in CI.

## 14. LiteLLM identity, ownership, tags, fallbacks, and the RatLLM projection

### 14.1 Decision: do not copy LiteLLM wholesale

RatLLM should not attempt to mirror every LiteLLM configuration field as a second source of truth. LiteLLM remains the remote execution/router system; Postgres remains the RatLLM control-plane system. RatLLM needs a durable, relational projection of the remote inventory and the relationships required to govern it:

- the LiteLLM instance and the exact remote deployment identity;
- the canonical model/offering and provider identity;
- ownership, managed/unmanaged status, lifecycle, and desired versus observed state;
- controlled tags, capabilities, lane memberships, and evidence/provenance;
- fallback/model-group policy desired by RatLLM and the last state observed in LiteLLM;
- immutable observations, operations, errors, and identity history.

Opaque upstream parameters may be retained as a sanitized, size-bounded snapshot for diagnostics, but they must not become the relational source of truth or be copied blindly into application logic.

### 14.2 Current LiteLLM identity defects

The current implementation is not safe when aliases repeat:

1. `deploymentIdentity()` accepts `model_info.id`, `model_info.model_id`, or a synthetic `model_name:providerModelId` fallback. A synthetic value is not a LiteLLM remote ID and must never be sent to a destructive endpoint.
2. The deployment schema is permissive (`passthrough`) and does not require or validate one authoritative unique ID.
3. The local uniqueness index contains nullable `litellmDeploymentId`; nullable uniqueness allows duplicate historical/active records.
4. Discovery matching uses normalized provider/model names. This is useful for candidate linking, but it can conflate generations, quantizations, or multiple deployments sharing one alias.
5. Promotion registers a model, ignores the returned ID until a later sync, then finds it by alias. A delayed sync, duplicate alias, or concurrent promotion can attach the wrong row.
6. Promotion smoke-tests a lane alias instead of the exact newly-created deployment ID.
7. Manual smoke testing accepts an alias while the monitor uses an ID, producing different behavior for the same deployment.
8. Inventory disappearance marks rows removed/unavailable but retains the remote ID and does not record a durable disappearance event. The live database currently contains 23 `REMOVED` deployments with a non-null LiteLLM ID.
9. Delete/block operations are ID-based in the adapter, but the surrounding selection and reconciliation paths still rely on aliases and fuzzy matching.
10. Fallback configuration is applied to LiteLLM but is not persisted as a first-class desired/observed database object. A restart or partial failure can therefore lose RatLLM’s intent.

These are identity and consistency defects, not merely UI issues. Until corrected, an automatic delete or update can target the wrong deployment when two LiteLLM records have the same model name.

### 14.3 Required LiteLLM projection schema

The exact table names can be chosen during the migration ADR, but the following relations and constraints are required.

#### `litellm_instances`

One row per configured remote LiteLLM control plane:

- `id` (RatLLM UUID), stable instance name, base URL fingerprint (never a secret), environment/tenant;
- last successful inventory sync, remote version, capability flags, API health, and last error;
- created/updated timestamps and an enabled flag.

All remote IDs are scoped by this instance. Never assume an ID is globally unique across LiteLLM installations.

#### `model_deployments` (or a split `litellm_deployments` table)

Retain the existing RatLLM local row, but make these fields authoritative:

- `id`: immutable local deployment UUID used by UI, API, automation, and MCP;
- `litellm_instance_id`: required for every remote-backed row;
- `litellm_remote_id`: the exact ID returned by LiteLLM; required for every observed live deployment;
- `litellm_model_name`: display/router alias, explicitly non-unique;
- `provider_model_id`, canonical model/offering ID, provider ID;
- managed owner, lifecycle, blocked state, desired state, observed state, generation/version;
- first seen, last seen, last tested, and last successful reconciliation;
- sanitized metadata snapshot plus hash/version for diagnostics only.

Enforce `UNIQUE (litellm_instance_id, litellm_remote_id)` for non-null live identities. Aliases must not be unique. A historical row whose remote identity is no longer observed must retain identity history in a separate event/history table rather than relying on a nullable unique column.

#### `litellm_deployment_identity_history`

Append-only identity events record discovered, added, updated, blocked, deleted, disappeared, and reappeared states with instance ID, remote ID, local deployment ID, operation ID, observed-at, and payload hash. This prevents accidental ID reuse or loss of forensic linkage.

#### `deployment_operations`

Every remote mutation gets an idempotent operation row:

- operation ID, idempotency key, local deployment ID, instance ID, remote ID (when known), operation type, expected generation;
- requested/started/completed timestamps, actor/correlation ID, retry count, result/error code, and remote response hash.

The operation is the audit boundary for add, update, block, unblock, and delete. A process restart must resume or reconcile an operation, not repeat it blindly.

#### `tag_definitions` and `entity_tags`

Tags are database relations, not UI-only booleans. Each definition has a stable key, display name, type (system or user), allowed entity type, policy version, and active/retired status. Assignments carry entity ID, source (`system`, `provider`, `operator`, `automation`), evidence/reference, confidence, created/expired timestamps, and actor.

Use first-class relations/columns—not free-form tags—for facts that drive safety or routing: managed ownership, lifecycle, provider, lane membership, free-access classification, and capabilities. Tags can be generated as a shared read projection for UI/API/MCP consumers. Recommended controlled tags include `managed`, `unmanaged`, `free-verified`, `free-claimed`, `free-unknown`, `candidate-only`, `blocked`, `degraded`, `rate-limited`, `deprecated`, and capability tags. A tag must never override the authoritative lifecycle or ownership column.

#### `litellm_model_groups` and fallback policy relations

An alias such as `smart-general` is a model group/router entry, not a deployment. Persist:

- model-group alias and LiteLLM instance;
- ordered fallback edges with target alias/deployment reference, fallback type, rank, weight, and policy version;
- desired and observed configuration, last applied time, last verification, and error;
- whether an edge is operator-approved, automatically generated, or temporarily disabled.

Fallback targets should reference local deployment IDs where possible, while retaining the remote alias required by LiteLLM. Reconciliation must verify that every target exists and that order/type match the desired policy.

### 14.4 Non-negotiable identity and mutation rules

1. Parse and validate the documented LiteLLM unique-ID field. Accept `model_info.id` (or another field only after confirming it is the remote deployment identity). `model_name`, `providerModelId`, and `model_name:providerModelId` are never substitute mutation IDs.
2. If an inventory record has no authoritative remote ID, retain it as an observation/error (`IDENTITY_MISSING`) but do not attach it to an active deployment or perform destructive operations.
3. Every observed record maps by `(litellm_instance_id, litellm_remote_id)`. The same alias may map to many rows.
4. `/model/new` must persist the returned remote ID immediately. If LiteLLM does not return one, leave the operation `PENDING_RECONCILIATION`; correlate a later inventory record using an explicit provider/model/config fingerprint and require operator-safe ambiguity checks. Never guess from alias alone.
5. Delete, block, unblock, and update always use the exact remote ID plus instance. Alias is display/search input only.
6. Health probes, including manual smoke tests, use the exact remote ID. Alias probes may be a separate model-group test and must be labeled as such.
7. Provider/model fuzzy matching is allowed only to link a new candidate to a canonical offering. It is prohibited for destructive actions, ownership changes, or lane assignment of an existing remote deployment.
8. A remote disappearance creates an observation/drift event. It does not silently null identity, overwrite history, or imply that RatLLM should delete the local row. Desired state and reconciliation policy decide the next action.
9. Only managed deployments may be mutated automatically. Unmanaged rows are inventory/read-only unless an explicit ownership transfer operation is audited.
10. All mutations require an idempotency key, expected generation, confirmation policy, and an operation record. Replays must return the original result.

### 14.5 Add and delete workflows

**Add:** create a pending local operation and desired deployment; call LiteLLM; validate and persist the returned remote ID and instance in one local transaction; create the identity-history event; link canonical offering, provider, tags, capabilities, and lane membership by local deployment UUID; run an exact-ID smoke test; then mark observed/healthy only after inventory and health agree. If any step fails, the operation remains recoverable and is reconciled by a worker rather than silently swallowed.

**Delete:** load the local row and verify managed ownership, active generation, and exact instance/remote ID; mark desired lifecycle `REMOVED`; create the operation; call LiteLLM delete by exact ID; reconcile inventory until absence is confirmed; then mark observed lifecycle removed while retaining identity history and audit data. If the remote call fails, keep desired/observed drift visible and retry with bounded backoff. Never delete by model name.

**External removal:** when an ID disappears from inventory, mark `OBSERVED_MISSING` and alert/reconcile. Do not auto-create a replacement under the same alias without a new remote ID and a new identity-history event.

### 14.6 Shared project read model and API/MCP contract

Expose one query/view (for example `deployment_status_view`) containing local ID, instance, exact remote ID, alias, provider, canonical model, owner, lifecycle, health, tags, capabilities, lane memberships, desired/observed drift, and last operation. UI, automation, API, and future MCP tools must consume this projection instead of independently joining aliases or interpreting JSON flags.

Mutation APIs should accept `localDeploymentId`, validate its current remote ID and generation server-side, and return an `operationId`. Clients must not submit an alias to delete/update endpoints. MCP tools should expose safe lookup by alias but require the resolved local/remote identity and confirmation for mutation.

### 14.7 Reconciliation and scaling requirements

- Inventory sync is instance-scoped, paginated if supported, transactionally records a snapshot, and records per-record validation errors.
- Reconciliation compares desired versus observed state and emits drift with reason, first/last seen, retry schedule, and owner.
- Index `(litellm_instance_id, litellm_remote_id)`, active lifecycle/health, provider/canonical model, alias search, operation idempotency key, and snapshot observation time.
- Keep current projection tables small; retain raw/sanitized snapshots and operation history under explicit retention policies.
- Use row locking or optimistic generation checks so two workers cannot mutate one deployment concurrently.
- Alert on missing IDs, duplicate remote IDs, ambiguous alias matches, stale inventory, unverified fallback policy, and desired/observed drift.

### 14.8 Required tests before enabling automation

The integration suite must cover:

- ten deployments sharing one alias, each addressed and deleted by its own remote ID;
- duplicate provider/model IDs across generations and across LiteLLM instances;
- missing, malformed, delayed, or changed remote IDs;
- add response with no ID, delayed inventory visibility, worker restart, and retry;
- external deletion, ID disappearance/reappearance, and ID-history preservation;
- exact-ID health versus alias/model-group health;
- fallback order/type drift and partial fallback application;
- unmanaged mutation rejection, generation conflicts, idempotent replay, and concurrent delete/update;
- migration/backfill invariants for the current 23 removed rows retaining IDs and all other invalid rows.

### 14.9 Tomorrow’s implementation sprint and completion gates

This report is the handoff contract for tomorrow; it cannot guarantee unattended future work, but it removes ambiguity about the order and acceptance criteria:

1. Freeze the LiteLLM identity contract and record the confirmed remote-ID field in an ADR.
2. Add read-only inventory assertions and queries for duplicate aliases, missing IDs, removed rows with IDs, and cross-instance collisions.
3. Design and review the migration for instance identity, exact remote IDs, identity history, operations, tags, model groups, and fallback desired/observed state.
4. Change ingestion, add, delete, block, and health paths to exact-ID behavior with operation/idempotency records.
5. Add the shared deployment status view and replace UI/API/MCP alias-based mutation paths.
6. Backfill and quarantine inconsistent rows; reconcile all remote inventory; verify every active deployment has one instance-scoped remote ID.
7. Add the failure-mode integration suite, run migration/restore drills, and enable automation only after drift and identity alerts are live.

The work is complete only when every active LiteLLM deployment has exactly one instance-scoped remote ID in Postgres, no destructive path accepts an alias, fallback policy is persisted and reconciled, tags/ownership/capabilities are shared relations, and the integration suite proves safe behavior under duplicate aliases, retries, restarts, and remote drift.

## 15. Benchmark page redesign: real per-deployment performance

### 15.1 Finding

The Benchmark page should represent the measured performance of each LiteLLM deployment, not a generic or static benchmark catalog. The repository already records `smoke_tests` with pass/fail, HTTP status, total latency, and first-token latency, and the page computes recent aggregates. However, the current design is still a short rolling summary: it does not provide a durable time-series trend per deployment, distinguish probe types, show sample quality, or make it clear whether a point came from an automated health probe, a manual test, or a lane-level alias test. The current manual smoke route also probes an alias, while the health monitor probes the exact deployment ID. Those observations must not be plotted as if they measured the same thing.

### 15.2 Product definition

Rename the concept internally to **Deployment Performance**. A deployment is the canonical subject; a LiteLLM alias/model group is a separate routing subject. The page should answer:

- Is this exact deployment reachable and successful over time?
- How are p50/p95/p99 total latency and time-to-first-token trending?
- What is the success, timeout, error, and rate-limit rate by period?
- Has performance regressed against its own baseline or its lane/provider peers?
- How much evidence exists, under what probe contract, and when was it last observed?

The UI should show one trend line per metric for a selected deployment, with selectable windows (24 hours, 7 days, 30 days), a comparison baseline, sample count, and explicit gaps. A missing probe is not a zero and must render as a gap.

### 15.3 Performance observation schema

Extend `smoke_tests` or introduce a normalized `deployment_performance_observations` table with:

- local deployment ID, LiteLLM instance ID, exact remote deployment ID, and optional model-group/alias ID;
- probe kind (`HEALTH`, `MANUAL`, `DEEP_BENCHMARK`, `LANE_ALIAS`), benchmark/prompt contract version, and correlation/run/operation IDs;
- started/first-byte/first-token/completed timestamps and derived total, queue, and generation latency;
- request/input/output token counts when LiteLLM supplies them, estimated tokens plus an `estimated` flag otherwise;
- HTTP status, provider error class, success, timeout, rate-limit, empty-response, and cancellation flags;
- response validation result (for example, expected `OK` contract), region/worker, and sanitized metadata;
- created-at, clock/skew quality, and retention class.

Do not overwrite observations with rolling averages. Observations are append-only evidence; aggregates are derived and rebuildable.

Add a time-bucket table or materialized view for hourly/daily summaries keyed by deployment, probe contract, and bucket:

- count, successful count, error/rate-limit/timeout counts;
- p50/p95/p99 total latency and first-token latency;
- throughput/token rates where token data is reliable;
- baseline deltas and confidence/sample sufficiency.

Use indexes on `(deployment_id, observed_at)`, `(remote_instance_id, remote_deployment_id, observed_at)`, and `(probe_kind, observed_at)`. Partition or retain raw observations according to the DB retention policy; keep aggregates longer.

### 15.4 Measurement contract

Every automated point must state its contract: exact remote ID, fixed prompt, max tokens, temperature, streaming mode, timeout, region, and client version. The current `Reply with exactly: OK` probe is appropriate for reachability but is not a quality or throughput benchmark. Add separately scheduled, bounded deep probes for generation performance; never mix their results into the health SLO without labeling them.

Health probes should use the exact LiteLLM remote ID and record the deployment identity from Section 14. Alias/lane tests should resolve to a model-group subject and record the selected deployment ID when LiteLLM exposes it. Manual tests must use the same server-side identity validation as automated tests.

### 15.5 Trend and regression rules

- Baseline each deployment against its own trailing window first; compare providers/lanes only after normalizing probe contract and region.
- Require a minimum sample count before drawing a percentile or declaring a regression.
- Use robust thresholds (for example, p95 increase plus minimum absolute delta and minimum sample count) to avoid alerting on one outlier.
- Separate rate limits, authentication failures, upstream errors, timeouts, and empty responses; they have different remediation paths.
- Mark deployments with stale observations and show “insufficient evidence” instead of implying healthy performance.
- Preserve probe version when changing prompts or client behavior so old and new points are not silently combined.

### 15.6 Page/API design

The benchmark route should query the shared deployment status/performance read model rather than independently counting raw smoke tests. Suggested endpoints:

- `GET /api/deployments/:id/performance?window=7d&probe=health` for points, aggregates, baseline, and evidence quality;
- `GET /api/model-groups/:id/performance` for alias-level routing performance with selected deployment attribution;
- `POST /api/deployments/:id/probes` for an audited manual probe that accepts local deployment ID and expected generation, never a free-form alias;
- `GET /api/performance/compare` for normalized peer comparison.

The page should include deployment identity, provider, exact remote ID (read-only), health/lifecycle, current value, trend, sample count, last observation, and a link to raw evidence. A “benchmark” label may remain in navigation for compatibility, but the content must clearly distinguish health monitoring, deep performance probes, and model-group routing.

### 15.7 Scheduling and cost controls

Keep frequent health probes small and deterministic. Schedule deep benchmarks less frequently, with per-provider concurrency limits, budgets, and opt-in expensive tests. Record skipped probes and the reason (budget, disabled, rate limit) so gaps are explainable. A worker lease and idempotency key must prevent duplicate probes after restarts.

### 15.8 Acceptance tests

Before calling the redesign complete, verify:

- two deployments sharing one LiteLLM alias produce separate exact-ID time series;
- manual, health, deep, and alias probes remain distinguishable;
- a failed/rate-limited probe appears as an error classification, not a zero-latency success;
- percentile calculations exclude invalid samples and declare insufficient evidence below the sample threshold;
- changing the probe contract starts a new series/version;
- delayed, duplicated, retried, and out-of-order observations do not corrupt aggregates;
- a remote deployment removed from LiteLLM stops receiving probes and shows stale/drift state;
- trend values and API responses match direct SQL recomputation over a fixture dataset;
- retention removes raw data only according to policy while preserving daily aggregates and audit links.

### 15.9 Tomorrow’s benchmark work order

After the LiteLLM identity migration, start by adding the observation contract and read-only trend query against existing `smoke_tests`. Then split exact-deployment health from alias tests, add the time-bucket projection, build the per-deployment trend view, and only afterward introduce deep benchmark suites and regression alerts. The exit gate is a chart whose every point can be traced to one local deployment, one instance-scoped LiteLLM ID, one probe contract, and one persisted observation.

## 16. Runs and automation: end-to-end scheduling and reporting

### 16.1 Finding

The Runs page currently behaves primarily as execution history. It does not yet provide an authoritative operational report answering which automations are enabled, what is running now, when each last ran, when it is next due, whether it is overdue, which models were covered, and whether the configured schedule on Settings → Automation is actually the schedule being executed. The automation service, route-triggered execution, leases, and persisted `sync_runs` records need one durable contract. A successful HTTP response or a recent run row alone is not proof that a recurring automation is scheduled, running, complete, and covering the intended inventory.

The requirement is stronger than “the cron endpoint exists”: every enabled automation must be durable, observable, restart-safe, bounded, and provably wired from setting → scheduler → worker → model scope → persisted results → report/alert.

### 16.2 Automation control-plane model

Create a first-class `automation_jobs` relation for the configured job, separate from individual `sync_runs` executions:

- stable job key/type, display name, description, enabled flag, owner, and policy version;
- schedule expression/time zone, next due time, last claimed/started/completed time;
- concurrency policy (`singleton`, bounded parallelism), timeout, retry/backoff policy, and model-scope policy;
- current lease/worker, lease expiry/renewal, heartbeat, last success/failure, consecutive failures, and health status;
- configuration revision and an audit reference to the Settings change that produced it.

Persist `automation_job_runs` (or extend `sync_runs`) with job ID, scheduled-for time, trigger (`scheduler`, `manual`, `retry`, `recovery`), attempt number, lease/worker ID, started/completed times, status, error classification, counts, and coverage summary. A run must not be inferred solely from a free-form run type string.

Persist per-run `automation_steps` and model-level outcomes for fan-out work where practical. At minimum, each run summary must include discovered inventory size, LiteLLM inventory size, eligible scope, attempted, succeeded, failed, skipped, rate-limited, stale, and unprocessed counts, with a link to detailed rows. This makes “ran” distinguishable from “ran against every model.”

### 16.3 Settings-to-scheduler contract

Settings → Automation must read and write the same persisted `automation_jobs` rows used by the worker. It must not maintain a separate UI-only schedule or derive “next run” from browser time. Saving a setting must:

1. validate schedule, time zone, timeout, concurrency, and scope;
2. write a new configuration revision and audit event transactionally;
3. invalidate/recalculate next due time server-side;
4. wake or notify the scheduler so the new schedule takes effect without a process restart;
5. return the persisted revision and next due time displayed by the page.

The scheduler must load settings from Postgres on each claim cycle (or receive a reliable change notification), so edits made through API, migration, or another instance cannot leave stale in-memory schedules. The UI should show “saved revision,” last scheduler acknowledgement, and any validation/error state.

### 16.4 Scheduler and worker guarantees

- Use a durable due-job claim with row locking/`SKIP LOCKED` or an equivalent atomic lease. Multiple web/worker instances must not execute the same singleton job concurrently.
- Leases require periodic renewal and a bounded expiry; the current fixed lease without renewal is unsafe for long discovery, verification, or model fan-out work.
- On worker crash or lease expiry, a recovery pass marks the attempt interrupted and retries according to policy with an idempotency key.
- Separate scheduler claim, orchestration, and model-level work. Do not keep a long-running HTTP request as the only execution path.
- Persist a heartbeat and progress counters. A run with no heartbeat beyond its threshold is `STALLED`, not silently “running.”
- Enforce per-provider and global concurrency limits, request timeouts, circuit breakers, and backpressure. A single slow provider must not starve all jobs.
- Use bounded queues for model work and checkpoint progress so a restart resumes unfinished models instead of restarting an unbounded batch.
- Manual “run now” creates a normal persisted run with trigger metadata and respects the same lease/concurrency rules.

### 16.5 Required automation scope coverage

Each feature needs an explicit scope contract and result accounting:

- **Model discovery:** all enabled, due sources; source-level success/failure; candidates inserted/updated; zero-result and partial-source outcomes.
- **Candidate verification:** due candidates plus connected-provider scope; attempted, verified, failed, skipped, and stale counts.
- **Provider verification:** every enabled provider/credential reference, including missing/invalid credentials and timeout outcomes.
- **LiteLLM inventory sync:** every configured LiteLLM instance; exact-ID validation; added/updated/missing/ambiguous/invalid records.
- **Health monitor/deep benchmark:** every eligible active deployment exactly once per intended cycle, excluding removed/unmanaged rows according to policy; exact remote ID, probe contract, and result for each model.
- **Rate-limit learning:** only observations with adequate evidence; per-deployment sample counts and skipped reasons.
- **Lane reconcile/promotion:** every enabled lane and its desired redundancy; capacity, assignment, fallback, and unresolved drift counts.
- **Fallback/configuration apply:** every desired policy and target; remote acknowledgement and drift result.
- **Maintenance:** cleanup counts, retention failures, stuck leases, and invariant violations.

“Job succeeded” must be false or `PARTIAL` when the scheduler ran but the intended model/source scope was not fully processed. A run that executes zero models because a query returned empty must be visibly classified (`EMPTY_SCOPE`, `NO_ELIGIBLE_MODELS`, or `SCOPE_ERROR`) rather than reported as a healthy success.

### 16.6 Runs page redesign: operational report

Keep the history table, but make the page an operations report with three layers:

1. **Automation overview:** one card/row per configured job showing enabled/disabled, schedule/time zone, next due, last started/completed, current status, duration, last result, consecutive failures, lease/heartbeat age, and coverage percentage.
2. **Live runs:** currently running/stalled/retrying runs with worker, progress (`processed / expected`), current step, estimated remaining work, retry number, and cancel/recover action where authorized.
3. **Run history and detail:** filters by automation, status, trigger, date, provider, source, lane, and model; links to per-step and per-model outcomes; schedule revision and correlation ID.

The page must explicitly distinguish `scheduled`, `due`, `claimed`, `running`, `retrying`, `succeeded`, `partial`, `failed`, `stalled`, `cancelled`, and `skipped`. “Last run” and “next run” must come from persisted server timestamps, not client-side calculations. Display overdue duration and a clear reason when next execution is unknown.

### 16.7 API and observability contract

Add read APIs backed by the same projection used by the page:

- `GET /api/automation/jobs` — configuration, schedule, next due, health, and last run;
- `GET /api/automation/jobs/:id/runs` — paginated attempts and coverage;
- `GET /api/runs/:id` — run, steps, model outcomes, errors, and configuration revision;
- `POST /api/automation/jobs/:id/run` — audited run-now request;
- `POST /api/automation/jobs/:id/enable|disable` — revisioned setting change;
- `POST /api/runs/:id/retry|cancel|recover` — authorized lifecycle actions.

Emit metrics and alerts for due-but-unclaimed jobs, missed schedule, lease expiry, stalled heartbeat, queue depth, duration, retry rate, partial coverage, provider/source failure rate, and model coverage below policy. Include job ID, run ID, configuration revision, worker ID, and correlation ID in structured logs. Never rely on a generic “automation succeeded” log line.

### 16.8 Scaling, resilience, and data safety

- Use a queue or durable work table for model fan-out; do not launch an unbounded `Promise.all` over the complete inventory.
- Partition work by provider/source/model and use fair scheduling so a large provider cannot monopolize workers.
- Make every model-level operation idempotent and safe to replay after a crash.
- Apply retention to high-volume step/model observations while preserving daily summaries and failed-run evidence.
- Protect scheduler and mutation endpoints with the same authentication/authorization model; an absent admin token must not make schedule controls public.
- Test database failover, worker restart, network loss, LiteLLM outage, provider rate limits, and partial source failures without losing the intended next-run state.

### 16.9 Required verification tests

Before declaring automation “100% wired,” test:

- a Settings schedule change is visible in the worker and produces the persisted next due time;
- two workers claim a due singleton job and exactly one executes it;
- a long run renews its lease; a crashed worker is recovered and resumed/retried once;
- manual run-now, scheduled run, and retry share the same idempotency and reporting path;
- every automation records expected versus attempted versus completed model/source scope;
- duplicate, stale, removed, and newly discovered models are classified according to policy;
- LiteLLM outage and individual provider failure yield partial/error coverage rather than false success;
- scheduler restart preserves due jobs, revisions, and next-run calculations;
- Runs page/API values equal direct database queries for fixtures, including time zones and DST boundaries;
- alerting fires for missed, stalled, overdue, repeatedly failed, and under-covered jobs.

### 16.10 Tomorrow’s automation work order and exit gate

1. Inventory every automation type, its scheduler trigger, Settings fields, worker function, model/source scope, and persisted run type; document the mapping in an ADR.
2. Add read-only schedule/coverage queries and compare them with actual recent runs before changing behavior.
3. Introduce `automation_jobs`, revisions, durable leases/heartbeats, and explicit run states.
4. Refactor each job to report expected and completed scope, bounded progress, retries, and partial outcomes.
5. Replace the Runs page with the operational report and make Settings consume the same persisted projection.
6. Add scheduler/worker failure tests, model fan-out tests, and alerting; then enable automation only after all jobs pass coverage checks.

The exit gate is measurable: every enabled automation has one persisted schedule revision, a server-derived next due time, a durable lease and heartbeat while running, a recoverable run record, and an auditable expected-versus-completed scope. Every discovered eligible model and every active LiteLLM deployment is either processed or explicitly classified with a persisted reason; no UI can claim a healthy run when the scheduler, worker, or model coverage was incomplete.

## 17. Executed automation and Runs-page assessment (2026-09-18)

This section records the assessment actually run against the current checkout and local Docker stack, rather than only a desired-state design.

### 17.1 Evidence collected

- `npm run test`: 13 test files and 78 tests passed.
- `npm run typecheck`: passed with no TypeScript errors.
- `npm run lint`: failed with two `react-hooks/set-state-in-effect` errors in `src/components/search-palette.tsx` (lines 26 and 34). This is not an automation failure, but it means CI is not clean.
- `docker compose ... ps -a`: `ratllm-web` is healthy, `ratllm-db` is exited, and `ratllm-worker` is exited with code 143 in the current local stack. The web application is using the configured remote database, which explains why the UI can display persisted schedule rows while the local worker is not executing them.
- Worker logs show it started and repeatedly logged `scheduler tick: 0 due job(s)`, then terminated with `ELIFECYCLE ... exit code 143`. There is no durable worker supervisor visible in this Compose invocation that guarantees it is restarted and stays alive.
- `GET /api/health` reported an app-level healthy response, but this endpoint does not check worker liveness, scheduler freshness, due-job backlog, or database scheduler health. Therefore “healthy” is currently weaker than “automation is running.”
- `GET /api/settings/automation` returned nine enabled jobs with persisted schedules and recent successful timestamps. This proves configuration/history exists; it does not prove the worker is currently alive or that each future due time will be claimed.
- The Runs page (`src/app/runs/page.tsx`) reads only `sync_runs`, paginates historical rows, and displays type/status/start/duration/summary. It does not read `automation_jobs`, show next due time, show current leases, or calculate expected-versus-completed model/source coverage.

### 17.2 Confirmed implementation gaps

1. **Web health does not include the worker.** A healthy web response can coexist with a dead scheduler, as observed.
2. **Worker lifecycle is not a guaranteed service invariant.** The worker is a separate Compose service, but the current deployment evidence shows it exited while the web remained healthy. `restart: unless-stopped` cannot recover a deliberate stop and there is no UI alert or health endpoint exposing the condition.
3. **Worker liveness has no persisted heartbeat.** `automation_jobs.status` and `lastRunAt` are updated around execution, but there is no heartbeat/lease owner/lease expiry exposed in the schedule report. A stale `RUNNING` status is therefore difficult to distinguish from active work.
4. **Lease duration is fixed at ten minutes with no renewal.** A discovery, deep benchmark, or provider verification run can exceed that duration; another worker may then claim the same job while the first is still mutating data.
5. **Due-job selection and execution are not one atomic claim.** `tickScheduler()` selects all due rows, then each `runAutomation()` performs a separate lease claim. This is safe against duplicate execution only by eventual rejection, not a durable queue/claim record, and can repeatedly rescan a large due set.
6. **Run records are inconsistent.** `MODEL_DISCOVERY` and `LANE_RECONCILE` intentionally self-log while other jobs create wrapper rows. The Runs page therefore cannot assume every scheduled execution has one comparable `sync_runs` record.
7. **Failure/partial semantics are too coarse.** The wrapper marks a job `SUCCEEDED` whenever the function resolves; there is no standard `PARTIAL`, `STALLED`, `RETRYING`, `SKIPPED`, or `EMPTY_SCOPE` state and no required expected/attempted/completed coverage contract.
8. **Model coverage is not guaranteed by the scheduler.** `HEALTH_MONITOR` rotates/limits work and `DEEP_BENCHMARK` calls `runHealthMonitor({limit:100})`; neither the scheduler nor Runs page proves that every active LiteLLM deployment was processed in the intended period.
9. **Settings changes are not revisioned or acknowledged.** The PATCH route writes the job row and recalculates `nextRunAt`, but there is no configuration revision, audit link, scheduler acknowledgement, or wake-up mechanism. “Changes take effect when the worker next checks” is an assumption, not an observable guarantee.
10. **Timezone is stored but not applied.** The schedule evaluator computes using the process `Date` and UTC-like cron fields; `automationJobs.timezone` is returned by the API but is not used by `nextCron`. A non-UTC setting can therefore run at the wrong local time.
11. **Manual runs are synchronous HTTP work.** The Settings “Run now” endpoint calls `runAutomation` directly. A long job can exceed request limits, and the UI may report failure even if the server continues or the lease remains active.
12. **The Runs detail page only renders one summary JSON blob.** It has no step/model outcomes, retry/lease data, schedule revision, worker, expected scope, or raw error classification.
13. **No scheduler-specific integration suite exists.** Unit tests cover cron parsing, but there are no tests for worker restart, lease renewal/expiry, two workers, DST/time zones, due backlog, partial model coverage, or remote LiteLLM/provider outages.
14. **Lint is failing.** The current repository cannot be treated as a clean production baseline until the two React effect errors are resolved or explicitly waived with a reviewed rationale.

### 17.3 Recommended implementation

Implement the control plane described in Section 16, in this order:

1. Add a worker heartbeat/lease status table or columns (`worker_id`, `heartbeat_at`, `lease_expires_at`, `last_tick_at`, `last_tick_error`) and include it in `/api/health` and the Runs report. Mark the system degraded when an enabled job is due but no worker heartbeat is fresh.
2. Make worker supervision explicit in deployment: a long-running worker with a real healthcheck, restart policy, alerting, and a startup readiness check for the configured database. Do not infer scheduler health from the web process.
3. Replace the fixed lease with renewable leases and fencing tokens. Every write from a worker must verify its current token/generation so an expired worker cannot commit late results.
4. Introduce `automation_job_revisions`, durable job attempts, steps, and per-model/source outcomes. Standardize all job types on one run lifecycle; retain self-logging details as child steps, not a second incompatible format.
5. Make schedule edits transactional, revisioned, timezone-aware, and auditable. Compute `nextRunAt` with the configured IANA time zone and expose scheduler acknowledgement plus the persisted revision.
6. Move “run now” to an enqueue endpoint that creates a durable manual attempt and returns immediately with a run ID. The worker executes it under the same claim/retry/reporting path as scheduled work.
7. Add explicit scope planners for each automation. At start, persist expected model/source/deployment IDs (or a stable snapshot); at completion, persist attempted/completed/failed/skipped/stale IDs and classify every omission.
8. Redesign `/runs` as the operational report: job schedule/status/next due, live attempts, lease/heartbeat, progress, coverage, recent history, and detailed step/model outcomes. Keep historical filtering as a secondary view.
9. Add alerts for worker dead, due-but-unclaimed, overdue, stalled, repeated failure, partial coverage, and schedule drift. Include job/run/revision/worker/correlation IDs in logs and alerts.
10. Add integration tests with a real Postgres fixture and fake clock for concurrent workers, lease renewal, crash recovery, time zones/DST, retries, partial provider failure, 100+ model fan-out, and scheduler restart. Fix the two lint failures before calling the repository green.

### 17.4 Immediate operational conclusion

The current system has persisted schedules and evidence of recent successful automation, but the executed assessment cannot certify continuous automation: the local worker is presently stopped, the health endpoint does not detect that, and the Runs page does not expose the missing liveness/coverage information. The recommended solution is therefore not a visual-only Runs-page change. It is a worker/scheduler control-plane change with durable attempts, renewable leases, timezone-correct revisions, explicit model coverage, and a reporting surface backed by those same records.

## 18. Quarantine and master orchestration of every LiteLLM model

### 18.1 Executed assessment and current behavior

The repository already contains a partial quarantine-like mechanism, but it is not yet the requested control plane:

- `AUTO_REMOVE_AFTER_FAILURES` is five.
- `computeFailureStreak()` counts consecutive failed smoke tests and ignores 429 rows. A 429 is skipped, but it does not reset or create a separate rate-limit cooldown.
- `isAutoRemoveEligible()` allows automatic removal only when `managed=true`, the deployment is active/live, and the provider is not local/self-hosted. This correctly protects MLX/Lemonade/local deployments from auto-removal, but it excludes unmanaged free models that the user added directly to LiteLLM.
- On the fifth failure, the monitor calls LiteLLM delete, nulls `litellmDeploymentId`, marks the row `REMOVED`, excludes lane assignments, sets the canonical model lifecycle to `QUARANTINED`, and writes removal history into candidate JSON/audit events.
- There is no first-class quarantine table, start/end/cooldown policy, probe schedule, reason classification, recovery attempt, or quarantine state transition history.
- LiteLLM sync changes a quarantined canonical model back to `ACTIVE` whenever a live matching deployment appears. That can erase quarantine state merely because a deployment was re-added, without requiring a successful recovery probe.
- Health monitoring selects every live deployment with a non-null LiteLLM ID and enabled provider, including unmanaged/manual deployments and local deployments. Local models are protected from auto-delete, but they are not excluded from potentially unnecessary automation probes.
- The manual smoke API validates a local deployment ID but then calls LiteLLM using the alias, not the exact remote deployment ID. Results can be attributed to the wrong member when aliases repeat.
- Deployment-action confirmation asks the user to type the alias. The server uses the stored remote ID for the delete/block call, but the UI does not show or confirm the exact remote identity, instance, or generation.
- The model detail page shows basic deployment/rate-limit information and a short capability placeholder. It does not show exact LiteLLM ID, RatLLM ID, discovery/first-seen date, failure streak/start, quarantine history, recovery schedule, source evidence, or a true per-deployment trend chart.

The current implementation can auto-remove some RatLLM-managed non-local deployments, but it cannot reliably quarantine and recover every free model in LiteLLM, especially unmanaged models added outside RatLLM.

### 18.2 Correct policy boundary

RatLLM can become the master orchestrator of the complete LiteLLM inventory without claiming ownership of every remote mutation. Use three independent dimensions:

1. **Execution safety:** local/self-hosted models are never automatically deleted, blocked, or quarantined in LiteLLM. They may still be observed when explicitly enabled, with a separate local-availability policy.
2. **Orchestration visibility:** every remote deployment—including unmanaged/manual free models—is inventoried, assigned a local RatLLM ID, tagged, health-tested according to policy, and shown on its detail page.
3. **Mutation authority:** managed deployments may be automatically added/blocked/deleted under policy. Unmanaged deployments may be quarantined in RatLLM (excluded from lanes and flagged) but must not be remotely deleted or blocked automatically unless the operator explicitly transfers ownership or confirms a one-time action.

This avoids the dangerous interpretation that “master orchestrator” means RatLLM can silently delete user-created or local infrastructure.

### 18.3 Required quarantine state machine

Quarantine belongs to the deployment identity and, separately, may produce a canonical-model warning. Do not encode it only as `canonicalModels.lifecycle` or arbitrary JSON. Define typed states and transitions:

`ACTIVE → SUSPECT → QUARANTINED → RECOVERY_PROBING → RECOVERED` or `QUARANTINED → RETIRED`.

Also support `RATE_LIMIT_COOLDOWN`, `AUTH_BLOCKED`, `REMOTE_MISSING`, and `LOCAL_UNREACHABLE` as reason/status classifications, not interchangeable quarantine states.

Each transition records deployment ID, instance-scoped LiteLLM ID, prior/new state, reason code, failure window, threshold/policy version, actor (`system`/operator), operation ID, timestamps, and evidence links. A successful recovery probe must be required before returning to `ACTIVE`; inventory presence alone is insufficient.

### 18.4 Quarantine schema

Add a first-class `deployment_quarantines` relation:

- local deployment ID, LiteLLM instance ID, exact remote deployment ID, provider and canonical model IDs;
- state, reason code, trigger (`CONSECUTIVE_FAILURES`, `RATE_LIMIT`, `AUTH`, `REMOTE_MISSING`, `OPERATOR`), policy version;
- failure count and qualifying observation IDs, first failure, last failure, quarantine start, next probe, last probe, recovered-at, expiry/cooldown;
- `mutation_authority` (`MANAGED_AUTOMATION`, `UNMANAGED_OBSERVE_ONLY`, `LOCAL_NEVER_MUTATE`);
- whether LiteLLM was blocked/deleted, operation ID/result, lane exclusion status, and operator notes;
- created/updated timestamps and an append-only transition history.

Add `quarantine_probe_attempts` or use the performance observation table from Section 15 with explicit `probe_kind=QUARANTINE_RECOVERY`. Index active quarantines by `next_probe_at`, state, provider, and reason. Enforce at most one active quarantine per local deployment and one instance-scoped remote identity.

### 18.5 Failure and rate-limit policy

Five failures must mean five qualifying failures for the same exact deployment and probe contract—not five alias responses from a different pool member. The recommended default policy is:

- `429` with a valid `Retry-After` or provider rate-limit signal → `RATE_LIMIT_COOLDOWN`; do not increment the hard-failure streak; schedule the next probe at a bounded retry time with exponential backoff and a maximum cooldown. Preserve whether the limit is request-, token-, daily-, or account-scoped when the provider exposes it.
- `401/403` → `AUTH_BLOCKED`; stop noisy probing until credentials are repaired or an operator requests a recheck.
- `404/410/model_not_found` → `REMOTE_MISSING` or `RETIRED`; verify with inventory sync before any mutation.
- timeout, connection failure, 5xx, malformed/empty response → count toward a configurable failure streak, but require a minimum time window and independent observations to avoid one LiteLLM outage quarantining every provider at once.
- local/self-hosted failure → `LOCAL_UNREACHABLE`, never automatic remote delete/block; use a longer retry window and show the local endpoint/host evidence.
- mixed failures and rate limits → retain separate counters; a 429 must not silently make a genuinely broken model look healthy, and a transient rate limit must not accelerate deletion.

Use a circuit-breaker budget at provider and LiteLLM-instance level. If the router itself is unhealthy, pause model-level quarantine decisions and record `SYSTEM_PROBE_UNRELIABLE` instead of quarantining the whole inventory.

### 18.6 Quarantine automation and recovery

The health worker should:

1. Snapshot eligible deployments by exact remote ID and probe policy.
2. Record each observation and update counters transactionally.
3. Transition qualifying deployments to `SUSPECT` before `QUARANTINED`, giving operators an evidence window.
4. For managed non-local deployments, optionally block/remove from LiteLLM through an idempotent operation; never clear identity history.
5. For unmanaged deployments, exclude from RatLLM lanes/routing policy and mark `OBSERVE_ONLY`; do not mutate LiteLLM automatically.
6. Schedule recovery probes independently of normal health probes. Start with a low-frequency single request, then require two or more spaced successes (configurable) before reactivation.
7. On recovery, restore lane eligibility only through the normal reconciliation policy and retain the entire quarantine history.
8. On repeated recovery failure, extend cooldown with a cap and escalate an operator alert; do not hammer a provider indefinitely.

Recovery must be discoverable and resumable after worker restart. A quarantine with a past `next_probe_at` is overdue and must appear on the Runs/automation report.

### 18.7 LiteLLM control actions

All remote actions follow Section 14:

- inventory, health, and recovery probes use the exact instance-scoped LiteLLM deployment ID;
- delete/block/unblock operations require local deployment ID, expected remote ID, generation, authority, reason, confirmation, and idempotency key;
- unmanaged models expose “Quarantine in RatLLM” and “Request remote action,” not silent automatic deletion;
- manual delete can be available for any live model to an authorized operator, but confirmation must display alias, provider model, RatLLM ID, LiteLLM ID, instance, ownership, and current generation;
- after a remote action, sync inventory and verify the observed result before reporting completion;
- a remote disappearance is recorded as drift/`REMOTE_MISSING`, not automatically treated as a successful RatLLM delete.

### 18.8 Model detail page requirements

Every LiteLLM deployment needs a dedicated detail page backed by the shared projection and performance observations. Display:

- RatLLM deployment ID, LiteLLM instance, exact LiteLLM deployment ID, alias, provider model ID, provider, backend/host, and ownership/authority;
- source/discovery provenance, first seen, last seen, last sync, remote metadata snapshot hash, and whether it was manually added;
- lifecycle, health, quarantine state/reason, current and historical failure streaks, first/last failure, rate-limit cooldown and next recovery probe;
- trend charts for success rate, p50/p95/p99 latency, first-token latency, 429s, error classes, and probe freshness by contract;
- lane memberships, fallback references, tags, capabilities, free-access evidence, credential status, and rate-limit profile;
- operation/audit timeline for add, block, delete, sync, quarantine, recovery, and operator actions;
- controls for exact-ID smoke test, quarantine/unquarantine request, manual delete, deactivate/reactivate, and retry recovery, with authorization and confirmation.

The page must clearly label “unmanaged/read-only,” “local—never auto-mutate,” “quarantined in RatLLM,” and “blocked/deleted in LiteLLM” as different states.

### 18.9 Scale and correctness safeguards

- Never quarantine by canonical model or alias alone; quarantine the exact deployment identity and optionally aggregate a model-level warning.
- Do not remove the LiteLLM ID from the current row on auto-removal. Preserve it in identity history and mark desired/observed state separately.
- Use provider and instance circuit breakers to avoid a shared outage creating thousands of false quarantines.
- Bound recovery concurrency and respect provider retry-after/token budgets.
- Make quarantine and recovery idempotent and fenced against concurrent sync, delete, and re-add operations.
- Keep raw smoke observations append-only; derive streaks and trends from evidence with a policy version.
- Alert on quarantine spikes, recovery flapping, overdue recovery probes, identity ambiguity, and unmanaged models repeatedly failing.

### 18.10 Required verification tests

Before enabling this policy, test:

- local MLX/Lemonade deployment fails five times and is never remotely deleted or blocked;
- managed free deployment fails five qualifying exact-ID probes and enters quarantine once;
- unmanaged/manual free deployment enters RatLLM observe-only quarantine but LiteLLM remains unchanged;
- repeated 429s enter rate-limit cooldown without hard-failure quarantine, honor retry-after, and recover after the limit clears;
- mixed 429 plus 5xx behavior maintains separate counters;
- router-wide outage pauses quarantine decisions;
- a quarantined model returns successfully twice and recovers; one success followed by failure remains quarantined;
- remote deletion/re-addition receives a new identity event and does not bypass recovery policy;
- concurrent health, sync, manual delete, and recovery operations cannot target the wrong alias member;
- detail-page trend values, IDs, dates, and quarantine timeline equal direct database evidence;
- restart with overdue quarantines resumes probes exactly once under durable leases.

### 18.11 Tomorrow’s implementation order and exit gate

1. Audit all current deployments into four classes: local/self-hosted, RatLLM-managed, unmanaged/manual, and unknown; verify exact LiteLLM IDs and ownership.
2. Add quarantine/recovery tables, typed reason/state enums, identity history, and migration/backfill without deleting current evidence.
3. Refactor health monitoring to exact-ID observations, separate rate-limit/auth/system-outage policies, and transactional streak updates.
4. Implement observe-only quarantine for unmanaged models and protected local policy; keep automatic LiteLLM mutation limited to managed non-local deployments.
5. Add durable recovery scheduling, fenced operations, and provider/router circuit breakers.
6. Build the full LiteLLM deployment detail page and exact-ID operator actions with audit/confirmation.
7. Add the failure, recovery, outage, duplicate-alias, restart, and scale tests above; then enable automatic quarantine behind a feature flag and staged threshold policy.

The exit gate is explicit: every LiteLLM deployment has a local identity, ownership/authority classification, exact remote ID, evidence-backed health history, and a visible quarantine/recovery state. Local models can never be auto-mutated; unmanaged free models can be safely quarantined in RatLLM without silent remote deletion; managed free models can be removed or blocked only through idempotent exact-ID operations; and recovery is automatic, scheduled, rate-limit-aware, auditable, and proven by integration tests.

## 19. Front-end architecture, performance, and production reliability assessment

### 19.1 Assessment scope and current baseline

The current UI is a functional server-rendered Next.js control plane, but it is not yet optimized as a production operations console. The assessment found:

- Most data-heavy pages (`/`, `/models`, `/litellm`, `/benchmarks`, `/lanes`, `/providers`, `/health`, `/runs`, and detail pages) are forced `dynamic` and execute database queries on every request.
- The LiteLLM and model pages load broad inventories and recent history together. The model page limits display to 300 rows only after fetching and sorting the full candidate set in application memory.
- `getDeployments()` uses several correlated subqueries per deployment for smoke counts, last status, and latency samples. This is workable at current volume but will degrade as observations and deployments grow.
- Pages have a global `loading.tsx`, but no route-specific Suspense boundaries, streaming sections, skeletons, or isolated error boundaries for independent panels.
- Mutations generally call `router.refresh()`, re-running the entire server component tree and all page queries rather than invalidating the smallest affected resource.
- There is no real-time transport. The browser cannot show which deployment is currently under smoke test, worker progress, queue depth, quarantine transitions, or next scheduler heartbeat without a full refresh.
- Buttons for discovery, verification, LiteLLM sync, and smoke tests hold an HTTP request open and then refresh the page. Long-running automation is not represented as a durable client-observable job.
- The search palette debounces a client fetch, but lint currently fails on synchronous state updates in its effects; this is a performance and maintainability signal that client state/effect patterns need cleanup.
- There is no documented browser performance budget, Web Vitals collection, API latency budget, bundle budget, or production front-end error telemetry.

### 19.2 Information architecture redesign

The navigation should reflect operational decisions rather than implementation tables:

1. **Operations overview:** worker/scheduler health, LiteLLM connectivity, active incidents, due/overdue automations, model coverage, quarantine count, and recent changes.
2. **Deployments:** one inventory for every LiteLLM deployment with filters for ownership, local/unmanaged/managed, lifecycle, health, quarantine, provider, lane, and stale observations.
3. **Deployment detail:** identity, provenance, live state, performance trend, smoke/recovery history, quarantine, tags, lane/fallback membership, and audited actions.
4. **Discovery:** source runs, candidate evidence, availability, free-access confidence, and promotion state; do not mix candidates with live deployments.
5. **Automation and Runs:** schedules, next due, live runs, progress, model/source coverage, retries, failures, and historical reports.
6. **Routing:** lanes, assignments, fallback policies, desired/observed drift, and capacity.
7. **Settings and administration:** providers/credentials, sources, policies, access control, and retention.

Use consistent global filters (LiteLLM instance, provider, time window, ownership, status) and persist filter state in URL search parameters. A user must be able to deep-link to the exact filtered operational view.

### 19.3 Server/client rendering and data-fetching strategy

- Keep initial page shells and stable metadata server-rendered for fast first contentful paint and secure DB access.
- Split each page into independently streamed server sections: summary KPIs, live status, inventory table, history/trends, and actions. Wrap each in Suspense with a useful skeleton and independent error boundary.
- Remove blanket `force-dynamic` where a section can use short-lived revalidation. Use explicit cache tags for inventory, deployments, automation jobs, and performance aggregates.
- Use server-side pagination, filtering, and sorting. Never fetch all candidates/deployments and then truncate in React/application memory.
- Replace correlated per-row history/count subqueries with pre-aggregated hourly/daily tables or a materialized current-status view. Return a bounded page plus aggregate metadata.
- Introduce typed query DTOs that contain only fields required by each view. Do not pass raw metadata or large JSON blobs to the browser.
- Use URL-driven query state and server-side query validation so refresh, browser navigation, and shared links preserve filters and pagination.
- Add request cancellation and stale-response protection to client actions. Use idempotency keys and job IDs rather than waiting for long mutations.

### 19.4 Real-time status architecture

The platform needs real-time operational feedback, especially while smoke tests, discovery, quarantine recovery, and automation runs are active. Use a tiered design:

1. **Server-Sent Events (SSE) first:** add an authenticated `/api/events` stream for one-way events from worker/database to browsers. SSE is simpler than WebSockets for status updates, works through common proxies, reconnects natively, and is sufficient for run/model state.
2. **WebSockets only when bidirectional control is justified:** use them later for interactive operator controls or high-frequency multi-user coordination; do not introduce socket infrastructure merely to replace polling.
3. **Event broker/outbox:** workers write transactional outbox events (`run.started`, `run.progress`, `model.smoke.started`, `model.smoke.completed`, `quarantine.entered`, `quarantine.probe_due`, `deployment.changed`). A publisher fans these to SSE subscribers. Never publish only from in-memory process state.
4. **Database notifications as a wake-up, not the event log:** Postgres `LISTEN/NOTIFY` can reduce latency, but payloads are lossy. The durable outbox remains the replay source.

Each event must include event ID, sequence, timestamp, tenant/instance, run ID, local deployment ID, exact remote ID where applicable, event type, payload version, and correlation ID. Clients resume with `Last-Event-ID`; the server replays missed events or instructs the client to refetch a snapshot.

### 19.5 Showing live smoke-test progress

When a worker begins a probe, emit `model.smoke.started` with deployment ID, exact LiteLLM ID, probe kind, run ID, attempt, and started time. Emit progress counters for the parent run (`processed`, `expected`, `passed`, `failed`, `rateLimited`, `remaining`) and `model.smoke.completed` with status, latency, first-token time, error class, and observation ID.

The UI should:

- show a live “currently testing” drawer on the LiteLLM, Runs, and deployment-detail pages;
- highlight the exact model row without reordering the table unexpectedly;
- show a heartbeat/stale indicator if no progress event arrives within the expected interval;
- optimistically show `QUEUED` only after the server returns a durable job/run ID;
- reconcile the event stream with a periodic snapshot to recover from missed events;
- never claim success from a client event until the persisted observation is available.

### 19.6 Efficient tables and large inventories

- Use cursor pagination for deployments, candidates, runs, smoke observations, and audit history. Offset pagination becomes unstable and expensive as rows change.
- Virtualize long tables only after server pagination; virtualization is not a substitute for bounded queries.
- Keep stable row heights where possible and avoid rendering every tooltip/modal in a large table. Render action menus/modal content on demand.
- Debounce search at 200–300ms, cancel stale requests, cache recent query results, and show result counts/empty states.
- Prefer CSS classes over repeated inline style objects in large mapped lists; memoize expensive trend/percentile formatting.
- Use accessible sortable headers and keyboard-operable row actions; do not make color bars the only status signal.
- Preserve selection and scroll position during event-driven updates. Apply row-level patches instead of replacing the entire list.

### 19.7 Client state and mutation reliability

Create a small typed client data layer (for example, TanStack Query or an equivalent internal cache) for browser-owned state:

- query keys for jobs, runs, deployments, detail history, and events;
- stale times and invalidation tags per resource;
- mutation lifecycle (`queued`, `running`, `succeeded`, `failed`, `unknown after disconnect`);
- retry policy only for safe/idempotent reads and operations;
- optimistic updates only for reversible local UI state, never remote LiteLLM deletion;
- toast plus persistent inline result linked to operation/run ID.

Fix effect-driven state resets in `search-palette.tsx` and avoid setting state synchronously inside effects. Prefer derived state, event handlers, `useDeferredValue`, and abortable async work. Treat a browser disconnect as an uncertain operation and reconcile via the server rather than assuming failure.

### 19.8 Reliability UX and failure containment

- Add route-level `error.tsx` boundaries that preserve navigation and show retry/correlation IDs.
- Add panel-level errors so a failed benchmark query does not blank the entire deployment inventory.
- Show data freshness (`updated 12s ago`, `stale`, `worker offline`) beside every operational panel.
- Distinguish unavailable data, empty data, not-yet-tested, rate-limited, unauthorized, and failed states.
- Disable destructive controls based on server authority/state, not only client props; revalidate generation on submit.
- Confirm destructive actions with exact local ID, LiteLLM ID, instance, ownership, and current state.
- Provide accessible live regions for run progress and errors; ensure keyboard navigation, focus return after modal close, reduced-motion support, and adequate contrast.

### 19.9 Performance budgets and observability

Set and enforce budgets in CI and production:

- initial JS and route chunk limits;
- server response p50/p95 and database query p95 by route;
- time to first byte, first contentful paint, largest contentful paint, interaction to next paint, cumulative layout shift, and error rate;
- SSE connection count, reconnect rate, event lag, outbox age, and snapshot fallback rate;
- table query row counts, payload sizes, cache hit ratio, and slow-query samples.

Use source maps/error tracking with redacted deployment/provider data. Correlate browser action ID → API request → run/operation ID → worker logs → database observation. Add a `/api/health` UI indicator that includes data freshness and worker/event-stream health, not just web process health.

### 19.10 Build and delivery improvements

- Add route-level Playwright tests for desktop/mobile layouts, keyboard access, destructive-action confirmation, stale/error states, and live event updates.
- Add Lighthouse/Web Vitals CI on representative dashboard, inventory, detail, and Runs pages.
- Add load fixtures for 100, 1,000, and 10,000 deployments/observations; assert bounded query time and browser render time.
- Test SSE reconnect, missed-event replay, worker restart, long-running smoke tests, and simultaneous updates to the same row.
- Use production-like build assets and compression; verify cache headers and no secret leakage in RSC payloads or browser logs.
- Standardize design tokens, status semantics, empty states, loading skeletons, and table controls into reusable components to reduce UI drift.

### 19.11 Recommended implementation order

1. Establish route/query performance telemetry and fix the current lint errors.
2. Redesign DTOs and server queries for pagination, bounded history, and current-status projections.
3. Add route/panel loading and error boundaries and make health/freshness visible.
4. Build the deployment detail page and operational Runs page around durable IDs and run records.
5. Add the transactional outbox and SSE stream with replay/snapshot fallback.
6. Add live model smoke progress and row-level cache updates.
7. Introduce client query caching/mutation state and remove broad `router.refresh()` calls.
8. Add accessibility, responsive, browser reliability, load, and Web Vitals tests.
9. Tune caching, indexes, aggregate tables, and virtualization from measured traces rather than guesses.

### 19.12 Front-end production exit criteria

The front end is production-ready when initial and subsequent payloads are bounded, every large list is server-paginated, independent panels stream/fail independently, mutations return durable operation IDs, the UI reflects worker/model state within a defined event-lag SLO, missed events recover through replay or snapshot refetch, exact model identity is visible before destructive actions, and CI continuously enforces accessibility, performance, load, and end-to-end reliability budgets.

## 20. UI design system, visual consistency, and brand polish

### 20.1 Assessment

The current visual language is already restrained and readable, but it is mostly a single large stylesheet plus repeated inline styles and ad-hoc text decisions. There is no written design guide or token contract. As the product grows, this will cause subtle drift in typography, labels, colors, button behavior, tooltips, spacing, and responsive states. The goal should be a calm, precise operations-console aesthetic: clear hierarchy, dense but breathable data, consistent semantics, and confidence before destructive actions.

### 20.2 Design guide to create

Create `docs/DESIGN-SYSTEM.md` as the source of truth, with live examples in an internal style-guide route. Document:

- product principles: operational clarity, evidence before assertion, progressive disclosure, reversible actions, and accessible-by-default behavior;
- layout grid, page max width, panel/card rules, spacing scale, border radius scale, elevation, responsive breakpoints, and density modes;
- typography roles, weights, sizes, line heights, letter spacing, and when monospace is permitted;
- color tokens for surfaces, text, borders, accent, success, warning, danger, info, neutral, focus, and disabled states in light/dark themes;
- status vocabulary and mappings, button hierarchy, form controls, tables, tabs, badges, banners, modals, tooltips, charts, empty/loading/error states;
- content style: capitalization, punctuation, date/time, number, duration, percentage, model ID, and error-message rules;
- accessibility requirements for contrast, focus, keyboard order, touch targets, reduced motion, and screen-reader labels;
- do/don’t examples and component ownership so product pages do not invent one-off patterns.

### 20.3 Typography and font loading

Current CSS names `Inter` but does not load or self-host it, so the actual font can vary by machine. Define a deliberate font stack:

- self-host a versioned variable sans font (Inter or another selected product font) with `next/font` or controlled local `@font-face`, `font-display: swap`, unicode subsets, and preload only the needed weights;
- self-host a matching monospace variable font for IDs, timestamps, metrics, and code; do not use monospace for ordinary labels or long prose;
- define semantic typography classes (`text-display`, `text-title`, `text-section`, `text-body`, `text-meta`, `text-label`, `text-code`, `text-kpi`) rather than repeating raw pixel values;
- use a small weight set (regular, medium, semibold) and prohibit arbitrary 490/570/620 values unless the font supports them and the design guide names their purpose;
- normalize line height and optical sizing across headings, labels, table cells, controls, and badges;
- ensure numeric metrics use tabular numerals (`font-variant-numeric: tabular-nums`) and model/provider IDs use predictable wrapping/truncation;
- test font loading with JavaScript disabled and on slow networks; no layout shift should occur when the font arrives.

### 20.4 Labels and content language

Build a shared content glossary and label map. Current labels mix implementation terms, UI shorthand, and ambiguous status language. Standardize examples:

- “LiteLLM ID” (exact remote deployment identity), “RatLLM ID” (local identity), and “Alias” (router/model-group display name) must never be interchangeable;
- “Deployment” means one provider-backed remote instance; “Model” means canonical model/offering; “Candidate” means a discovery observation not yet deployed; “Lane” means a routing group;
- use sentence case for headings and buttons (`Run discovery`, `Sync inventory`, `Delete deployment`), title case only for product/navigation names;
- replace vague labels such as “Healthy,” “Available,” “Live,” or “Added” with a subject and timestamp where needed (`Deployment healthy · checked 2m ago`);
- show the human action in buttons, not implementation detail (`Check now`, `Quarantine in RatLLM`, `Request remote removal`);
- write status explanations beside unfamiliar labels, especially `DEGRADED`, `RATE_LIMITED`, `UNAVAILABLE`, `OBSERVE_ONLY`, and `STALE`;
- standardize empty states as “No [records] yet,” “No [records] match this filter,” and “Unable to load [records]” with distinct recovery actions;
- use one date/time policy: local time with explicit zone in UI, ISO/UTC in technical detail, and relative time only as a secondary label.

### 20.5 Color and status semantics

Replace scattered color decisions and regex-based status inference with a typed semantic status registry shared by server DTOs and UI components. Define tokens such as `--color-status-success`, `--color-status-warning`, `--color-status-danger`, `--color-status-info`, `--color-status-neutral`, and their surface/border/text variants for both themes.

- Never use red simply for “RatLLM managed” or green simply for “configured” if the state is not a health result; current ownership/status color choices can imply danger or success incorrectly.
- Separate health, lifecycle, ownership, evidence confidence, and action state into separate badges or labeled fields.
- Every status must have text/icon plus color; charts and history bars cannot rely on color alone.
- Check WCAG contrast for text, badge surfaces, focus rings, disabled controls, dark theme, and color-vision deficiencies.
- Define severity ordering and escalation behavior so `RATE_LIMITED`, `AUTH_ERROR`, `QUARANTINED`, and `SYSTEM_UNRELIABLE` are visually distinct.
- Use color-mix only through compiled tokens with fallbacks; validate support in the browser matrix.

### 20.6 Button and action standards

Create one `Button` component with explicit variants (`primary`, `secondary`, `quiet`, `danger`, `success`, `icon`), sizes (`sm`, `md`, `lg`), loading state, disabled reason, and icon placement. Document:

- one primary action per panel/section;
- destructive actions use danger styling, a clear verb, exact target identity, and a confirmation dialog;
- async buttons show `Starting…`, `Queued`, or `Working…` and retain the operation/run link after completion;
- never use color alone to distinguish an action and never silently change a button label while it is focused;
- icon-only buttons require an accessible name and a tooltip; touch targets are at least 44px even if the visual glyph is smaller;
- links navigate, buttons mutate; do not use styled links for mutations;
- disabled controls explain why in adjacent help text or an accessible description;
- destructive confirmation must show RatLLM ID, LiteLLM ID, alias, ownership, and current status, not only an alias string.

### 20.7 Tooltips, help, and popovers

The current CSS pseudo-element tooltip is compact but fragile: it can be clipped by overflow, has no robust collision handling, and is not a complete keyboard/screen-reader interaction. Replace it with an accessible tooltip/popover primitive:

- trigger on hover and focus, with a small delay and no tooltip for already-visible text;
- render in a portal/layer with viewport collision detection, arrow, max width, and dark/light tokens;
- expose `aria-describedby`, support Escape, and keep the tooltip out of the tab order;
- use a popover for actionable or multi-line explanations, not a hover tooltip;
- keep technical detail available through “Learn more” or an expandable evidence panel rather than oversized hover text;
- test touch behavior, keyboard focus, zoom, reduced motion, and table-edge positioning.

### 20.8 CSS architecture and scale

Refactor `globals.css` into layered, tokenized modules without changing the visual language abruptly:

1. `tokens.css`: colors, typography, spacing, radii, shadows, motion, z-index, breakpoints.
2. `reset.css`: predictable browser defaults and focus behavior.
3. `base.css`: body, links, forms, typography primitives.
4. `layout.css`: shell, page grid, responsive containers.
5. `components/`: buttons, panels, tables, badges, tabs, modals, tooltips, charts.
6. `utilities.css`: intentionally small, documented utilities.

Use CSS custom properties for semantic tokens, `@layer` for cascade control, `:where()` for low-specificity component defaults, and container queries for reusable panels. Remove repeated inline styles from JSX in favor of named classes or component props. Co-locate styles for genuinely local components while retaining global tokens. Add a stylelint rule set for duplicate colors, arbitrary z-indexes, invalid token use, and specificity growth.

### 20.9 Components and interaction patterns

Create and standardize primitives for `PageHeader`, `Panel`, `MetricCard`, `StatusBadge`, `OwnershipBadge`, `HealthBadge`, `FreshnessLabel`, `DataTable`, `FilterBar`, `EmptyState`, `LoadingSkeleton`, `ErrorState`, `ConfirmDialog`, `Tooltip`, `Popover`, `Sparkline`, `TrendChart`, and `EventIndicator`.

Each primitive needs a typed API, accessibility contract, responsive behavior, dark-theme treatment, loading/error/empty states, and a story/fixture. This prevents every page from implementing slightly different labels, spacing, status tones, and modal behavior.

### 20.10 Favicon and app icon structure

The current layout metadata defines title/description but no explicit favicon/app icon set, and the brand mark is embedded only as an inline sidebar SVG. Add a proper icon structure:

- `src/app/icon.svg` for the canonical vector favicon generated from the approved RatLLM mark;
- `src/app/icon.png` or generated 32px/16px fallbacks if browser support requires them;
- `src/app/apple-icon.png` at 180px for iOS home screens;
- `src/app/manifest.ts` (or `public/site.webmanifest`) with name, short name, start URL, display, theme/background colors, and 192px/512px icons;
- `public/favicon.ico` only as a legacy fallback, generated from the same source mark;
- optional `public/mask-icon.svg` with a single-color safe shape for Safari pinned tabs;
- explicit `metadata.icons`, `themeColor`, and viewport metadata in the Next layout;
- light/dark-safe artwork, sufficient padding, transparent and solid-background variants, and no tiny unreadable text in the mark.

The favicon, sidebar mark, manifest icons, login/empty-state artwork, and documentation screenshots must all come from one versioned asset source. Add automated checks that icons exist, have expected dimensions/MIME types, and do not expose development branding.

### 20.11 Motion, density, and responsive polish

- Use a small motion scale for hover/focus, modal entry, status updates, and progress; respect `prefers-reduced-motion`.
- Do not animate every live table row or cause layout shifts when a smoke result arrives; reserve motion for the changed row and use a subtle event indicator.
- Define compact/comfortable density modes for tables and settings, with a user preference persisted locally.
- Use responsive container layouts rather than page-wide breakpoint hacks; preserve critical identity columns on mobile and move secondary metadata into expandable rows.
- Ensure dark mode is token-complete, not just a second palette: charts, SVGs, focus, shadows, scrollbars, form controls, tooltips, and browser autofill need explicit treatment.

### 20.12 Quality gates and recommended implementation order

1. Write the design guide and glossary; inventory every current status, label, button, color, font size, inline style, tooltip, and icon.
2. Introduce tokens, font loading, semantic status registry, and shared typography/button/badge primitives.
3. Refactor panels, tables, modals, settings controls, and destructive actions to those primitives.
4. Replace tooltip pseudo-elements and standardize empty/loading/error/freshness states.
5. Add the favicon/manifest asset pipeline and metadata verification.
6. Split CSS into layers/modules, remove arbitrary inline values, and add stylelint/design-token checks.
7. Add visual regression, accessibility, contrast, keyboard, dark-mode, responsive, reduced-motion, and icon tests.

The UI polish is complete when every visible status has one documented semantic meaning and accessible text, every action follows the same button/confirmation/loading contract, typography and spacing come from tokens, tooltips work by keyboard/touch without clipping, dark/light themes pass contrast checks, all routes share the same primitives, and the favicon/manifest/brand assets are complete and versioned.

## 21. Remediation status (2026-09-18)

Work done against the P0 backlog. Verified with lint, typecheck, unit tests, a production build, and live requests against a production-mode server. Nothing here is committed or deployed yet.

### 21.1 Authentication decision (F-01, F-01a)

While verifying F-01 I found `ADMIN_TOKEN` never protected anything: `proxy.ts` sat at the repository root, but routes live in `src/app`, and Next.js only loads `proxy.ts` from beside `app/`. I implemented a working token check plus a login page, then the owner decided against built-in authentication and it was **removed entirely**. F-01 is therefore accepted risk, not fixed: the app is open to anyone who can reach its port. The dead root `proxy.ts` was deleted. `docs/SECURITY.md` now states this plainly. Mitigation is network-level (private network, VPN, or an authenticating reverse proxy) — see 21.4.

### 21.2 Done

| Finding | Change | Verification |
|---|---|---|
| F-02 | `src/server/net/outbound-policy.ts`: metadata, link-local, multicast, unspecified addresses always refused; loopback/private refused for public catalog URLs, allowed for LiteLLM/provider URLs. Applied to model-source save and sync (no redirects), LiteLLM base URL, and provider base URL. | 30 unit tests incl. decimal/hex-encoded IPs and IPv4-mapped IPv6; live 400s on all five routes. |
| §14 / F-09 | `deploymentIdentity()` no longer synthesizes an ID from the alias; items without a router ID are skipped and counted (`identityMissing`). Manual smoke test now probes the exact remote ID and refuses non-live deployments. Health monitor probes only `ACTIVE` deployments. | `tests-ts/deployment-identity.test.ts`. |
| D-01 | `candidateOnly` is enforced in `resolvePromotionContext` (shared by manual and auto promotion) and surfaced as the UI's "not promotable" reason. A community-only lead is blocked unless an authoritative source also reported it. | `tests-ts/promotion-gate.test.ts`. |
| D-02 | models.dev `$0` cost is recorded as `priceZeroClaim` and no longer sets `verifiedFree`. Existing rows correct themselves on the next discovery run (`run.ts` rewrites the flag). | Code path reviewed; not yet run against the live DB. |
| §17 | Worker writes a heartbeat on its own 15 s timer (independent of the job tick). `/api/health` reports `degraded` with worker status and overdue-job count while staying HTTP 200. | `tests-ts/worker-heartbeat.test.ts`. Not yet exercised against a running worker. |
| F-08 | Rate-limit "learning" no longer invents RPM: observed/safe values are cleared on its next run, sample count is assigned rather than accumulated, and queries are ordered. Copy corrected in Settings, About, and the deployment page. | Typecheck/lint; job not yet run against the live DB. |
| F-17 | Lint passes (uncommitted search-palette fix). `.github/workflows/ci.yml` runs lint, typecheck, test, build. | CI not yet run on GitHub. |

### 21.3 Behavior changes to know before deploying

- Community-only (`candidateOnly`) candidates can no longer be promoted, manually or automatically. Some currently auto-promotable candidates may become blocked.
- Blocked (`DEACTIVATED`) deployments are no longer health-probed.
- The rate-limit job clears previously stored observed/safe RPM values for non-manual profiles.

### 21.4 Not done — needs the operator or a larger change

- **No authentication (F-01, accepted).** Anyone who can reach the web port can store/delete provider credentials, control LiteLLM, and run automations. Keep the port off untrusted networks.
- Rotate the secrets exposed during troubleshooting, and restrict PostgreSQL port 5432 (F-03). Cannot be done from code.
- Full free-entitlement model (D-03 claims/observations), durable jobs, renewable leases, run outcome taxonomy, timezone-aware scheduling, DB CHECK constraints, single migration owner (drizzle vs alembic), integration tests, pagination, quarantine state machine, deployment detail pages. These are P1/P2.
- SSRF residual risk: DNS rebinding between validation and connection is not closed; egress firewall rules are still needed.
- Discovered, unfixed: `syncLiteLLM` marks every deployment `REMOVED` if the router returns an empty inventory (`sync.ts`, `missingFromRouter`). A transient empty response would wipe live state.

### 21.5 P1 progress (2026-09-18, second pass)

| Finding | Change | Verification |
|---|---|---|
| F-10 / §14 | **Empty-inventory guard.** `syncLiteLLM` no longer marks every deployment `REMOVED` when the router returns nothing usable. An empty (or all-IDs-missing) inventory is only trusted when the previous real sync was empty too, so one bad response can't wipe live state and a genuinely emptied router still converges after two syncs. The run summary now records `identified` and `removalsSkipped`. | 5 unit + 7 integration tests. Breaking the guard makes exactly the 3 relevant integration tests fail. |
| F-06 | **Renewable leases.** A running job renews its lease every 30 s; the lease is now 3 min (was a fixed 10 min with no renewal), so a long job can no longer be claimed mid-run and a crashed worker's job frees up in ~3 min. A lost lease is logged. Fencing (blocking a stale worker's late writes) is **not** done. | 4 integration tests (single owner, expiry reclaim, renewal, wrong-owner renew). |
| §17 item 10 | **Timezone-aware scheduling.** `nextCron` takes an IANA zone (default UTC) and no longer depends on the server process's zone. Scheduler and Settings route use each job's stored zone. DST behaves like classic cron (a skipped local time is skipped; a repeated hour matches twice). | 7 new unit tests incl. spring-forward and fall-back; suite also passes with `TZ=America/Los_Angeles`. |
| F-11 | **Run outcomes.** New `PARTIAL` and `DEFERRED` run statuses (migration `0012`, two additive `ADD VALUE`s). Discovery with some failed sources is `PARTIAL`; a promotion where some lane targets succeed is `PARTIAL`; expected waiting states (lanes at capacity, no lane matched, credential/provider not ready) are `DEFERRED` instead of `FAILED`. Auto-add backs off 6 h after a deferral instead of retrying hourly. | 3 policy unit tests; enum accepted in integration test. |
| F-17 | **Integration test harness.** `pnpm test:integration` starts a disposable Postgres container, applies the real migrations, and runs real server code against it. A safety rail refuses any database other than `localhost:55432`. Added to CI. | 14 tests; safety rail verified by pointing it at the production host. |

**Deploy note:** migration `0012` must be applied before code that writes `PARTIAL`/`DEFERRED` runs. The web container runs `pnpm db:migrate` on start; the worker container does not, so start (or restart) web first.

**Still open from P1:** manual "run now" as an enqueued 202 job; the persisted job/attempt tables; cleanup of the 23 `REMOVED` rows that still hold remote IDs plus the 114 inverted candidate timestamps and 2 bad smoke-test statuses (needs a reviewed data migration against production); DB CHECK constraints (depends on that cleanup); a single migration owner (the live DB has an `alembic_version` table but nothing in this repo references Alembic).

### 21.6 Discovery pass (2026-09-18, third pass)

| Finding | Change | Verification |
|---|---|---|
| F-07 | **Set-based discovery persistence.** `persistDiscoveredItems` (extracted from `runDiscovery`) now reads the relevant existing rows once, decides every item in memory using the original sequential rules, and writes in batches (`INSERT` batches; `UPDATE … FROM jsonb_to_recordset`) inside one transaction. For 1,500 items the statement count went from **5,493 to 12**, and refreshing 1,500 existing rows is also bounded. A source's results now publish atomically. | 14 behavior-contract tests, plus a randomized differential test (8 seeds × 3 batches) comparing every column and the evidence JSON against a frozen copy of the original implementation (`tests-integration/support/legacy-persist.ts`). |
| D-05 | **Structured source outcomes.** A source that can't run because its credential isn't configured now throws `SourceBlockedError` and is recorded `BLOCKED` (was: silently returned `[]`, recorded as a healthy source with 0 models → `DEGRADED`). It no longer consumes the source's refresh interval, so it retries on the next run after the key is added. A database error saving one source now fails only that source (its transaction rolls back) instead of aborting the whole run. Run status follows one tested rule: `SUCCEEDED` / `PARTIAL` / `FAILED` / `DEFERRED` (all sources blocked). | 7 end-to-end `runDiscovery` tests with fake sources; 6 unit tests for the status rule. |
| F-11 | The deferral marker write in `verify-due.ts` (`evidence || jsonb`) was written earlier but never executed; it is now a tested function. | 2 integration tests against real Postgres. |

**A bug the differential test caught before it shipped:** the first optimized version kept a stale in-memory provider index, so after a row was refreshed under a different provider, a later same-model item wrongly merged into it. Hand-written cases missed it; random input found it. My first regression test for it turned out to be too weak — re-breaking the code did not fail it — because it made separate calls that each reload from the database. It now runs in one batch and demonstrably fails when the fix is removed.

**Known, deliberate difference:** when two existing rows share a provider and model key, which one a new same-model item merges into was unspecified in the original (unordered scan) and is now deterministic (oldest-first). The differential generator gives each (source, model) a stable provider, as real sources do, so it doesn't compare that unspecified case.

**Not covered by these tests:** the network fetch inside each source adapter; `consolidateModelCandidates` (still loads and rewrites row by row — the next discovery cost); the Settings "Sync" button for custom sources (F-07's misleading custom-source UI is unchanged).

### 21.7 Production finding: duplicate deployments (2026-09-19)

Found while building the deployment detail page and checking it against live data.

**F-22 — High — The promoter adds the same model to LiteLLM repeatedly.** `registerTarget` treated a target as "already there" only if the matching deployment's `health !== "UNAVAILABLE"`. Health is the outcome of the last probe, not whether the deployment exists, so any moment where a live deployment probed unavailable (a rate limit, one bad probe) made the next promotion pass add *another copy*. The old copy stayed. Live data: `openai/gemma-4-26b-a4b-it` is ACTIVE **four times** behind `smart-vision` and **three times** behind `smart-long`, all RatLLM-managed, each with its own LiteLLM ID; the list page reports 2 duplicated models with 5 extra copies in total (an earlier draft of this section said "5 models"; that was the extra-copy count, misread). Identical copies add no capacity to a router pool — they skew routing and multiply provider rate-limit use.

- **Fixed in code:** existence is now "RatLLM holds a router ID and the deployment is ACTIVE or blocked", independent of health (`src/server/lanes/existing-target.ts`). A removed deployment (or one with no router ID) still allows a genuine re-add. Regression test fails against the old rule.
- **Made visible:** a warning on each affected model page and a summary on `/litellm` (`src/server/litellm/duplicates.ts`).
- **Not done:** the existing extra copies are still in LiteLLM. Removing them is a production mutation and should be done deliberately, by LiteLLM ID, keeping one copy per model per alias.
- **Residual race:** two promotion calls running at the same instant can still both miss a deployment that hasn't been synced into the local database yet. A live inventory check inside the promoter would close it.

**Deployment detail page additions:** absolute UTC dates for Discovered and Added to LiteLLM; a chronological Lifecycle timeline (discovered → first direct check passed → added to LiteLLM → first appeared in inventory → first router health check → lane assignments → auto-removals); and a Discovery panel (source and tier, free-access claim, direct-check pass rate, capabilities, other sources that reported it). "Added to LiteLLM" counts only promotions that really added a target behind the deployment's alias — the audit event is also written for hourly no-op re-runs and failed attempts.

**What counts as a duplicate (refined 2026-09-19).** The same model from a *different provider*, or from the same provider through a *different endpoint*, is legitimate: each has its own rate limits, cost and availability, and a router pool benefits from having several. A duplicate is now the same model, behind the same alias, through the same provider **and** the same endpoint (`api_base`, compared case- and trailing-slash-insensitively), so the copies share one quota. Checked against live data (read-only): 68 ACTIVE deployments; 5 alias/model combinations are served by more than one provider (not flagged); exactly 2 groups are flagged — `gemma-4-26b-a4b-it` in `smart-vision` (4 copies) and `smart-long` (3 copies), all RatLLM-managed, all Google AI Studio, all the same endpoint. Not verifiable from the database: whether copies use the same API *key*. RatLLM stores one credential per provider and these copies were created from it, so they do.

**Per-copy attribution fix.** The detail page first showed the same "Added to LiteLLM" time on every copy behind an alias, because promotion events name the alias and lane, not the new deployment. Each copy now takes the addition closest in time to when it first appeared in the inventory (within 15 minutes), and none if nothing is near — e.g. a model added directly in LiteLLM.

### 21.8 API key provenance (2026-09-19)

**Problem.** Which API key a deployment uses decides whether copies share a rate limit, but RatLLM never recorded it: the key goes to LiteLLM, RatLLM's stored copy of the deployment strips key-shaped fields, and the promoter picked a provider's credential with an unordered `limit(1)`. The credential resolver also prefers the server *environment* over the stored value, and env changes leave no audit trail — so "the same key" could only be inferred.

**Fix.**
- When RatLLM adds a deployment it now records, in the deployment's router metadata: the credential row id, its env var name, where the value came from (`environment` or `database`), and a **fingerprint** — a domain-separated SHA-256 prefix of the whole key (`src/server/credentials/fingerprint.ts`). Not first/last characters, which would leak part of the key. No secret is stored or returned. Field names avoid the words the metadata sanitizer strips, verified by a round-trip test.
- The model page shows an **API key** row: the recorded credential and source, and a comparison with the provider's key as this server sees it now — *same key*, or *the provider's key has changed since this was added* (the deployment still holds the old key and will fail if it was revoked).
- Deployments that predate the record show a clearly labelled inference from the audit trail ("credential last changed before this deployment appeared → created with the current key", or "changed after → may hold an older key"), and "added outside RatLLM — key unknown" for unmanaged ones.
- Duplicate detection now separates copies whose recorded fingerprints differ (separate quotas), and won't assume an unrecorded copy shares a key with a recorded one.

**Verified.** 8 unit + 9 integration tests, including a test that no key, ciphertext or decrypted value appears anywhere in the page's data (re-broken deliberately: it fails). Against live data the existing gemma copies show the inferred-current-key message.

**Limits.** (1) Only deployments added after this ships record provenance — and the promoter runs in the *server's* worker, so it takes effect once that worker is redeployed. (2) The comparison uses the environment of the server rendering the page; the worker's environment could differ. (3) The promoter still chooses among multiple credentials for one provider with an unordered query; the record now makes the choice visible, but doesn't make it deterministic.

### 21.9 Quarantine policy: failure classification and incident protection (2026-09-19, branch `quarantine-policy`)

Part of §18 (quarantine). Reading `monitor.ts` against §18.5 found two ways auto-removal could delete healthy models:

1. **A dead credential removed working models.** The stored error code is the health category, and the failure streak skipped only `RATE_LIMITED`. A 401/403 (`AUTH_ERROR`) counted as a genuine failure, so a revoked or expired provider key would fail every deployment made with it for 5 hourly checks and get them all auto-removed and quarantined.
2. **No protection against incidents.** Removal was decided per deployment, inside the probe loop, before the rest of the run was known. A provider outage, or the server losing its internet connection, made every model look dead for 5 checks. (A router that is fully down was only accidentally safe, because the removal call itself would fail while the failure rows still accumulated.)

**Fix.** `AUTH_ERROR` no longer counts toward a removal streak. The monitor is now three phases — probe everything, judge the run as a whole, then decide removals. A run where LiteLLM is unreachable, where at least 60% of six or more probes fail, or where every probe of a provider (three or more) fails, is an incident: its failures are tagged `SYSTEMIC`, excluded from streaks, logged, and audited. Protection is limited to deployments that passed within 24 hours, so a provider that retires all its models is still cleaned up. Documented in `docs/FREE-MODEL-LIFECYCLE.md` §5a.

**Verified.** 20 unit tests for the policy (thresholds and boundary cases, including the 24-hour edge) and 7 integration tests running the real monitor against a real database with a fake router: one broken model is still removed after 5 failures; a revoked key never removes anything over 12 runs; a widespread outage, an unreachable router and a provider-wide outage remove nothing and recover cleanly; a provider dead for over 24 hours is removed. With the old rules restored, 5 of those 7 fail — i.e. the mass-deletion scenarios really did happen.

**Behaviour to know about.** A deployment that is permanently forbidden (a per-model 403, e.g. a model that needs a paid tier) now stays `AUTH_ERROR` instead of being auto-removed. That is deliberate — a 403 can equally mean a broken key — but it means such models need a manual decision.

**Still open in §18:** a first-class quarantine record and state machine (suspect → quarantined → recovery probing), a 429 cooldown/backoff schedule, recovery probes independent of the hourly monitor, observe-only quarantine for unmanaged models, and an operator action to quarantine or release. Auto-remove is still opt-in and off by default.

### 21.10 Post-deploy correction: metadata field-name collision (2026-09-19)

Verifying the first deployment against the live server found a bug in the API-key provenance feature (§21.8). Its metadata fields were named `credential_id`, `credential_env`, `credential_source` and `credential_fingerprint` — but that metadata is shared with every other tool that adds models to the same LiteLLM. A second tool, `smart-free-sync` (visible as `managed_by` on those deployments), already writes its own `credential_fingerprint` (a different algorithm) on 58 deployments (33 active, all unmanaged from RatLLM's point of view). RatLLM read that foreign value as its own and, on every such deployment, displayed "recorded when RatLLM added this deployment" and "the provider's key has changed since this was added" — a false alarm.

**Fix.** RatLLM's four fields are now `ratllm_credential_*`, so a foreign field can never be mistaken for one. No data migration was needed: none of the 58 carried a RatLLM-written field (all had an empty `credential_source`), and no deployment has been promoted by the new code yet. A regression test reproduces the collision with the foreign field alone. **Lesson:** a namespace check against live metadata belongs in the design of any field written into shared metadata; this one only showed up against production data.

**Opportunity, not built.** `smart-free-sync` records a per-deployment key fingerprint too. Equal values within that tool mean the same key, so the shared-quota question for unmanaged deployments could be answered from it — but its algorithm is unknown, so its values can only be compared with each other, never with RatLLM's.

### 21.11 smart-free-sync, lane capacity, and the real cause of the duplicates (2026-09-19)

**What smart-free-sync is.** Read-only evidence from the live database and router, not assumption: it is not a running service. All 58 deployments it created carry an `updated_at` inside a single 7-minute window on 2026-09-02 (version `2026.08.22-v2.9`, every one `tier=free`, `direct_access=true`); RatLLM first saw them on 09-04. It is a one-time bulk import of free models from NVIDIA NIM, Cohere, Kilo AI Gateway, OpenCode Zen, Groq and Google AI Studio, and it defines the `smart-*` lane names RatLLM later adopted. Six different things write to this router: `smart-free-sync` (33 live), `local-mac-mini` (15), `ratllm-curator` (12), `manual-free-add` (6), and the older `okame-model-curator` (1). No model is live under two managers, so there is no direct conflict, and the live fallback chains in LiteLLM match RatLLM's intended `LANE_FALLBACKS` exactly — no drift. RatLLM's own deployments sit in only three lanes (`smart-long`, `smart-summary`, `smart-vision`); `smart-free-sync` fills the other lanes.

**Two bugs this exposed.**

1. **Lane capacity counted ghosts.** The capacity check counted every non-excluded lane assignment, including assignments left behind by removed or blocked deployments. `smart-coding` counted 16 members against a cap of 12 while 8 were live; five lanes had 1-4 free slots RatLLM could not see. That is why automatic promotion kept deferring with "all recommended lanes are at capacity" (F-11). Capacity, the lane picker's "full" flag and the lane status counts now share one definition of a live member (`src/server/lanes/membership.ts`).
2. **The hourly reconciler re-added live models.** It treated any member whose health read `UNAVAILABLE` as "broken" and re-promoted it — including ones live in the router. With the old existence check that added another copy every hour: this is the true source of the duplicate gemma deployments (additions at 07:05, 08:05, 09:05 — the reconciler's :05 schedule). The earlier fix (§21.7) stopped the copies; this stops the reconciler asking for them. It now repairs a member only when its deployment is actually missing from the router.

**Made visible.** `/litellm` has a "Who manages what" table (live, healthy, not serving per manager) and a list of live models that are not serving but that RatLLM does not manage, with their LiteLLM IDs — RatLLM removes only what it manages, so those stay in their lanes until someone acts on them in LiteLLM. On the live data: `smart-free-sync` 33 live / 4 not serving; RatLLM 12 / 1. Each model page names its actual manager.

**Not built — needs a decision.** *Adopting* the smart-free-sync models (changing their `managed_by` in the router so RatLLM manages them) would let RatLLM's health monitor and quarantine policy cover them. It mutates production router metadata per model, so it should be an explicit, per-deployment, audited action, and only after deciding whether a future run of that tool would then fight RatLLM. Until then they are observed, never changed.

### 21.12 Batch 3 (2026-09-19): actions, status, key rotation, hygiene

| Finding | Change | Verification |
|---|---|---|
| §14 / §18.7 | **Exact-ID confirmation.** Deactivate/delete were confirmed by typing the alias, which every member of a pool shares — with identical copies behind one alias nothing prevented confirming a delete against the wrong one. The phrase is now the action plus the start of the deployment's own LiteLLM ID; the dialog shows LiteLLM ID, alias, model, manager and health. Delete no longer nulls the LiteLLM ID (kept as history) and frees the lane slot. | 9 integration tests calling the real route: the alias and the *other copy's* phrase are rejected; only the named copy is acted on. |
| §18.2 | **Adopt (new, explicit, audited).** Hand one deployment another tool added over to RatLLM by writing RatLLM's `managed_by` into the router's metadata. Because the router's update may merge or replace `model_info`, it snapshots, applies, re-reads, verifies nothing was lost and restores the snapshot if it was. Refused for models RatLLM already manages, ones gone from the router, and self-hosted models. Never automatic, never bulk. **Not yet exercised against the real router** — whether LiteLLM merges or replaces on this call is unverified, which is why the verify-and-restore step exists; try one model first. | 11 unit tests against a fake router (merge / replace / ignore / reject) + route integration tests. |
| F-07 / data | **Provider misfiling.** Three RatLLM-managed deployments were filed under the catch-all "Openai" provider (Alibaba, Google AI Studio, OpenRouter) because sync matched the deployment's provider *name* against the catalog ("Alibaba Cloud Model Studio" vs "Alibaba Model Studio"). Managed deployments now use their discovery record's provider; existing rows correct on the next sync. | 4 integration tests; 2 fail without the fix. |
| F-10 | A failed fallback-chain sync was discarded (`.catch(() => undefined)`), so a run could read "succeeded" while LiteLLM and RatLLM disagreed about routing. Now recorded, and such a run is `PARTIAL`. | 5 unit tests. |
| F-04 | **`/api/status` and an Overview panel** answer "is RatLLM actually working?": worker, LiteLLM reachability, per-job data freshness, failed runs (24h), invalid/unverified credentials, live models not serving. `healthy` only when nothing needs attention. `/api/health` is unchanged (it backs the container healthcheck and must never depend on an external provider). LiteLLM is judged against the real hourly cadence, not the connection's 15-minute STALE flag. Against production data it reports 7 invalid provider credentials and the old-code promotion failures. | 10 unit + 5 integration tests. |
| F-03 | **Encryption keyring + rotation.** `CREDENTIAL_ENCRYPTION_KEYS` / `CREDENTIAL_ENCRYPTION_KEY_ID`; values written as `v2.<keyId>…`; with only the original key set nothing changes. `pnpm credentials:rotate` (dry run) / `--apply` re-encrypts every stored credential incl. LiteLLM's master key, verifying each round-trips first; unreadable values are reported and left untouched; safe to run twice; prints counts only. Procedure in `docs/SECURITY.md`. This is what makes rotating the exposed secrets possible. | 17 unit + 7 integration tests; CLI run end to end against a throwaway database. |
| F-16 / F-20 | Docs that contradicted the code corrected (mutation is enabled and bounded; credentials are stored encrypted, not by reference; unmanaged deployments can be changed by explicit operator action); "three discovery sources" (there are 26), the health-cadence comments, and the Overview's dead "Pending changes" tile. README gains a "check that it is actually working" step. | — |
| §13 | **Data hygiene + first constraints (migration 0014).** A read-only audit of production found less than the report feared: 97 candidates with `last_seen_at` before `first_seen_at` — by at most **238 microseconds** (app clock vs database default: skew, not corruption); 2 smoke tests with `http_status` 0; 190 candidates with a token limit of 0 or less (sources report 0 for "unknown"); everything else clean, and the 23 removed deployments keeping their LiteLLM ID is intended history. The three write paths that made these rows are fixed (one clock for both timestamps; unknown limits stored as NULL; no-response stored as NULL). The migration repairs the rows and adds 13 CHECK constraints, all `NOT VALID` so an unexpected old row can never make the migration fail and stop the web container starting; validate them later. | 9 integration tests: each constraint rejects the bad row it exists for, accepts the legitimate shapes, the repair SQL fixes deliberately bad rows and is idempotent, and the code paths no longer write bad data. A constraint immediately caught an inconsistent test fixture. |

**Process note.** Two of my own commits this batch went in before their checks had really passed: once with a type error (amended before pushing), and once a "gates passed" message printed despite a failing test because I gated on `grep` finding text rather than on the command's exit status. Neither reached a branch anyone else uses. Gates are now checked on real exit codes.

**Still open from this batch's scope:** adopting `smart-free-sync`'s models is now *possible* but has not been done; nothing changes until an operator does it.
