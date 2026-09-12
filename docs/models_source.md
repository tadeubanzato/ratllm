# Free AI Model Sources — Project Reference

**File:** `models_source.md`  
**Verified:** 2026-09-11  
**Purpose:** Build and maintain a high-quality registry of free / free-tier AI models, model providers, hosting providers, capabilities, pricing, and availability for routing projects such as LiteLLM, n8n, custom gateways, model curators, and automatic fallback systems.

---

## 1. How to use this document

There is no single perfect source of truth for "free AI models."

A reliable registry should combine:

1. **Canonical model catalogs** — who created the model, capabilities, context window, open-weight status.
2. **Inference-provider catalogs** — which provider actually serves the model.
3. **Provider pricing/free-tier documentation** — whether the API is really free, rate-limited, trial-only, or promotional.
4. **Live model-list APIs** — what is actually callable right now.
5. **Community discovery lists** — useful for discovering providers, but never authoritative enough to override official documentation.

### Recommended trust order

| Grade | Source type | Use |
|---|---|---|
| **A+** | Official provider API + official pricing/rate-limit docs | Final truth for availability/free status |
| **A** | Official provider model catalog | Model IDs and capabilities |
| **A-** | models.dev / Hugging Face / OpenRouter | Cross-provider normalization/discovery |
| **B+** | LiteLLM registry | Excellent normalization and provider metadata |
| **B** | Maintained community lists | Discovery only |
| **C** | Blogs, Reddit, old GitHub gists | Leads only; verify elsewhere |

> **Critical rule:** `price == 0` in an aggregator does **not** automatically mean the provider offers a usable free API. Always verify free status against the serving provider.

---

# 2. Recommended canonical schema

Do **not** store only:

```json
{
  "free": true
}
```

Use richer semantics:

```json
{
  "canonical_model_id": "alibaba/qwen3.8-27b",
  "provider_model_id": "qwen/qwen3.8-27b",
  "model_lab": "Alibaba / Qwen",
  "serving_provider": "Groq",
  "free_access": true,
  "free_type": "recurring_rate_limited",
  "input_price_usd_per_million": 0,
  "output_price_usd_per_million": 0,
  "quota": {
    "rpm": 30,
    "rpd": 1000,
    "tpm": 8000,
    "tpd": 200000
  },
  "requires_credit_card": false,
  "region": null,
  "expires_at": null,
  "source_grade": "A+",
  "last_verified_at": "2026-09-11"
}
```

Recommended `free_type` values:

```text
free_unmetered
free_rate_limited
recurring_free_quota
recurring_credit
trial_credit
trial_quota
promotional_free
open_weight_self_hosted
provider_specific_free
unknown
```

---

# 3. Top source stack

| Rank | Source | Rating | Best for | Automation |
|---:|---|---:|---|---|
| 1 | **models.dev** | 5.0/5 | Canonical model/provider/lab database | Excellent |
| 2 | **OpenRouter** | 5.0/5 | Live hosted models + explicit free variants | Excellent |
| 3 | **Hugging Face Inference Providers** | 5.0/5 | Global model/provider graph | Excellent |
| 4 | **LiteLLM model registry** | 4.8/5 | Normalized provider/pricing/context metadata | Excellent |
| 5 | **Google Gemini API** | 5.0/5 | Direct recurring free tier | Excellent |
| 6 | **GroqCloud** | 5.0/5 | Direct free inference + explicit rate limits | Excellent |
| 7 | **Cloudflare Workers AI** | 5.0/5 | Recurring daily free compute | Very good |
| 8 | **Mistral AI Studio** | 4.8/5 | EU provider, free API mode | Excellent |
| 9 | **Z.AI / Zhipu AI** | 4.8/5 | Direct $0 Chinese GLM models | Very good |
| 10 | **Alibaba Model Studio** | 4.8/5 | Large per-model trial quotas, Qwen ecosystem | Very good |
| 11 | **Vercel AI Gateway** | 4.7/5 | Broad model/provider gateway + recurring credit | Excellent |
| 12 | **NVIDIA NIM API Catalog** | 4.7/5 | Many free endpoints and open models | Very good |
| 13 | **Cerebras Inference** | 4.5/5 | Fast inference, public catalog, trial credits | Excellent |
| 14 | **Cohere** | 4.3/5 | Trial API + chat/embed/rerank | Good |
| 15 | **free-llm-api-resources** | 4.0/5 | Provider discovery | Good, but verify |
| 16 | **Provider watchlist** | 3.5/5 | SambaNova, SiliconFlow, Novita, etc. | Verify individually |

---

# 4. Source details

---

## 4.1 models.dev

**Rating:** 5.0/5  
**Role:** Primary canonical model/provider/lab catalog  
**Authority:** Independent open-source normalization layer  
**Best use:** Build the master universe of models, labs, providers, capabilities, context windows, model relationships, and canonical IDs.

### URLs

- Main site: https://models.dev/
- Models: https://models.dev/models/
- Providers: https://models.dev/providers/
- Labs: https://models.dev/labs/
- Provider-oriented JSON: https://models.dev/api.json
- Provider-independent model JSON: https://models.dev/models.json
- Combined catalog JSON: https://models.dev/catalog.json
- GitHub/source data: https://github.com/sst/models.dev
- SDK: https://www.npmjs.com/package/@opencode-ai/models

### Why it is valuable

models.dev exposes:

- canonical model ID
- model lab / author
- serving providers
- input/output context limits
- reasoning support
- tool calling
- structured output
- temperature support
- open vs. closed weights
- price metadata
- release/update dates

The site explicitly provides three JSON endpoints for automation.

### Bash examples

Download the complete provider catalog:

```bash
curl -fsSL https://models.dev/api.json -o models-dev-providers.json
```

Download canonical model metadata:

```bash
curl -fsSL https://models.dev/models.json -o models-dev-models.json
```

Download the combined catalog:

```bash
curl -fsSL https://models.dev/catalog.json -o models-dev-catalog.json
```

Pretty-print:

```bash
curl -fsSL https://models.dev/catalog.json | jq .
```

Look for zero-price entries:

```bash
curl -fsSL https://models.dev/catalog.json \
  | jq '.. | objects | select(.cost? != null)'
```

### Caveat

A `$0` value can describe a canonical/aggregated model record, not necessarily a durable free API entitlement from every provider. Use it for discovery, then validate provider-level free access separately.

### Recommended ingestion priority

```text
CANONICAL_MODEL_SOURCE = 1
FREE_STATUS_AUTHORITY = no
```

---

## 4.2 OpenRouter

**Rating:** 5.0/5  
**Role:** Best live catalog for hosted zero-cost model variants  
**Best use:** Discover currently callable free models across many international labs/providers.

### URLs

- Models browser: https://openrouter.ai/models
- Free models collection: https://openrouter.ai/collections/free-models
- Free router: https://openrouter.ai/openrouter/free
- Models API documentation: https://openrouter.ai/docs/api/api-reference/models/get-models
- Models API: https://openrouter.ai/api/v1/models
- General model docs: https://openrouter.ai/docs/guides/overview/models

### Important conventions

OpenRouter commonly marks zero-cost variants with:

```text
<author>/<model>:free
```

It also exposes:

```text
openrouter/free
```

`openrouter/free` dynamically chooses among free models compatible with the request.

### Bash — list all models

```bash
curl -fsSL https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '.data[] | {id, name, context_length, pricing}'
```

### Bash — find models with `:free`

```bash
curl -fsSL https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '[.data[] | select(.id | endswith(":free"))]'
```

### Bash — find zero-token-price models

```bash
curl -fsSL https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '
    [.data[]
      | select(
          ((.pricing.prompt // "1") | tonumber) == 0 and
          ((.pricing.completion // "1") | tonumber) == 0
        )
    ]'
```

### Useful API filters

OpenRouter supports model filtering by properties such as:

```text
output_modalities
input_modalities
context
min_price
max_price
architecture
model authors
providers
zero-data-retention
region
```

Example:

```bash
curl -fsSL \
  'https://openrouter.ai/api/v1/models?max_price=0&sort=context-high-to-low' \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '.data[].id'
```

### Strengths

- very broad international coverage
- provider routing
- pricing metadata
- context windows
- modalities
- tools / structured outputs
- free model variants
- frequent catalog changes

### Caveats

- free models can be promotional
- free inventory changes frequently
- some free models permit provider/model training on prompts/outputs
- rate limits differ from paid usage

### Recommended refresh

```text
Every 6–24 hours
```

---

## 4.3 Hugging Face Inference Providers

**Rating:** 5.0/5  
**Role:** Best global model/provider relationship graph  
**Best use:** Discover which providers serve a model, model-task relationships, open model ecosystem, and provider-specific deployment mappings.

### URLs

- Inference Providers: https://huggingface.co/docs/inference-providers/
- Hub API documentation: https://huggingface.co/docs/inference-providers/hub-api
- Hub integration: https://huggingface.co/docs/inference-providers/hub-integration
- All models with providers: https://huggingface.co/models?inference_provider=all
- OpenAI-compatible router model endpoint: https://router.huggingface.co/v1/models
- Generic Hub model API: https://huggingface.co/api/models

### List all models served by any inference provider

```bash
curl -fsSL \
  'https://huggingface.co/api/models?inference_provider=all' \
  | jq '.[].id'
```

### List models served by Groq

```bash
curl -fsSL \
  'https://huggingface.co/api/models?inference_provider=groq' \
  | jq '.[].id'
```

### Multiple providers

```bash
curl -fsSL \
  'https://huggingface.co/api/models?inference_provider=nscale,novita' \
  | jq '.[].id'
```

### Filter by task

```bash
curl -fsSL \
  'https://huggingface.co/api/models?inference_provider=all&pipeline_tag=text-to-image' \
  | jq '.[].id'
```

### OpenAI-compatible provider comparison endpoint

```bash
curl -fsSL https://router.huggingface.co/v1/models \
  -H "Authorization: Bearer $HF_TOKEN" \
  | jq '.data[] | {
      id,
      owned_by,
      providers
    }'
```

Provider records can contain:

```text
provider
status
context_length
pricing
is_free
supports_tools
supports_structured_output
first_token_latency_ms
throughput
is_model_author
```

That makes this endpoint particularly valuable for a smart router.

### Important caveat

Hugging Face's own included inference credit is small compared with dedicated free-tier providers. Treat HF primarily as:

```text
model/provider discovery + routing metadata
```

rather than assuming all models visible through HF are free.

---

## 4.4 LiteLLM model registry

**Rating:** 4.8/5  
**Role:** Excellent normalization layer  
**Best use:** Provider names, model IDs, token costs, context sizes, supported endpoints, regions, and LiteLLM compatibility.

### URLs

- LiteLLM GitHub: https://github.com/BerriAI/litellm
- Model registry:
  https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
- Schema:
  https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.schema.json
- Supported providers:
  https://docs.litellm.ai/docs/providers

### Download the registry

```bash
curl -fsSL \
  https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json \
  -o litellm-model-registry.json
```

### Count entries

```bash
jq 'keys | length' litellm-model-registry.json
```

### Find a provider

```bash
jq '
  to_entries
  | map(select(.value.litellm_provider == "groq"))
  | .[]
  | {model: .key, data: .value}
' litellm-model-registry.json
```

### Look for apparent zero-cost entries

```bash
jq '
  to_entries
  | map(
      select(
        (.value.input_cost_per_token? == 0) and
        (.value.output_cost_per_token? == 0)
      )
    )
  | .[].key
' litellm-model-registry.json
```

### Critical caveat

**Never interpret missing/zero LiteLLM pricing as proof that a provider is free.**

A new model can temporarily lack populated pricing metadata. Use LiteLLM for normalization and routing compatibility, then confirm free status from provider documentation.

---

# 5. Direct providers with useful free access

---

## 5.1 Google Gemini Developer API

**Rating:** 5.0/5  
**Region/company:** Google / global  
**Free classification:** `recurring_free_quota`  
**Best use:** High-quality general, multimodal, reasoning, and large-context inference.

### URLs

- Models docs: https://ai.google.dev/gemini-api/docs/models
- Models REST API: https://ai.google.dev/api/models
- Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- AI Studio: https://aistudio.google.com/

### Free semantics

Google documents a **Free** Gemini Developer API tier with limited access to selected models and free input/output tokens.

Free tier data-use terms can differ from paid tiers; store this as metadata if privacy matters to your project.

### Native REST model list

```bash
curl -fsSL \
  "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  | jq '.models[] | {
      name,
      displayName,
      inputTokenLimit,
      outputTokenLimit,
      supportedGenerationMethods
    }'
```

### OpenAI-compatible model list

```bash
curl -fsSL \
  https://generativelanguage.googleapis.com/v1beta/openai/models \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  | jq .
```

### Recommended fields to capture

```text
model ID
input/output token limit
generation methods
free-tier eligibility
RPM
TPM
RPD/TPD when applicable
multimodal support
tool support
structured output
data-use policy
```

---

## 5.2 GroqCloud

**Rating:** 5.0/5  
**Free classification:** `free_rate_limited`  
**Best use:** Very fast free inference, coding/general models, speech-to-text.

### URLs

- Models: https://console.groq.com/docs/models
- Rate limits: https://console.groq.com/docs/rate-limits
- API reference: https://console.groq.com/docs/api-reference
- Model API: https://api.groq.com/openai/v1/models

### Current free-plan examples

The official free-plan table currently lists explicit per-model rate limits. Examples include models such as:

```text
openai/gpt-oss-120b
openai/gpt-oss-20b
qwen/qwen3.6-27b
qwen/qwen3.8-27b
whisper-large-v3
whisper-large-v3-turbo
```

### List models

```bash
curl -fsSL https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  | jq '.data[] | {
      id,
      owned_by,
      active,
      context_window
    }'
```

### Capture rate-limit headers

```bash
curl -i https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [{"role":"user","content":"ping"}],
    "max_tokens": 1
  }'
```

Look for:

```text
x-ratelimit-limit-requests
x-ratelimit-limit-tokens
x-ratelimit-remaining-requests
x-ratelimit-remaining-tokens
x-ratelimit-reset-requests
x-ratelimit-reset-tokens
retry-after
```

### Recommended refresh

Models: daily  
Rate limits: daily or weekly

---

## 5.3 Cloudflare Workers AI

**Rating:** 5.0/5  
**Free classification:** `recurring_free_quota`  
**Free quota:** 10,000 Neurons/day as of verification date  
**Best use:** Recurring serverless inference without maintaining GPU infrastructure.

### URLs

- Pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Models: https://developers.cloudflare.com/workers-ai/models/
- Workers AI docs: https://developers.cloudflare.com/workers-ai/
- REST API reference: https://developers.cloudflare.com/api/resources/ai/

### Free semantics

Cloudflare currently includes **10,000 Neurons per day** on the free allocation, resetting daily.

### Example model catalog query through Cloudflare API

Cloudflare's API is account scoped. A typical pattern is:

```bash
curl -fsSL \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/models/search" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq .
```

### Important classification

Do not convert Neurons directly into "free tokens" without model-specific calculation.

Store:

```json
{
  "quota_unit": "neurons",
  "quota_period": "day",
  "quota_amount": 10000
}
```

### Strengths

- resets daily
- global edge ecosystem
- many open models
- useful for fallback lanes

---

## 5.4 Mistral AI Studio

**Rating:** 4.8/5  
**Region/company:** France / EU  
**Free classification:** `free_rate_limited`  
**Best use:** European provider, Mistral models, coding, embeddings, OCR, multimodal.

### URLs

- Getting started: https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request
- Activate Studio: https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key
- Models endpoint: https://docs.mistral.ai/api/endpoint/models
- API model list: https://api.mistral.ai/v1/models
- Pricing: https://mistral.ai/pricing

### Free semantics

Mistral's documentation states that Studio is enabled in **Free mode by default**, with **no credit card required**, subject to usage/rate limits.

### List models

```bash
curl -fsSL https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  | jq '.data[] | {
      id,
      owned_by,
      max_context_length,
      capabilities
    }'
```

### Good fields returned

```text
model ID
capabilities.completion_chat
capabilities.completion_fim
capabilities.function_calling
capabilities.vision
capabilities.classification
max_context_length
aliases
archived
```

### Caveat

Free mode availability and specific model entitlements may change independently of nominal paid pricing. Verify actual callable models with the authenticated model endpoint.

---

## 5.5 Z.AI / Zhipu AI

**Rating:** 4.8/5  
**Region/company:** China / international Z.AI service  
**Free classification:** `provider_specific_free`  
**Best use:** GLM family, reasoning, multimodal, international non-US source.

### URLs

- Developer docs: https://docs.z.ai/
- Pricing: https://docs.z.ai/guides/overview/pricing
- Models overview: https://docs.z.ai/guides/llm/glm
- API console: https://z.ai/model-api

### Explicit $0 models currently documented

At verification time the official pricing page lists:

```text
GLM-4.7-Flash      Free input / Free output
GLM-4.5-Flash      Free input / Free output
GLM-4.6V-Flash     Free input / Free output
```

### Recommended ingestion strategy

Because the pricing page directly identifies free models, scrape/parse the provider's pricing table and combine it with the API model list or provider catalog.

Pseudo-Bash:

```bash
curl -fsSL https://docs.z.ai/guides/overview/pricing \
  | grep -Ei 'GLM-.*Flash|Free'
```

For production use, prefer structured provider APIs over HTML parsing whenever an official list endpoint is available.

### Caveat

Do not assume all `Flash` variants are free. Some `FlashX` variants are paid.

---

## 5.6 Alibaba Cloud Model Studio

**Rating:** 4.8/5  
**Region/company:** Alibaba Cloud / China & international  
**Free classification:** `trial_quota`  
**Best use:** Qwen ecosystem and a large number of per-model free allocations.

### URLs

- Free quota docs:
  https://www.alibabacloud.com/help/en/model-studio/new-free-quota
- Model pricing/list:
  https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing
- Model Studio docs:
  https://www.alibabacloud.com/help/en/model-studio/
- Console:
  https://modelstudio.console.alibabacloud.com/

### Free semantics

For international use, Alibaba currently documents free quotas for eligible **Singapore-region International** models.

Typical eligible Qwen models receive a **per-model token quota**, frequently around **1 million tokens per model**, valid for **90 days**.

The exact quota varies by model.

### Important safety option

Alibaba supports a **Free Quota Only** control. When enabled, requests stop when the quota is exhausted rather than automatically converting to paid usage.

This is ideal for a "free-only" router.

### Suggested schema

```json
{
  "free_type": "trial_quota",
  "region": "Singapore",
  "deployment_scope": "International",
  "validity_days": 90,
  "quota_scope": "per_model",
  "hard_stop_available": true
}
```

### Automation

Because quotas differ by model, ingest the pricing/free-quota table rather than assigning one quota globally.

---

## 5.7 Vercel AI Gateway

**Rating:** 4.7/5  
**Free classification:** `recurring_credit`  
**Best use:** Unified model/provider catalog and routing.

### URLs

- Models & providers docs:
  https://vercel.com/docs/ai-gateway/models-and-providers
- REST API:
  https://vercel.com/docs/ai-gateway/openai-compat/rest-api
- Public model API:
  https://ai-gateway.vercel.sh/v1/models
- Model browser:
  https://vercel.com/ai-gateway/models
- Pricing:
  https://vercel.com/docs/ai-gateway/pricing

### Free semantics

Vercel model pages currently state that free users who have not made a payment receive **$5 of credits every 30 days**.

Treat this as recurring credit, not a zero-priced model.

### Public model list — no auth required

```bash
curl -fsSL https://ai-gateway.vercel.sh/v1/models \
  | jq '.data[] | {
      id,
      name,
      owned_by,
      type,
      context_window,
      max_tokens,
      pricing,
      tags
    }'
```

### Why it is particularly useful

The endpoint returns normalized:

```text
model IDs
model owner
model type
context
max output
pricing
capability tags
```

and Vercel routes across many providers including international providers.

### Suggested classification

```json
{
  "free_type": "recurring_credit",
  "credit_usd": 5,
  "period_days": 30
}
```

---

## 5.8 NVIDIA NIM API Catalog

**Rating:** 4.7/5  
**Free classification:** `provider_specific_free` / `promotional_free`  
**Best use:** Free prototype endpoints, Nemotron, DeepSeek, multimodal, speech, open models.

### URLs

- Model catalog:
  https://build.nvidia.com/models
- NVIDIA models:
  https://build.nvidia.com/nvidia
- API catalog:
  https://build.nvidia.com/
- NIM docs:
  https://docs.nvidia.com/nim/

### Current catalog behavior

NVIDIA's catalog has a **Free Endpoint** filter and currently exposes dozens of models flagged as free endpoints.

Examples observed around verification time include:

```text
DeepSeek V4 Flash
Nemotron 3.5 Lightning
Muse Glimmer
Nemotron 3 Ultra
translation / voice / specialist models
```

### Typical OpenAI-compatible request

Many NIM endpoints use:

```text
https://integrate.api.nvidia.com/v1/
```

Example:

```bash
curl -fsSL https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3.5-lightning-30b-a3b",
    "messages": [{"role":"user","content":"ping"}],
    "max_tokens": 8
  }'
```

### Caveat

"Free Endpoint" is a provider entitlement, not a guarantee of permanent unrestricted zero-cost service. Refresh frequently.

---

## 5.9 Cerebras Inference

**Rating:** 4.5/5  
**Free classification:** `trial_credit`  
**Best use:** Extremely fast inference and public machine-readable model catalog.

### URLs

- Pricing: https://www.cerebras.ai/pricing
- Inference docs: https://inference-docs.cerebras.ai/
- Public models endpoint docs:
  https://inference-docs.cerebras.ai/api-reference/models/public-models
- Public models endpoint:
  https://api.cerebras.ai/public/v1/models

### Free semantics

Cerebras currently advertises a **$5 free trial credit** after account creation.

Do not classify as a permanent free tier.

### Public model catalog

No key is required for the public catalog:

```bash
curl -fsSL https://api.cerebras.ai/public/v1/models \
  | jq '.data[] | {
      id,
      owned_by,
      name,
      description,
      pricing,
      context_length,
      capabilities
    }'
```

### Why this endpoint is excellent

It includes:

```text
canonical-ish model IDs
Hugging Face ID
pricing
context length
capabilities
```

which makes it useful even after credits expire.

---

## 5.10 Cohere

**Rating:** 4.3/5  
**Region/company:** Canada  
**Free classification:** `trial_quota`  
**Best use:** Chat, coding, embeddings, reranking, multilingual.

### URLs

- Rate limits:
  https://docs.cohere.com/v1/docs/rate-limits
- Models:
  https://docs.cohere.com/docs/models
- API reference:
  https://docs.cohere.com/reference/about
- Dashboard:
  https://dashboard.cohere.com/

### Free semantics

Cohere provides **evaluation/trial keys**.

Official docs currently state trial keys are generally limited and newer Chat variants are typically limited to approximately:

```text
20 requests/minute
1,000 API calls/month
```

depending on endpoint/model.

### Classification

```json
{
  "free_type": "trial_quota",
  "production_suitable": false
}
```

Do not treat Cohere trial keys as permanent production-free capacity.

---

# 6. Meta-catalog / discovery sources

---

## 6.1 free-llm-api-resources

**Rating:** 4.0/5  
**Role:** Discovery list only  
**Repository:** https://github.com/cheahjs/free-llm-api-resources

> The repository may also be mirrored/forked. Always verify the current canonical upstream before wiring automation to it.

### Why it is useful

Community-maintained lists are often the fastest place to discover:

- newly launched providers
- promotions
- rate-limit changes
- obscure international services
- free API programs

### Clone

```bash
git clone https://github.com/cheahjs/free-llm-api-resources.git
cd free-llm-api-resources
```

### Search providers

```bash
grep -RniE \
  'Groq|Cerebras|Mistral|NVIDIA|Alibaba|SambaNova|SiliconFlow|Cloudflare|OpenRouter' \
  .
```

### Caveat

Community sources become stale quickly.

Recommended policy:

```text
community source discovers candidate
        ↓
official provider documentation verifies candidate
        ↓
live API probe verifies callable model
        ↓
candidate enters production free pool
```

---

# 7. International provider watchlist

These should be checked regularly because free tiers/promotions change more frequently.

| Provider | Region / origin | Why monitor | Suggested verification |
|---|---|---|---|
| **SambaNova Cloud** | US, serves many open/global models | High-speed hosted inference | Official models/pricing docs + live `/v1/models` |
| **SiliconFlow** | China | Large Chinese/open model catalog | Official pricing/free model pages |
| **ModelScope / DashScope** | China | Alibaba/Qwen ecosystem | Official Model Studio docs |
| **Tencent Cloud / Hunyuan** | China | Strong multilingual/model ecosystem | Tencent Cloud AI docs |
| **BytePlus / ByteDance** | Singapore/China | Seed/Doubao ecosystem | BytePlus model docs |
| **MiniMax** | China/global | Strong long-context + multimodal | Official API docs |
| **Moonshot / Kimi** | China/global | Long-context models | Official API docs |
| **DeepSeek** | China | Frontier open/low-cost models | Official platform + hosting providers |
| **StepFun** | China | Step model family | Official API docs |
| **01.AI / Yi** | China | Open-weight model family | HF + official hosting |
| **InclusionAI** | China/global | Ling family | OpenRouter/HF/provider docs |
| **Novita AI** | Global | Broad open-model hosting | Official model catalog |
| **Nebius AI Studio** | Europe/global | Hosted open models | Official AI Studio docs |
| **Scaleway Generative APIs** | France/EU | EU inference source | Official model/pricing docs |
| **OVHcloud AI Endpoints** | France/EU | EU inference | Official endpoint catalog |
| **Public AI** | Europe | Open/public AI infrastructure | HF/provider docs |
| **Featherless AI** | Global | Huge open-model catalog | Provider catalog/HF mappings |
| **Fireworks AI** | US/global | Open models, strong serverless | Official model list |
| **Together AI** | US/global | Large open model selection | Official model list |
| **DeepInfra** | EU/US/global | Very broad model catalog | Official models/pricing |
| **Hyperbolic** | Global | Open-model inference | Official API docs |
| **Baseten** | US/global | Hosted models | Official catalog |
| **AI21** | Israel | Jamba family | Official API docs |
| **Upstage** | South Korea | Solar family | Official API docs |
| **Naver / HyperCLOVA** | South Korea | Korean-language ecosystem | Naver Cloud docs |
| **Sakana AI ecosystem** | Japan | Interesting open research models | Official releases/HF |
| **Preferred Networks** | Japan | Japanese AI ecosystem | Official model releases |
| **Sarvam AI** | India | Indian-language models | Official API/pricing |
| **Krutrim** | India | Indian model ecosystem | Official developer docs |
| **SDAIA / ALLaM** | Saudi Arabia | Arabic-focused models | HF + official deployments |
| **Fal.ai** | Global | Image/video model APIs | HF/provider catalog |
| **Replicate** | Global | Broad model execution | Official catalog |
| **Nscale** | UK/Europe | Hosted open models | HF mappings + official docs |

### Policy for watchlist providers

Do not automatically add to a "free" lane unless one of the following is confirmed:

```text
1. official pricing == $0
2. official recurring free quota exists
3. official trial quota exists and is classified as trial
4. provider API explicitly marks endpoint free
```

---

# 8. Practical harvesting commands

## Pull the four core catalogs

```bash
mkdir -p model-sources
cd model-sources

curl -fsSL https://models.dev/catalog.json \
  -o models-dev.json

curl -fsSL https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -o openrouter-models.json

curl -fsSL 'https://huggingface.co/api/models?inference_provider=all&limit=1000' \
  -o huggingface-provider-models.json

curl -fsSL \
  https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json \
  -o litellm-models.json
```

## Pull direct provider catalogs

```bash
curl -fsSL \
  "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  -o google-gemini-models.json

curl -fsSL https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -o groq-models.json

curl -fsSL https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -o mistral-models.json

curl -fsSL https://api.cerebras.ai/public/v1/models \
  -o cerebras-models.json

curl -fsSL https://ai-gateway.vercel.sh/v1/models \
  -o vercel-models.json
```

## Validate every JSON file

```bash
for f in *.json; do
  if jq empty "$f" >/dev/null 2>&1; then
    echo "OK  $f"
  else
    echo "BAD $f"
  fi
done
```

---

# 9. Suggested normalization pipeline

```text
models.dev
    │
    ├── canonical model ID
    ├── lab
    ├── context
    ├── capabilities
    └── open/closed weights
           │
           ▼
OpenRouter + Hugging Face
    │
    ├── serving providers
    ├── provider model IDs
    ├── live/free variants
    ├── pricing
    └── performance metadata
           │
           ▼
LiteLLM
    │
    ├── LiteLLM provider names
    ├── routing IDs
    ├── context/cost normalization
    └── endpoint compatibility
           │
           ▼
Official provider verification
    │
    ├── free tier type
    ├── rate limits
    ├── billing requirements
    ├── expiry
    ├── region
    └── hard-stop / no-charge option
           │
           ▼
Canonical free_model_registry
           │
           ├── smart-general
           ├── smart-coding
           ├── smart-agent
           ├── smart-deep
           ├── smart-long
           ├── smart-vision
           ├── smart-image
           ├── smart-speech
           └── smart-embedding
```

---

# 10. Recommended scoring system

Use separate scores instead of one generic rating.

```json
{
  "source_quality": 5,
  "free_durability": 4,
  "model_quality": 5,
  "availability": 4,
  "automation_quality": 5,
  "privacy": 3,
  "international_access": 5
}
```

Suggested definitions:

### Source quality

| Score | Meaning |
|---:|---|
| 5 | Official live API/docs |
| 4 | High-quality normalized catalog |
| 3 | Maintained community catalog |
| 2 | Secondary article/list |
| 1 | Unverified |

### Free durability

| Score | Meaning |
|---:|---|
| 5 | Ongoing recurring free allocation |
| 4 | Durable rate-limited free plan |
| 3 | Recurring dollar credit |
| 2 | Time-limited trial |
| 1 | Promotion / uncertain |
| 0 | Paid only |

### Automation quality

| Score | Meaning |
|---:|---|
| 5 | Public JSON API / structured endpoint |
| 4 | Authenticated JSON API |
| 3 | Structured docs/static JSON |
| 2 | HTML table |
| 1 | Manual-only |

---

# 11. Free-status verification logic

A safe decision tree:

```text
Does official provider API/docs say the model is free?
│
├─ YES
│   │
│   ├─ permanent/recurring?
│   │      ├─ yes → recurring_free_quota/free_rate_limited
│   │      └─ no  → promotional_free
│   │
│   └─ quota expires?
│          ├─ yes → trial_quota
│          └─ no  → provider_specific_free
│
└─ NO
    │
    ├─ recurring account credit?
    │      └─ yes → recurring_credit
    │
    ├─ one-time signup credit?
    │      └─ yes → trial_credit
    │
    ├─ open weights only?
    │      └─ yes → open_weight_self_hosted
    │
    └─ otherwise → NOT FREE
```

---

# 12. Do not confuse these concepts

## Open-weight

The model weights can be downloaded.

Example:

```text
Qwen / Llama / Gemma / Nemotron model weights
```

This does **not** mean hosted inference is free.

## Zero-price provider endpoint

A specific provider currently serves the model for $0.

Example:

```text
OpenRouter some-model:free
```

This can disappear.

## Recurring free tier

A provider gives a quota every day/month.

Example:

```text
Cloudflare Workers AI daily Neurons
Google Gemini free tier
Groq free-plan limits
```

This is the most valuable class for a long-running router.

## Trial credit

A one-time allocation.

Example:

```text
Cerebras $5 signup trial
Alibaba 90-day per-model quota
```

Useful for testing, but not durable production capacity.

---

# 13. Freshness strategy

Recommended update schedule:

| Source | Refresh |
|---|---|
| OpenRouter free models | 6 hours |
| OpenRouter all models | 12 hours |
| models.dev | daily |
| Hugging Face provider mappings | daily |
| LiteLLM registry | daily |
| Groq models | daily |
| Groq limits | daily |
| Google models | daily |
| Google pricing/free-tier docs | weekly |
| Cloudflare pricing/models | weekly |
| Mistral models | daily |
| Z.AI pricing | daily |
| Alibaba quota tables | weekly |
| NVIDIA free endpoint catalog | daily |
| Vercel model catalog | daily |
| community discovery repos | daily/weekly |

Store:

```text
first_seen_at
last_seen_at
last_verified_at
free_since
free_until
source_url
source_grade
```

Never delete a disappeared model immediately. Mark:

```text
status = unavailable
```

and retain history.

---

# 14. Recommended production acceptance rule

A model should enter your **automatic free production pool** only if:

```text
✓ model appears in a live provider catalog
✓ a live API probe succeeds
✓ free status has an A/A+ source
✓ provider/model ID is normalized
✓ context window is known
✓ modalities are known
✓ tool-calling requirement is known
✓ expiry/trial status is known
✓ billing-overage behavior is known
✓ last verification is recent
```

For a trial model:

```text
production_pool = false
experimental_pool = true
```

unless the project explicitly wants trial credits in routing.

---

# 15. Recommended source precedence

When sources disagree:

```text
1. Provider live API
2. Provider official pricing/rate-limit docs
3. Provider official model docs
4. models.dev
5. Hugging Face provider metadata
6. OpenRouter metadata
7. LiteLLM registry
8. Community source
```

A lower-priority source must never overwrite a higher-priority verified value without a timestamp/newer official source.

---

# 16. Suggested SQL-like source model

```sql
CREATE TABLE model_sources (
    source_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    base_url TEXT,
    api_url TEXT,
    authority_grade TEXT,
    refresh_hours INTEGER,
    enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE provider_models (
    provider TEXT NOT NULL,
    provider_model_id TEXT NOT NULL,
    canonical_model_id TEXT,
    free_type TEXT,
    free_access BOOLEAN,
    input_price REAL,
    output_price REAL,
    context_length INTEGER,
    tools BOOLEAN,
    vision BOOLEAN,
    reasoning BOOLEAN,
    structured_output BOOLEAN,
    region TEXT,
    expires_at TIMESTAMP,
    first_seen_at TIMESTAMP,
    last_seen_at TIMESTAMP,
    last_verified_at TIMESTAMP,
    source_id TEXT,
    source_url TEXT,
    PRIMARY KEY(provider, provider_model_id)
);
```

---

# 17. Minimum first-wave providers to integrate

For a serious free-model router, prioritize:

```text
Tier 1
------
Google Gemini
Groq
OpenRouter
Cloudflare Workers AI
Mistral
Z.AI
NVIDIA NIM

Tier 2
------
Alibaba Model Studio
Vercel AI Gateway
Cerebras
Cohere

Discovery / expansion
---------------------
Hugging Face Inference Providers
models.dev
LiteLLM registry
SambaNova
SiliconFlow
Novita
Nebius
Scaleway
OVHcloud
Together
Fireworks
DeepInfra
Featherless
Hyperbolic
Baseten
AI21
Upstage
Sarvam
Tencent
BytePlus
MiniMax
Moonshot
StepFun
```

---

# 18. Reference URLs

## Canonical / aggregator sources

```text
https://models.dev/
https://models.dev/api.json
https://models.dev/models.json
https://models.dev/catalog.json
https://models.dev/providers/
https://models.dev/labs/

https://openrouter.ai/models
https://openrouter.ai/collections/free-models
https://openrouter.ai/openrouter/free
https://openrouter.ai/api/v1/models
https://openrouter.ai/docs/api/api-reference/models/get-models

https://huggingface.co/docs/inference-providers/
https://huggingface.co/docs/inference-providers/hub-api
https://huggingface.co/api/models
https://router.huggingface.co/v1/models

https://github.com/BerriAI/litellm
https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.schema.json

https://github.com/cheahjs/free-llm-api-resources
```

## Direct providers

```text
Google
https://ai.google.dev/gemini-api/docs/pricing
https://ai.google.dev/gemini-api/docs/rate-limits
https://ai.google.dev/api/models
https://generativelanguage.googleapis.com/v1beta/models

Groq
https://console.groq.com/docs/models
https://console.groq.com/docs/rate-limits
https://api.groq.com/openai/v1/models

Cloudflare
https://developers.cloudflare.com/workers-ai/
https://developers.cloudflare.com/workers-ai/models/
https://developers.cloudflare.com/workers-ai/platform/pricing/

Mistral
https://docs.mistral.ai/
https://docs.mistral.ai/api/endpoint/models
https://api.mistral.ai/v1/models

Z.AI
https://docs.z.ai/
https://docs.z.ai/guides/overview/pricing
https://z.ai/model-api

Alibaba
https://www.alibabacloud.com/help/en/model-studio/new-free-quota
https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing
https://modelstudio.console.alibabacloud.com/

Vercel
https://vercel.com/docs/ai-gateway/models-and-providers
https://ai-gateway.vercel.sh/v1/models
https://vercel.com/ai-gateway/models

NVIDIA
https://build.nvidia.com/models
https://build.nvidia.com/
https://docs.nvidia.com/nim/
https://integrate.api.nvidia.com/v1/

Cerebras
https://www.cerebras.ai/pricing
https://inference-docs.cerebras.ai/
https://api.cerebras.ai/public/v1/models

Cohere
https://docs.cohere.com/v1/docs/rate-limits
https://docs.cohere.com/docs/models
https://dashboard.cohere.com/
```

---

# 19. Final recommendation

If this registry will drive a real router, use **models.dev as the canonical model universe**, then enrich it with:

```text
OpenRouter
    → current hosted free variants

Hugging Face
    → provider/model mappings and international discovery

LiteLLM
    → routing/provider normalization

Direct provider APIs/docs
    → authoritative free status, rate limits, region, expiry
```

The production rule should be:

```text
DISCOVER broadly
NORMALIZE centrally
VERIFY officially
PROBE live
ROUTE only after verification
```

That is substantially safer than building a static spreadsheet of models that were free at one point in time.

---

## Verification note

Information in this file was checked against current public provider documentation and model APIs on **2026-09-11**. Free tiers and promotional models are volatile. The automation should treat all free-status data as time-sensitive and retain `last_verified_at` plus the original source URL.
