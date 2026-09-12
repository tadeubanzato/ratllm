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
| 2 | **Artificial Analysis** | 5.0/5 | Independent quality, pricing, speed, latency, provider intelligence | Excellent |
| 3 | **Epoch AI Models Database** | 5.0/5 | Research-grade global model identity, developer, country, release/training metadata | Excellent |
| 4 | **OpenRouter** | 5.0/5 | Live hosted models + explicit free variants | Excellent |
| 5 | **Hugging Face Inference Providers** | 5.0/5 | Global model/provider graph | Excellent |
| 6 | **ModelScope** | 4.9/5 | Searchable China/Asia-heavy global open-model hub | Excellent |
| 7 | **LLM Stats / ZeroEval** | 4.8/5 | Searchable models, providers, pricing, benchmarks and rankings | Excellent |
| 8 | **LiteLLM model registry** | 4.8/5 | Normalized provider/pricing/context metadata | Excellent |
| 9 | **LMArena / Arena-Rank** | 4.8/5 | Human-preference rankings across frontier models | Good |
| 10 | **OpenCompass / CompassArena** | 4.8/5 | China/global benchmark coverage + human-preference arena | Good |
| 11 | **Stanford HELM** | 4.6/5 | Reproducible research-grade benchmark validation | Good; maintenance mode |
| 12 | **Google Gemini API** | 5.0/5 | Direct recurring free tier | Excellent |
| 13 | **GroqCloud** | 5.0/5 | Direct free inference + explicit rate limits | Excellent |
| 14 | **Cloudflare Workers AI** | 5.0/5 | Recurring daily free compute | Very good |
| 15 | **Mistral AI Studio** | 4.8/5 | EU provider, free API mode | Excellent |
| 16 | **Z.AI / Zhipu AI** | 4.8/5 | Direct $0 Chinese GLM models | Very good |
| 17 | **Alibaba Model Studio** | 4.8/5 | Large per-model trial quotas, Qwen ecosystem | Very good |
| 18 | **Vercel AI Gateway** | 4.7/5 | Broad model/provider gateway + recurring credit | Excellent |
| 19 | **NVIDIA NIM API Catalog** | 4.7/5 | Many free endpoints and open models | Very good |
| 20 | **Cerebras Inference** | 4.5/5 | Fast inference, public catalog, trial credits | Excellent |
| 21 | **Cohere** | 4.3/5 | Trial API + chat/embed/rerank | Good |
| 22 | **HF Open LLM Leaderboard archive** | 3.8/5 | Historical reproducible open-model scores | Historical only |
| 23 | **free-llm-api-resources** | 4.0/5 | Provider discovery | Good, but verify |
| 24 | **Provider watchlist** | 3.5/5 | SambaNova, SiliconFlow, Novita, etc. | Verify individually |

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

## 4.5 Artificial Analysis

**Rating:** 5.0/5  
**Role:** Independent model/provider intelligence layer  
**Region:** Independent/global coverage  
**Best use:** Quality, price, speed, latency, context, provider availability and cross-provider comparison.  
**Free-status authority:** No — use provider docs for entitlement/free-tier truth.

### URLs

- Main site: https://artificialanalysis.ai/
- Provider leaderboard: https://artificialanalysis.ai/leaderboards/providers
- Data API overview: https://artificialanalysis.ai/data-api
- API docs: https://artificialanalysis.ai/data-api/docs
- API reference: https://artificialanalysis.ai/api-reference
- API base: https://artificialanalysis.ai/api/v2

### Why it belongs in the core stack

Artificial Analysis independently measures real API endpoints rather than assuming that every provider serving the same model performs identically. It tracks model identity, pricing, intelligence/benchmark indices and median performance, and its commercial datasets add per-provider measurements and performance history.

This is particularly valuable for routing because the same underlying model can differ substantially by host in:

```text
output tokens/sec
time-to-first-token
end-to-end latency
context window
price
provider availability
```

### Free API

The official API has a free access tier for public model-level data. Access requires an API key and attribution. The current free endpoint includes headline model indices, median performance and input/output pricing. API limits and available fields can change by plan, so store the returned tier and rate-limit headers.

### Bash — language model catalog

```bash
curl -fsSL \
  'https://artificialanalysis.ai/api/v2/language/models' \
  -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" \
  | jq .
```

### Extract useful routing fields

```bash
curl -fsSL \
  'https://artificialanalysis.ai/api/v2/language/models' \
  -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" \
  | jq '.data[]'
```

Field names can evolve; inspect the current schema before hard-coding parsers.

### Recommended role in your registry

```text
model_quality_signal      = excellent
provider_performance      = excellent
pricing_crosscheck        = excellent
canonical_identity        = strong
free_tier_verification    = no
```

### Refresh

```text
Models/price/performance: daily
Provider performance: daily if your subscription exposes it
```

---

## 4.6 Epoch AI Models Database

**Rating:** 5.0/5  
**Role:** Research-grade canonical model history/identity source  
**Region:** Global  
**Best use:** Developer/lab identity, country, release date, parameters, training compute, dataset size, hardware, accessibility and historical lineage.  
**Free-status authority:** No.

### URLs

- Model explorer: https://epoch.ai/models/search
- Dataset overview: https://epoch.ai/data/ai-models
- Documentation: https://epoch.ai/data/ai-models-documentation
- Records/field definitions: https://epoch.ai/data/ai-models-documentation/records
- Downloads: https://epoch.ai/data/ai-models-documentation/downloads
- All models CSV: https://epoch.ai/data/all_ai_models.csv

### Why it is trustworthy

Epoch AI documents inclusion criteria, field definitions, estimation methodology, supporting evidence and update procedures. Its hosted CSV is synchronized daily and released under a Creative Commons Attribution license.

Its model explorer is particularly useful for preventing a US-centric registry. It includes developers such as Alibaba, DeepSeek, Z.ai, Moonshot, MiniMax, Tsinghua University, Peking University, Xiaomi, Baichuan, Technology Innovation Institute, Mistral, Cohere and many others.

### Bash — download the complete dataset

```bash
curl -fsSL \
  https://epoch.ai/data/all_ai_models.csv \
  -o epoch-all-ai-models.csv
```

### Bash — inspect columns

```bash
python - <<'PY'
import pandas as pd
p='epoch-all-ai-models.csv'
df=pd.read_csv(p)
print('\n'.join(df.columns))
PY
```

### Python — search globally by any text field

```python
import pandas as pd

df = pd.read_csv('https://epoch.ai/data/all_ai_models.csv')
term = 'Alibaba'
mask = df.astype(str).apply(
    lambda col: col.str.contains(term, case=False, na=False)
).any(axis=1)
print(df.loc[mask].to_string(index=False))
```

### Recommended role

```text
canonical_model_identity  = excellent
lab/developer_identity    = excellent
country/origin            = excellent
release_history           = excellent
training_metadata         = excellent
serving_provider_mapping  = limited
free_api_truth            = no
```

### Refresh

```text
daily
```

---

## 4.7 LLM Stats / ZeroEval

**Rating:** 4.8/5  
**Role:** Searchable model/provider/benchmark intelligence API  
**Best use:** Model discovery, provider pricing, context lengths, benchmark scores, rankings and category-level comparison.  
**Free-status authority:** No — validate free access with the serving provider.

### URLs

- Main site: https://llm-stats.com/
- Provider browser: https://llm-stats.com/providers
- Developer/API docs: https://llm-stats.com/developer
- API base: https://api.zeroeval.com/stats/v1
- Models endpoint: https://api.zeroeval.com/stats/v1/models
- ZeroEval docs: https://github.com/zeroeval/llm-stats-docs

### What it provides

The data API exposes hundreds of models and dozens of verified benchmarks, including model identity, organization/developer, serving providers, input/output pricing, context length, benchmark scores, category scores and rankings.

### Bash — search models

```bash
curl -fsSL \
  -H "Authorization: Bearer $LLM_STATS_API_KEY" \
  'https://api.zeroeval.com/stats/v1/models?limit=100' \
  | jq .
```

### Bash — filter by organization

```bash
curl -fsSL \
  -H "Authorization: Bearer $LLM_STATS_API_KEY" \
  'https://api.zeroeval.com/stats/v1/models?organization=anthropic&limit=20' \
  | jq '.models[] | {id,name,organization,providers,top_scores}'
```

### Useful endpoints

```text
GET /stats/v1/models
GET /stats/v1/models/{id}
GET /stats/v1/benchmarks
GET /stats/v1/scores
GET /stats/v1/rankings
GET /stats/v1/updates
```

### Recommended role

```text
model_search              = excellent
provider_discovery        = very_good
benchmark_crosscheck      = excellent
pricing_crosscheck        = very_good
free_status               = verify_elsewhere
```

### Refresh

```text
daily
```

---

## 4.8 LMArena / Arena-Rank

**Rating:** 4.8/5  
**Role:** Human-preference quality signal  
**Origin:** UC Berkeley research ecosystem; now operated as Arena/LMArena  
**Best use:** Determine whether users actually prefer one model over another in blind head-to-head comparisons.  
**Free-status authority:** No.

### URLs

- Leaderboards: https://lmarena.ai/leaderboard
- Text leaderboard: https://lmarena.ai/leaderboard/text
- Arena home: https://lmarena.ai/
- Arena-Rank methodology: https://arena.ai/blog/arena-rank
- Arena-Rank GitHub: https://github.com/lmarena/arena-rank
- Public preference dataset example: https://huggingface.co/datasets/lmarena-ai/arena-human-preference-140k

### Why it is valuable

Static benchmarks can be gamed, saturated or overfit. LMArena provides a complementary real-user signal through randomized pairwise battles. Do **not** treat Arena score as an objective universal intelligence score; treat it as one preference signal among several.

### Install the open ranking implementation

```bash
python -m pip install arena-rank datasets pandas
```

### Python — reproduce ratings from public preference data

```python
import pandas as pd
from datasets import load_dataset
from arena_rank.utils.data_utils import PairDataset
from arena_rank.models.bradley_terry import BradleyTerry

df = load_dataset(
    'lmarena-ai/arena-human-preference-140k',
    split='train'
).to_pandas()

dataset = PairDataset.from_pandas(df[['model_a','model_b','winner']])
model = BradleyTerry(n_competitors=len(dataset.competitors))
results = model.compute_ratings_and_cis(dataset, significance_level=0.05)
print(pd.DataFrame(results).sort_values('ratings', ascending=False).head(20))
```

### Recommended role

```text
human_preference_score    = excellent
quality_crosscheck        = excellent
provider_discovery        = weak
pricing                   = incidental
free_status               = no
```

### Caveat

Store vote counts and confidence/rank-spread information where available rather than only the ordinal rank.

---

## 4.9 OpenCompass / CompassArena

**Rating:** 4.8/5  
**Role:** Research-grade global benchmark and preference layer with strong China/Asia coverage  
**Organization:** OpenCompass / Shanghai AI Laboratory ecosystem  
**Best use:** Cross-check models underrepresented in Western benchmark/catalog sites, especially Chinese and multilingual models.  
**Free-status authority:** No.

### URLs

- OpenCompass GitHub: https://github.com/open-compass/opencompass
- Documentation: https://doc.opencompass.org.cn/
- CompassAcademic reproduction guide: https://doc.opencompass.org.cn/notes/academic.html
- CompassArena: https://arena.opencompass.org.cn/

### Why it belongs in a global registry

OpenCompass supports public/open models and API models and evaluates them across a broad suite of datasets. The CompassAcademic leaderboard publishes the configuration needed to reproduce results and is typically updated every couple of weeks.

CompassArena adds a human-preference signal using real conversations and Bradley-Terry ranking, providing a valuable non-Western complement to LMArena.

### Install OpenCompass

```bash
python -m pip install -U opencompass
```

Full optional dependencies:

```bash
python -m pip install 'opencompass[full]'
```

### Clone for configuration/data inspection

```bash
git clone https://github.com/open-compass/opencompass.git
cd opencompass
```

### Recommended role

```text
benchmark_validation      = excellent
china_model_coverage      = excellent
multilingual_validation   = very_good
human_preference_signal   = very_good
provider/free_status      = no
```

---

## 4.10 ModelScope

**Rating:** 4.9/5  
**Role:** Large searchable AI model hub and API/SDK, particularly valuable for China/Asia coverage  
**Best use:** Discover models, organizations, licenses, tasks, architectures, libraries, inference availability and assets that may appear later or less prominently on Western hubs.  
**Free-status authority:** No — inference availability is not the same thing as durable free inference.

### URLs

- Model browser: https://www.modelscope.cn/models
- International site: https://modelscope.ai/
- Official Hub SDK: https://github.com/modelscope/modelscope_hub
- Main ModelScope GitHub: https://github.com/modelscope/modelscope

### Search capabilities

The model browser supports filtering/search by model name, organization, task, license, architecture, tags, library/runtime and inference API state.

### OpenAPI — search models

```bash
export MODELSCOPE_ENDPOINT='https://www.modelscope.cn'

curl -fsSL \
  "$MODELSCOPE_ENDPOINT/openapi/v1/models?search=qwen&sort=downloads&page_size=20" \
  -H "Authorization: Bearer $MODELSCOPE_API_KEY" \
  | jq .
```

Expected model-list records include identifiers plus fields such as downloads, likes, license and tasks.

### Official Python SDK

```bash
python -m pip install modelscope-hub
```

```python
from modelscope_hub import HubApi

api = HubApi()
result = api.list_models(
    owner_or_group='Qwen',
    page_number=1,
    page_size=20,
)
for model in result['Models']:
    print(model['Path'], model.get('Downloads'))
```

### Recommended role

```text
asian_model_discovery     = excellent
open_model_search         = excellent
license/task_metadata     = very_good
model_assets              = excellent
provider/free_truth       = no
```

### Refresh

```text
daily
```

---

## 4.11 Stanford HELM

**Rating:** 4.6/5  
**Role:** Transparent, reproducible benchmark validation  
**Organization:** Stanford Center for Research on Foundation Models (CRFM)  
**Best use:** Independent benchmark results across capabilities, safety, long context, vision, medicine and other domains.  
**Free-status authority:** No.

### URLs

- HELM home: https://crfm.stanford.edu/helm/
- Capabilities leaderboard: https://crfm.stanford.edu/helm/capabilities/latest/
- Long-context leaderboard: https://crfm.stanford.edu/helm/long-context/latest/
- GitHub: https://github.com/stanford-crfm/helm
- PyPI: https://pypi.org/project/crfm-helm/

### Why it is reputable

HELM was designed around holistic, reproducible and transparent foundation-model evaluation. Results expose detailed scenarios, metrics, prompts and responses, making it useful for audit/cross-validation rather than simply accepting a single aggregate score.

### Current-status caveat

The HELM framework entered **maintenance mode on June 1, 2026**. Existing leaderboards and methodology remain valuable, but do not use HELM as the primary freshness source for newly released models.

### Install and run a reproducible test

```bash
python -m pip install crfm-helm

helm-run \
  --run-entries 'mmlu:subject=philosophy,model=openai/gpt2' \
  --suite my-suite \
  --max-eval-instances 10

helm-summarize --suite my-suite
```

### Recommended role

```text
benchmark_reproducibility = excellent
research_transparency     = excellent
fresh_model_discovery     = limited
pricing/provider mapping  = no
free_status               = no
```

---

## 4.12 Hugging Face Open LLM Leaderboard — historical/archive source

**Rating:** 3.8/5 current / 5.0/5 historical value  
**Role:** Historical reproducible benchmark archive for open-weight models  
**Current-source status:** **Do not use as a freshness source.**

### URLs

- Organization/archive: https://huggingface.co/open-llm-leaderboard
- Leaderboard space: https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard
- Results dataset: https://huggingface.co/datasets/open-llm-leaderboard/results

### Important caveat

The Open LLM Leaderboard was officially retired in **March 2025** because the maintainers considered the benchmark set increasingly obsolete for modern reasoning/assistant models. The datasets remain useful historical evidence but should not influence current production routing without fresher evaluations.

### Recommended role

```text
historical_open_model_score = useful
current_model_quality       = do_not_use_as_primary
free_status                 = no
```

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

## Pull global intelligence / benchmark catalogs

```bash
# Epoch AI
curl -fsSL https://epoch.ai/data/all_ai_models.csv -o epoch-all-ai-models.csv

# Artificial Analysis
curl -fsSL https://artificialanalysis.ai/api/v2/language/models \
  -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" \
  -o artificial-analysis-models.json

# LLM Stats / ZeroEval
curl -fsSL 'https://api.zeroeval.com/stats/v1/models?limit=100' \
  -H "Authorization: Bearer $LLM_STATS_API_KEY" \
  -o llm-stats-models.json

# ModelScope
curl -fsSL 'https://www.modelscope.cn/openapi/v1/models?search=qwen&sort=downloads&page_size=100' \
  -H "Authorization: Bearer $MODELSCOPE_API_KEY" \
  -o modelscope-qwen-models.json
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
| Artificial Analysis | daily |
| Epoch AI | daily |
| LLM Stats / ZeroEval | daily |
| ModelScope | daily |
| LMArena | daily/weekly |
| OpenCompass / CompassArena | weekly / every 1–2 weeks |
| Stanford HELM | monthly; maintenance mode |
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

## Global model intelligence / benchmark / regional discovery

```text
Artificial Analysis
https://artificialanalysis.ai/
https://artificialanalysis.ai/leaderboards/providers
https://artificialanalysis.ai/data-api
https://artificialanalysis.ai/data-api/docs
https://artificialanalysis.ai/api/v2

Epoch AI
https://epoch.ai/models/search
https://epoch.ai/data/ai-models
https://epoch.ai/data/ai-models-documentation
https://epoch.ai/data/ai-models-documentation/downloads
https://epoch.ai/data/all_ai_models.csv

LLM Stats / ZeroEval
https://llm-stats.com/
https://llm-stats.com/providers
https://llm-stats.com/developer
https://api.zeroeval.com/stats/v1/models

LMArena
https://lmarena.ai/
https://lmarena.ai/leaderboard
https://arena.ai/blog/arena-rank
https://github.com/lmarena/arena-rank
https://huggingface.co/datasets/lmarena-ai/arena-human-preference-140k

OpenCompass / CompassArena
https://github.com/open-compass/opencompass
https://doc.opencompass.org.cn/
https://doc.opencompass.org.cn/notes/academic.html
https://arena.opencompass.org.cn/

ModelScope
https://www.modelscope.cn/models
https://modelscope.ai/
https://github.com/modelscope/modelscope_hub
https://github.com/modelscope/modelscope

Stanford HELM
https://crfm.stanford.edu/helm/
https://crfm.stanford.edu/helm/capabilities/latest/
https://crfm.stanford.edu/helm/long-context/latest/
https://github.com/stanford-crfm/helm

HF Open LLM Leaderboard — archive/historical
https://huggingface.co/open-llm-leaderboard
https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard
https://huggingface.co/datasets/open-llm-leaderboard/results
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

# 19. Which source should answer which question?

| Question | First source | Cross-check | Never rely on alone |
|---|---|---|---|
| What is this model / who made it? | models.dev + Epoch AI | HF / ModelScope | Provider marketing name |
| What country/lab/ecosystem is it from? | Epoch AI | ModelScope / model card | OpenRouter slug |
| Is it open-weight? | models.dev + official model card | HF / ModelScope | Hosting price |
| Where can I call it? | OpenRouter + HF Inference Providers | models.dev / provider catalog | Benchmark sites |
| Is there a free endpoint? | Official provider pricing/docs | OpenRouter free route | `price=0` in generic catalog |
| Is the free tier durable or just a trial? | Official provider terms | Community discovery | Model name suffix |
| What is the context window? | Official provider/model docs | models.dev / LiteLLM | Old benchmark entry |
| Does it support tools/vision/JSON? | Provider API + models.dev | HF/OpenRouter/LiteLLM | Lab announcement alone |
| How good is it? | Artificial Analysis + LLM Stats | HELM/OpenCompass | Parameter count |
| Do real users prefer it? | LMArena + CompassArena | Artificial Analysis | Static benchmark alone |
| Which host is fastest? | Artificial Analysis provider data | Your own probe | Canonical model metadata |
| What models are popular in China/Asia? | ModelScope + OpenCompass | HF / Epoch AI | US-only aggregators |
| What should enter production routing? | Live probe + provider docs | all intelligence sources | Any static list |

---

# 20. Final recommendation

If this registry will drive a real router, use a **multi-source model-intelligence stack** rather than treating any single catalog as complete:

```text
models.dev + Epoch AI
    → canonical identity, labs/developers, model history and metadata

ModelScope + Hugging Face
    → global/open-model discovery with strong Asia + international coverage

OpenRouter
    → current hosted variants and explicit free routes

LiteLLM
    → routing/provider normalization

Artificial Analysis + LLM Stats
    → quality, benchmarks, pricing, speed/latency and provider cross-checks

LMArena + OpenCompass/CompassArena + Stanford HELM
    → independent preference/benchmark validation

Direct provider APIs/docs
    → authoritative free status, rate limits, billing behavior, region and expiry

Live API probes
    → final proof that the provider/model actually works right now
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
