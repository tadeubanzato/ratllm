# LiteLLM integration

`src/server/litellm` is the compatibility boundary. It validates variable `/v1/model/info` response shapes, derives stable identities, redacts secret-shaped metadata, and exposes smoke tests.

Only `model_info.managed_by == "okame-model-curator"` is managed. Missing markers, the legacy `ratllm` marker, and arbitrary values are unmanaged and read-only. Future adoption must be explicit and audited.

Model-management payloads will be capability-detected against the configured LiteLLM version before write support is enabled.
