# Security

LiteLLM and provider keys are server-only. API responses, audit records, raw metadata, and structured logs recursively redact key-, token-, password-, authorization-, and secret-shaped fields.

RatLLM has no built-in login: anyone who can reach the web port can use every page and API route, including storing provider credentials and controlling LiteLLM. Keep it on a trusted, isolated network (or behind Cloudflare Zero Trust / a VPN / a reverse proxy that authenticates) and do not publish the port. `/api/internal/*` checks `INTERNAL_API_SECRET` itself. Do not reuse the internal secret, LiteLLM master key, or provider credentials.

The UI reports whether a credential reference exists; it never returns environment values. Unmanaged LiteLLM deployments cannot enter mutation code paths.

## Rotating the credential encryption key

Provider API keys and LiteLLM's master key are stored encrypted (AES-256-GCM). Changing `CREDENTIAL_ENCRYPTION_KEY` directly makes every stored credential unreadable, so rotation uses a **keyring**:

| Variable | Meaning |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | The original single key. Still works alone, exactly as before. |
| `CREDENTIAL_ENCRYPTION_KEYS` | Optional keyring: comma-separated `id:secret` entries (secret ≥ 32 characters), e.g. `2026-10:<new>,2026-01:<old>`. |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | Which keyring entry encrypts **new** values. Defaults to the first entry. |

Procedure (each step is reversible until the last):

1. **Back up the database.** Keep the old key.
2. Generate a new key: `openssl rand -base64 48`.
3. In `.env`, add the keyring with the **new key first and the old key still in it**, and keep `CREDENTIAL_ENCRYPTION_KEY` set to the old key:
   ```
   CREDENTIAL_ENCRYPTION_KEYS=2026-10:<new key>,legacy:<old key>
   CREDENTIAL_ENCRYPTION_KEY_ID=2026-10
   ```
   Restart web and worker. New values now use the new key; old values are still readable.
4. Dry run, then apply. Both print counts and key ids only, never a credential:
   ```bash
   pnpm credentials:rotate            # reports what would change; writes nothing
   pnpm credentials:rotate --apply    # re-encrypts everything, verifying each value round-trips first
   ```
   A value that no configured key can read is reported and **left untouched**; resolve those before continuing.
5. Once every value reports the new key, remove the old key from `.env` (both `CREDENTIAL_ENCRYPTION_KEY` and its keyring entry), restart, and confirm provider credentials still verify.

Never remove the old key before step 4 reports 0 unreadable values.

