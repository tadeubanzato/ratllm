import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/server/config",()=>({env:{LITELLM_BASE_URL:"http://environment",LITELLM_MASTER_KEY:"environment-secret",CREDENTIAL_ENCRYPTION_KEY:"test-encryption-key-at-least-32-characters"}}));
const storage=vi.hoisted(()=>({value:{} as Record<string,unknown>}));
vi.mock("@/server/db/client",()=>({getDb:()=>({select:()=>({from:()=>({where:async()=>[{value:storage.value}]})}),insert:()=>({values:(row:{value:Record<string,unknown>})=>({onConflictDoUpdate:async()=>{storage.value=row.value}})})})}));
import { connectionConfig, connectionError, connectionInput, connectionSummary, saveConnection } from "../src/server/settings/connections";
import { HttpLiteLLMAdapter } from "../src/server/litellm/client";
import { encryptCredential } from "../src/server/credentials/crypto";
afterEach(()=>{storage.value={};vi.unstubAllGlobals()});
describe("connection credential boundary",()=>{
 it("encrypts saved credentials, resolves them server-side, and omits them from summaries",async()=>{
   await saveConnection("litellm",{baseUrl:"http://saved",masterKey:"replacement-secret"});
   expect(JSON.stringify(storage.value)).not.toContain("replacement-secret");
   expect(await connectionConfig("litellm")).toEqual({baseUrl:"http://saved",key:"replacement-secret"});
   const summary=JSON.stringify(await connectionSummary("litellm"));
   expect(summary).not.toContain("replacement-secret");expect(summary).not.toContain("encryptedMasterKey");
 });
 it("uses saved LiteLLM configuration for deployment requests",async()=>{
   storage.value={baseUrl:"http://saved",encryptedMasterKey:encryptCredential("saved-secret")};
   const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[]})));vi.stubGlobal("fetch",fetch);
   await new HttpLiteLLMAdapter().listDeployments();
   expect(fetch.mock.calls[0][0]).toBe("http://saved/v1/model/info");expect(fetch.mock.calls[0][1].headers.authorization).toBe("Bearer saved-secret");
 });
 it("rejects URLs containing credentials or query secrets",()=>{
   for(const baseUrl of ["http://user:secret@host","http://host?key=secret","file:///secret"])expect(connectionInput.safeParse({baseUrl}).success).toBe(false);
 });
 it("returns actionable errors without arbitrary exception contents",()=>{
   expect(connectionError({message:"secret",cause:{code:"ECONNREFUSED"}})).toContain("Connection refused");
   expect(connectionError(new Error("secret"))).not.toContain("secret");
 });
});
