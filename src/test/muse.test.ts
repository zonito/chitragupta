import { describe, expect, it, vi } from "vitest";
import {
  gatewayCallCount,
  gatewayConfig,
  lastGatewayStatus,
  museComplete,
  museConfig,
} from "@/lib/muse.server";

const TEST_KEY = "LLM_test_key";

function capturingFetch(seen: {
  url?: string;
  init?: RequestInit | undefined;
}) {
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
      ({
        ok: false,
        status: 401,
        json: async () => ({}),
      }) as Response) as typeof fetch;
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
      provider: "meta",
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

const OC_KEY = "oc_sk_test_dummy";

function goFetch(
  seen: { url?: string; init?: RequestInit | undefined },
  reply: { content: string | null; finishReason?: string } = {
    content: "Go reply",
    finishReason: "stop",
  },
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: reply.content },
            finish_reason: reply.finishReason ?? "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as Response;
  }) as typeof fetch;
}

describe("OpenCode Go gateway provider", () => {
  it("resolves the Go config and takes precedence over the Meta key", () => {
    expect(gatewayConfig({})).toBeNull();
    expect(gatewayConfig({ OPENCODE_API_KEY: OC_KEY })).toEqual({
      provider: "opencode-go",
      apiKey: OC_KEY,
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "muse-spark-1.3-contributor",
    });
    expect(
      gatewayConfig({ OPENCODE_API_KEY: OC_KEY, OPENCODE_MODEL: "glm-5.2" })
        ?.model,
    ).toBe("glm-5.2");
    // Both keys set: Go wins.
    expect(
      gatewayConfig({ OPENCODE_API_KEY: OC_KEY, MUSE_API_KEY: TEST_KEY })
        ?.provider,
    ).toBe("opencode-go");
    // A blank OpenCode key falls through to Meta.
    expect(
      gatewayConfig({ OPENCODE_API_KEY: "  ", MUSE_API_KEY: TEST_KEY }),
    ).toEqual({
      provider: "meta",
      apiKey: TEST_KEY,
      baseUrl: "https://api.meta.ai",
      model: "muse-spark-1.3-contributor",
    });
  });

  it("posts to /chat/completions with Bearer auth, the session header and the token floor", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const text = await museComplete({
      system: "Be brief.",
      prompt: "Say hello",
      maxTokens: 200,
      env: { OPENCODE_API_KEY: OC_KEY },
      fetchImpl: goFetch(seen),
    });
    expect(text).toBe("Go reply");
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${OC_KEY}`);
    expect(headers["x-opencode-session"]).toBe("chitragupta");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("muse-spark-1.3-contributor");
    // The reasoning model needs headroom: a 200 request is floored to 4000.
    expect(body.max_tokens).toBe(4000);
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Say hello" },
    ]);
    expect(lastGatewayStatus()).toEqual({
      attempted: true,
      ok: true,
      provider: "opencode-go",
      status: 200,
    });
  });

  it("keeps a generous requested budget and omits an empty system message", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await museComplete({
      prompt: "hi",
      maxTokens: 4096,
      env: { OPENCODE_API_KEY: OC_KEY },
      fetchImpl: goFetch(seen),
    });
    const body = JSON.parse(String(seen.init?.body)) as {
      max_tokens: number;
      messages: { role: string; content: string }[];
    };
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("uses the Go route end-to-end when both keys are set", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const text = await museComplete({
      prompt: "hi",
      env: { OPENCODE_API_KEY: OC_KEY, MUSE_API_KEY: TEST_KEY },
      fetchImpl: goFetch(seen),
    });
    expect(text).toBe("Go reply");
    expect(seen.url).toContain("opencode.ai");
  });

  it("returns null and records the finish_reason when reasoning eats the budget", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const text = await museComplete({
      prompt: "hi",
      env: { OPENCODE_API_KEY: OC_KEY },
      fetchImpl: goFetch(seen, { content: null, finishReason: "length" }),
    });
    expect(text).toBeNull();
    const status = lastGatewayStatus();
    expect(status).toMatchObject({
      attempted: true,
      ok: false,
      provider: "opencode-go",
      status: 200,
    });
    expect(status.error).toContain("no content");
    expect(status.error).toContain("length");
  });

  it("returns null on empty content", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const text = await museComplete({
      prompt: "hi",
      env: { OPENCODE_API_KEY: OC_KEY },
      fetchImpl: goFetch(seen, { content: "  ", finishReason: "stop" }),
    });
    expect(text).toBeNull();
    expect(lastGatewayStatus().ok).toBe(false);
  });

  it("records a Go HTTP error, redacting BOTH keys from the excerpt", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "MissingSessionID",
        message: `keys ${OC_KEY} and ${TEST_KEY} rejected`,
      },
    });
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => errorBody,
        json: async () => ({}),
      }) as unknown as Response) as typeof fetch;
    const text = await museComplete({
      prompt: "hi",
      env: { OPENCODE_API_KEY: OC_KEY, MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
    const status = lastGatewayStatus();
    expect(status).toMatchObject({
      attempted: true,
      ok: false,
      provider: "opencode-go",
      status: 400,
    });
    expect(status.error).toContain("MissingSessionID");
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain(OC_KEY);
    expect(serialised).not.toContain(TEST_KEY);
  });

  it("records provider meta on a Meta-route failure", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 402,
        text: async () => "billing verification failed",
        json: async () => ({}),
      }) as unknown as Response) as typeof fetch;
    const text = await museComplete({
      prompt: "hi",
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl,
    });
    expect(text).toBeNull();
    expect(lastGatewayStatus()).toMatchObject({
      attempted: true,
      ok: false,
      provider: "meta",
      status: 402,
    });
  });
});
