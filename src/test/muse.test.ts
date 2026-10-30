import { describe, expect, it, vi } from "vitest";
import {
  gatewayCallCount,
  lastGatewayStatus,
  museComplete,
  museConfig,
} from "@/lib/muse.server";

const TEST_KEY = "LLM_test_key";

function capturingFetch(seen: { url?: string; init?: RequestInit | undefined }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "back" },
          { type: "thinking", text: "not prose" },
        ],
      }),
    } as Response;
  }) as typeof fetch;
}

describe("Meta Model API gateway client", () => {
  it("has no config without a key", () => {
    expect(museConfig({})).toBeNull();
    expect(museConfig({ MUSE_API_KEY: "  " })).toBeNull();
  });

  it("defaults to api.meta.ai and muse-spark-1.3-contributor", () => {
    const config = museConfig({ MUSE_API_KEY: TEST_KEY });
    expect(config).toEqual({
      apiKey: TEST_KEY,
      baseUrl: "https://api.meta.ai",
      model: "muse-spark-1.3-contributor",
    });
  });

  it("is a strict no-op without a key: returns null and never fetches", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const text = await museComplete({ prompt: "hi", env: {}, fetchImpl });
    expect(text).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to /v1/messages with Bearer auth, the model and the system prompt", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const text = await museComplete({
      system: "Be brief.",
      prompt: "Say hello",
      maxTokens: 64,
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: capturingFetch(seen),
    });
    expect(text).toBe("Hello back");
    expect(seen.url).toBe("https://api.meta.ai/v1/messages");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      max_tokens: number;
      system?: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("muse-spark-1.3-contributor");
    expect(body.max_tokens).toBe(64);
    expect(body.system).toBe("Be brief.");
    expect(body.messages).toEqual([{ role: "user", content: "Say hello" }]);
  });

  it("returns null on an HTTP error", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 401, json: async () => ({}) }) as Response) as typeof fetch;
    const text = await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const text = await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
  });

  it("records the failure status and error excerpt, never the key", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "bad key supplied",
        json: async () => ({}),
      }) as unknown as Response) as typeof fetch;
    const before = gatewayCallCount();
    const text = await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
    expect(gatewayCallCount()).toBe(before + 1);
    const status = lastGatewayStatus();
    expect(status).toMatchObject({ attempted: true, ok: false, status: 401 });
    expect(status.error).toContain("bad key supplied");
    expect(JSON.stringify(status)).not.toContain(TEST_KEY);
  });

  it("records a thrown error without a status", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    const status = lastGatewayStatus();
    expect(status.attempted).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.status).toBeUndefined();
    expect(status.error).toContain("network down");
  });

  it("records a successful call", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: capturingFetch(seen),
    });
    expect(lastGatewayStatus()).toEqual({
      attempted: true,
      ok: true,
      status: 200,
    });
  });

  it("returns null when the call times out", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;
    const text = await museComplete({
      prompt: "hi",
      timeoutMs: 10,
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
  });
});
