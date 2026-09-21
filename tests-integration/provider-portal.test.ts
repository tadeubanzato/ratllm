import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { providerOffers, providers } from "@/server/db/schema";
import { listProviderSettings } from "@/server/providers/registry";
import { getProvider } from "@/server/queries";

const provider = async (slug: string, name: string, docsUrl: string | null) => {
  const row = (await getDb().insert(providers).values({ slug, name, adapterKey: "openai-compatible", adapterCapability: "AUTOMATED" }).returning())[0];
  if (docsUrl !== null) await getDb().insert(providerOffers).values({ providerId: row.id, source: "models_dev", docsUrl });
  return row;
};

describe("where a provider sends you to get a key", () => {
  it("uses the curated page, else the provider it is another spelling of, else the docs a source published, else nothing — on both the detail page and the Settings list", async () => {
    const groq = await provider("groq", "Groq", "https://console.groq.com/docs");
    const vertex = await provider("vertex", "Vertex", "https://cloud.google.com/vertex-ai/docs");
    const gateway = await provider("some-gateway", "Some Gateway", "https://docs.some-gateway.example/start");
    const bare = await provider("bare-provider", "Bare Provider", null);

    const detail = async (row: { id: string }) => (await getProvider(row.id))!;
    expect((await detail(gateway)).docsUrl).toBe("https://docs.some-gateway.example/start");
    expect((await detail(bare)).docsUrl).toBeNull();

    const settings = new Map((await listProviderSettings()).map(row => [row.slug, row.portal]));
    expect(settings.get("groq")).toEqual({ url: "https://console.groq.com/keys", label: "Generate API key" });
    expect(settings.get("vertex")?.label).not.toBe("Open provider docs");                    // an alias of vertex-ai: a real console page
    expect(settings.get("some-gateway")).toEqual({ url: "https://docs.some-gateway.example/start", label: "Open provider docs" });
    expect(settings.get("bare-provider")).toBeNull();
    void groq; void vertex;
  });
});
