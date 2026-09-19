# Security

LiteLLM and provider keys are server-only. API responses, audit records, raw metadata, and structured logs recursively redact key-, token-, password-, authorization-, and secret-shaped fields.

RatLLM has no built-in login: anyone who can reach the web port can use every page and API route, including storing provider credentials and controlling LiteLLM. Keep it on a trusted, isolated network (or behind Cloudflare Zero Trust / a VPN / a reverse proxy that authenticates) and do not publish the port. `/api/internal/*` checks `INTERNAL_API_SECRET` itself. Do not reuse the internal secret, LiteLLM master key, or provider credentials.

The UI reports whether a credential reference exists; it never returns environment values. Unmanaged LiteLLM deployments cannot enter mutation code paths.
