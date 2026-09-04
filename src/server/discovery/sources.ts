import "server-only";
import { z } from "zod";
import type { DiscoveredCandidate,DiscoverySource } from "./types";
import { resolveProvider } from "@/server/providers/catalog";

const OPENROUTER_URL="https://openrouter.ai/api/v1/models";
const COST_MAP_URL="https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json";
const COMMUNITY_URLS=["https://raw.githubusercontent.com/AILookup/free-llm-resources/main/README.md","https://raw.githubusercontent.com/zukixa/cool-ai-stuff/main/README.md"] as const;

async function getJson(url:string){const response=await fetch(url,{headers:{accept:"application/json","user-agent":"okame-model-curator/0.1"},signal:AbortSignal.timeout(30_000),cache:"no-store"});if(!response.ok)throw new Error(`${url} returned ${response.status}`);return response.json() as Promise<unknown>}
async function getText(url:string){const response=await fetch(url,{headers:{accept:"text/plain","user-agent":"okame-model-curator/0.1"},signal:AbortSignal.timeout(30_000),cache:"no-store"});if(!response.ok)throw new Error(`${url} returned ${response.status}`);return response.text()}
const numberValue=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?Math.round(value):undefined;

export class OpenRouterSource implements DiscoverySource {
  readonly id="openrouter" as const;
  async discover(){const raw=z.object({data:z.array(z.record(z.string(),z.unknown()))}).parse(await getJson(OPENROUTER_URL));return raw.data.flatMap((row):DiscoveredCandidate[]=>{const id=typeof row.id==="string"?row.id:"";const pricing=row.pricing&&typeof row.pricing==="object"?row.pricing as Record<string,unknown>:{};const free=id.endsWith(":free")||Number(pricing.prompt)===0&&Number(pricing.completion)===0;if(!id||!free)return [];const architecture=row.architecture&&typeof row.architecture==="object"?row.architecture as Record<string,unknown>:{};return [{source:this.id,modelRef:id,displayName:typeof row.name==="string"?row.name:id,providerName:"OpenRouter",freeType:"FREE_TIER",verifiedFree:true,contextWindow:numberValue(row.context_length),supportsVision:Array.isArray(architecture.input_modalities)&&architecture.input_modalities.includes("image"),sourceUrl:OPENROUTER_URL,evidence:{catalogPriceZero:true,variantFree:id.endsWith(":free"),lastCatalogCheck:new Date().toISOString()}}]});}
}

export class LiteLLMCostMapSource implements DiscoverySource {
  readonly id="litellm-cost-map" as const;
  async discover(){const raw=z.record(z.string(),z.unknown()).parse(await getJson(COST_MAP_URL));const out:DiscoveredCandidate[]=[];for(const [id,value] of Object.entries(raw)){if(!value||typeof value!=="object")continue;const info=value as Record<string,unknown>;if(info.mode!=="chat"||info.input_cost_per_token!==0||info.output_cost_per_token!==0)continue;const provider=typeof info.litellm_provider==="string"?info.litellm_provider:undefined;if(["ollama","bedrock","sagemaker"].includes(provider??""))continue;out.push({source:this.id,modelRef:id,displayName:id,providerName:provider,freeType:"UNKNOWN",verifiedFree:false,contextWindow:numberValue(info.max_input_tokens??info.max_tokens),maxOutputTokens:numberValue(info.max_output_tokens),supportsVision:Boolean(info.supports_vision),supportsTools:Boolean(info.supports_function_calling),supportsReasoning:Boolean(info.supports_reasoning),sourceUrl:COST_MAP_URL,evidence:{zeroCostCatalogEntry:true,mode:"chat"}})}return out;}
}

const familyPattern=/(?:[a-z0-9._-]+\/(?:qwen|deepseek|glm|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-)[a-z0-9._:+/-]*|(?:qwen|tongyi|deepseek|glm|zhipu|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-)[a-z0-9._:+/-]*)/gi;
export class CommunityListsSource implements DiscoverySource {
  readonly id="community-lists" as const;
  async discover(){const settled=await Promise.allSettled(COMMUNITY_URLS.map(async url=>({url,text:await getText(url)})));const seen=new Set<string>();const out:DiscoveredCandidate[]=[];for(const result of settled){if(result.status!=="fulfilled")continue;const {url,text}=result.value;for(const [index,raw] of text.split("\n").entries()){if(!/(?:free|免费|\$0|no credit card|free tier|free quota|trial credit)/i.test(raw))continue;for(const match of raw.matchAll(familyPattern)){const id=match[0].replace(/^[`'"\[({<]+|[`'"\])}>.,;:|]+$/g,"");if(id.length<4||seen.has(id.toLowerCase()))continue;seen.add(id.toLowerCase());const provider=resolveProvider(null,id);out.push({source:this.id,modelRef:id,displayName:id,providerName:provider?.name,freeType:"UNKNOWN",verifiedFree:false,sourceUrl:url,evidence:{line:index+1,excerpt:raw.trim().slice(0,500),providerResolution:provider?{slug:provider.slug,method:"model-family"}:undefined}})}}}return out;}
}

export const discoverySources:readonly DiscoverySource[]=[new OpenRouterSource(),new LiteLLMCostMapSource(),new CommunityListsSource()];
