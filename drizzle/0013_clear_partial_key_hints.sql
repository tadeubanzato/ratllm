-- Older versions stored the first and last three characters of each API key in `value_hint` (e.g. "sk-••••w0O") and the
-- provider page displayed it. That is partial key material in plaintext. The hint is only a display label; the real value
-- is `encrypted_value`. Replace every legacy hint with the neutral label that current code writes. Idempotent.
UPDATE "provider_credential_references"
SET "value_hint" = 'Configured'
WHERE "value_hint" IS NOT NULL AND "value_hint" <> 'Configured';
