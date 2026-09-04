# Security

LiteLLM and provider keys are server-only. API responses, audit records, raw metadata, and structured logs recursively redact key-, token-, password-, authorization-, and secret-shaped fields.

Set `ADMIN_TOKEN` for optional single-admin bearer protection when Cloudflare Zero Trust is not the only boundary. Health and readiness remain open for orchestrators. Do not reuse the internal secret, LiteLLM master key, or provider credentials.

The UI reports whether a credential reference exists; it never returns environment values. Unmanaged LiteLLM deployments cannot enter mutation code paths.
