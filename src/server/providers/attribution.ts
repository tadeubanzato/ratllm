import { normalizeProviderName, providerDefinitionBySlug, resolveProvider, type ProviderDefinition } from "./catalog";
import { providerWiring } from "./wiring";

/** docs/DISCOVERY-PIPELINE.md invariant I1: this is the ONE function that decides which provider a discovered model
 *  belongs to. Writers (discovery, consolidation) call it and store the answer as `provider_id`; readers use that stored
 *  id and never derive it again. Five copies of "guess the provider from text" used to disagree — one wiped what another
 *  wrote on every discovery run — which is exactly what a single decision point rules out. */
export interface ProviderIdentity extends ProviderDefinition {
  /** CATALOG: a provider providers/catalog.ts knows. DISCOVERED: named by a source and not (yet) in the catalog (I3). */
  origin: "CATALOG" | "DISCOVERED";
}

/** Names a source might emit when it has no real answer. Treating one as a provider would invent "Unknown" as a company. */
const NON_NAMES = new Set(["unknown", "n-a", "na", "none", "null", "undefined", "other", "others", "various", "misc", "test", "default"]);
const MAX_NAME_LENGTH = 80;

/** A source's provider label made presentable and safe to store, or null when it is not a usable name. */
export function cleanProviderName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  const slug = normalizeProviderName(name);
  if (!slug || slug.length > 64 || /^\d+$/.test(slug) || NON_NAMES.has(slug)) return null;
  return name;
}

/** `reportedName` is what the source called the provider ("W&B Inference", "Eden AI"); `modelRef` is only used as the
 *  catalog's corroborating hint when a source reports no name at all.
 *
 *  1. The catalog is authoritative for providers it knows (slug, alias, display name, corroborated model prefix).
 *  2. Otherwise a provider the source explicitly names is *derived* from that name. Only the source's own provider label
 *     counts: a routing prefix inside an aggregator's model id says which upstream the aggregator forwards to, not who
 *     lists the model (Eden AI's "deepinfra/…" ids are Eden AI's, not DeepInfra's).
 *  3. No usable name and no catalog match: unattributed (null), and the candidate carries a PROVIDER_UNRESOLVED blocker. */
export function attributeProvider(reportedName: string | null | undefined, modelRef: string): ProviderIdentity | null {
  const known = resolveProvider(reportedName, modelRef);
  if (known) return { ...known, origin: "CATALOG" };
  const name = cleanProviderName(reportedName);
  if (!name) return null;
  const slug = normalizeProviderName(name);
  return { slug, name, adapterKey: "manual", adapterCapability: "MANUAL", origin: "DISCOVERED" };
}

/** The identity of a catalog provider by slug, for sources that are one provider's own API and declare it in the registry. */
export function catalogIdentity(slug: string): ProviderIdentity | null {
  const definition = providerDefinitionBySlug(slug);
  return definition ? { ...definition, origin: "CATALOG" } : null;
}

/** Hosts that belong to exactly one catalog provider's known endpoints. A host shared by two providers is ambiguous and dropped. */
const hostOwners=(()=>{
  const owners=new Map<string,Set<string>>();
  for(const [slug,wiring] of Object.entries(providerWiring)){
    for(const url of [wiring.completions,wiring.check?.url]){
      if(!url)continue;
      try{const host=new URL(url).host.toLowerCase();(owners.get(host)??owners.set(host,new Set()).get(host)!).add(slug);}catch{/* not a URL */}
    }
  }
  const unique=new Map<string,string>();
  for(const [host,slugs] of owners)if(slugs.size===1)unique.set(host,[...slugs][0]!);
  return unique;
})();

/** The catalog provider that owns the host of a published base URL, if there is exactly one. A provider's own API host is
 *  stronger evidence than its marketing name. */
export function providerSlugForBaseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return hostOwners.get(new URL(url).host.toLowerCase()) ?? null; } catch { return null; }
}

/** The provider a source's free-offer entry describes: the same decision as attributeProvider, given more to go on. The
 *  catalog wins whichever way it is reached (name, then the dataset's own slug, then the host of the base URL it
 *  publishes); only when none match is a provider derived from the name. */
export function attributeOfferProvider(offer: { providerName: string; slugHint?: string | null; openaiBaseUrl?: string | null }): ProviderIdentity | null {
  const byName = attributeProvider(offer.providerName, "");
  if (byName?.origin === "CATALOG") return byName;
  const bySlug = offer.slugHint ? attributeProvider(offer.slugHint, "") : null;
  if (bySlug?.origin === "CATALOG") return bySlug;
  const byHost = providerSlugForBaseUrl(offer.openaiBaseUrl);
  const hosted = byHost ? catalogIdentity(byHost) : null;
  return hosted ?? byName;
}
