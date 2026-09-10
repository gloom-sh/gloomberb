import { describe, expect, test } from "bun:test";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createModels,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
  SPORE_API_BASE_URL,
  SPORE_API_KEY_ENV,
  SPORE_PROVIDER_ID,
  fetchSporeModels,
  mapSporeModelsResponse,
  sporeErrorMessage,
  sporeProvider,
} from "./spore";

const CATALOG = {
  object: "list",
  data: [
    {
      id: "qwen3.6-35b-a3b:32k",
      object: "model",
      supports_thinking: true,
      recommended: true,
      catalog_role: "default",
      available: true,
    },
    {
      id: "old-model:8k",
      object: "model",
      supports_thinking: false,
      recommended: false,
      available: false,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  const store = {
    read: async () => undefined,
    write: async () => {},
    delete: async () => {},
  };
  return {
    credential: { type: "api_key", key: "sk_spore_test" },
    store,
    allowNetwork: true,
    ...overrides,
  };
}

describe("Spore model catalog", () => {
  test("maps live GET /models ids and appends :personal owner-node variants", () => {
    const models = mapSporeModelsResponse(JSON.stringify(CATALOG));

    expect(models.map((model) => model.id)).toEqual([
      "qwen3.6-35b-a3b:32k",
      "qwen3.6-35b-a3b:32k:personal",
      "old-model:8k:personal",
    ]);
    expect(models[0]).toMatchObject({
      name: "qwen3.6-35b-a3b 32k",
      api: "openai-completions",
      provider: SPORE_PROVIDER_ID,
      baseUrl: SPORE_API_BASE_URL,
      reasoning: true,
      contextWindow: 32 * 1024,
      maxTokens: 8192,
    });
    expect(models[1]).toMatchObject({
      id: "qwen3.6-35b-a3b:32k:personal",
      name: "qwen3.6-35b-a3b 32k (personal)",
      reasoning: true,
    });
    expect(models[2]).toMatchObject({
      id: "old-model:8k:personal",
      name: "old-model 8k (personal)",
      contextWindow: 8 * 1024,
    });
  });

  test("does not ship a hardcoded catalog on the provider factory", () => {
    const provider = sporeProvider();
    expect(provider.id).toBe(SPORE_PROVIDER_ID);
    expect(provider.baseUrl).toBe(SPORE_API_BASE_URL);
    expect(provider.auth.apiKey?.name).toBe("Spore API key");
    expect(provider.auth.oauth).toBeUndefined();
    expect(provider.getModels()).toEqual([]);
    expect(provider.refreshModels).toBeDefined();
  });

  test("reads Spore auth errors as a raw string or OpenAI envelope", () => {
    expect(sporeErrorMessage(401, '{"error":"Invalid API key"}')).toBe("Invalid API key");
    expect(sporeErrorMessage(401, '{"error":{"message":"Authentication required","type":"authentication_error"}}'))
      .toBe("Authentication required");
    expect(sporeErrorMessage(500, "")).toBe("Spore models request failed (500)");
  });

  test("fetches GET /models with a Bearer key against the Code-page base URL", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const models = await fetchSporeModels(
      refreshContext(),
      async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, headers: request.headers });
        return jsonResponse(CATALOG);
      },
    );

    expect(requests).toEqual([{
      url: `${SPORE_API_BASE_URL}/models`,
      headers: expect.any(Headers),
    }]);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer sk_spore_test");
    expect(models.map((model) => model.id)).toContain("qwen3.6-35b-a3b:32k:personal");
  });

  test("surfaces Spore's raw 401 string from catalog refresh", async () => {
    await expect(fetchSporeModels(
      refreshContext(),
      async () => jsonResponse({ error: "Invalid API key" }, 401),
    )).rejects.toThrow("Invalid API key");
  });
});

describe("Spore provider wiring", () => {
  test("refreshes models through Pi when SPORE_API_KEY auth is present", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(SPORE_PROVIDER_ID, async () => ({
      type: "api_key",
      key: "sk_spore_test",
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse(CATALOG)) as typeof fetch;
    try {
      const models = createModels({
        credentials,
        modelsStore: new InMemoryModelsStore(),
      });
      models.setProvider(sporeProvider());
      const result = await models.refresh();
      expect(result.errors.size).toBe(0);
      expect(models.getModels(SPORE_PROVIDER_ID).map((model) => model.id)).toEqual([
        "qwen3.6-35b-a3b:32k",
        "qwen3.6-35b-a3b:32k:personal",
        "old-model:8k:personal",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves the Spore API key from SPORE_API_KEY", async () => {
    const previous = process.env[SPORE_API_KEY_ENV];
    process.env[SPORE_API_KEY_ENV] = "sk_spore_from_env";
    try {
      const models = createModels({ credentials: new InMemoryCredentialStore() });
      models.setProvider(sporeProvider());
      const auth = await models.getAuth(SPORE_PROVIDER_ID);
      expect(auth).toMatchObject({
        source: SPORE_API_KEY_ENV,
        auth: { apiKey: "sk_spore_from_env" },
      });
    } finally {
      if (previous === undefined) delete process.env[SPORE_API_KEY_ENV];
      else process.env[SPORE_API_KEY_ENV] = previous;
    }
  });
});
