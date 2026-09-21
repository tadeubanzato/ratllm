import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/settings/connections", () => ({ connectionConfig: async () => ({ baseUrl: "http://litellm.test", key: "k" }) }));
import { HttpLiteLLMAdapter } from "../src/server/litellm/client";

const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const error = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });
const stub = (...replies: Response[]) => { const bodies: Array<{ stream?: boolean }> = []; const queue = [...replies]; vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return queue.shift()!; })); return bodies; };
const adapter = () => new HttpLiteLLMAdapter("http://litellm.test", "k");

afterEach(() => vi.unstubAllGlobals());

describe("HttpLiteLLMAdapter.smokeTest", () => {
  it("streams by default and reports a first-token time", async () => {
    const bodies = stub(sse("OK"));
    const result = await adapter().smokeTest("dep-1");
    expect(result).toMatchObject({ ok: true, status: 200, content: "OK" });
    expect(result.firstTokenMs).toBeDefined();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream).toBe(true);
  });

  it("asks again without streaming when the model cannot stream, and judges it on that answer", async () => {
    const bodies = stub(error(400, "litellm.BadRequestError: OpenAIException - text classification models do not support streaming"), new Response(JSON.stringify({ choices: [{ message: { content: "0.0003" } }] }), { status: 200 }));
    const result = await adapter().smokeTest("dep-1");
    expect(result).toMatchObject({ ok: true, status: 200, content: "0.0003" });
    expect(result.firstTokenMs).toBeUndefined();          // nothing to time without a stream
    expect(bodies.map(body => body.stream)).toEqual([true, undefined]);
  });

  it("still fails a model that cannot stream and cannot answer either", async () => {
    stub(error(400, "does not support streaming"), error(500, "Internal error"));
    expect(await adapter().smokeTest("dep-1")).toMatchObject({ ok: false, status: 500 });
    stub(error(400, "does not support streaming"), new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }));
    expect(await adapter().smokeTest("dep-1")).toMatchObject({ ok: false, error: "Empty completion" });
  });

  it("does not retry for any other 400, or for a server error", async () => {
    const bodies = stub(error(400, "This model's maximum context length is 512 tokens"));
    expect(await adapter().smokeTest("dep-1")).toMatchObject({ ok: false, status: 400 });
    expect(bodies).toHaveLength(1);
    const again = stub(error(500, "stream interrupted"));
    expect(await adapter().smokeTest("dep-1")).toMatchObject({ ok: false, status: 500 });
    expect(again).toHaveLength(1);
  });
});
