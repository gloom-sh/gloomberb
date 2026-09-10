import { describe, expect, test } from "bun:test";
import {
  InMemoryCredentialStore,
  Type,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  PiAiRuntime,
  PiRunCancelledError,
  PiRuntimeError,
} from "./runtime";

function createFauxRuntime(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({
    provider: "anthropic",
    models: [
      { id: "claude-fable-5", name: "Fable" },
      { id: "claude-opus-4-8", name: "Opus" },
    ],
    tokensPerSecond: options.tokensPerSecond,
  });
  const models = createModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(faux.provider);
  return { faux, runtime: new PiAiRuntime({ models }) };
}

describe("PiAiRuntime", () => {
  test("exposes a serializable canonical connected catalog", async () => {
    const { runtime } = createFauxRuntime();
    const catalog = await runtime.getCatalog();

    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0]).toMatchObject({
      id: "anthropic",
      label: "Claude",
      connection: {
        state: "connected",
        type: "api_key",
        origin: "external",
        disconnectable: false,
      },
    });
    expect(catalog.providers[0]).not.toHaveProperty("uiId");
    expect(catalog.providers[0]?.models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
    ]);
  });

  test("falls back to the first community model when a live catalog has no curated defaults", async () => {
    const faux = fauxProvider({
      provider: "spore",
      models: [
        { id: "qwen3.6-35b-a3b:32k:personal", name: "Qwen personal" },
        { id: "qwen3.6-35b-a3b:32k", name: "Qwen 32k" },
      ],
    });
    const models = createModels({ credentials: new InMemoryCredentialStore() });
    models.setProvider(faux.provider);
    const runtime = new PiAiRuntime({ models });

    expect((await runtime.getProviderSummary("spore")).defaultModelId).toBe("qwen3.6-35b-a3b:32k");
    expect((await runtime.resolveModel({ providerId: "spore" })).id).toBe("qwen3.6-35b-a3b:32k");
  });

  test("uses the provider default for a blank model and streams cumulative text", async () => {
    const { faux, runtime } = createFauxRuntime();
    let requestedModel = "";
    faux.setResponses([
      (context, _options, _state, model) => {
        requestedModel = model.id;
        expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "hello" });
        return fauxAssistantMessage("world");
      },
    ]);
    const chunks: string[] = [];

    const result = await runtime.runText({
      providerId: "anthropic",
      modelId: "",
      prompt: "hello",
      onChunk: (chunk) => chunks.push(chunk),
    }).done;

    expect(requestedModel).toBe("claude-opus-4-8");
    expect(result).toBe("world");
    expect(chunks.at(-1)).toBe("world");
  });

  test("rejects legacy provider aliases at the Pi runtime boundary", async () => {
    const { runtime } = createFauxRuntime();

    await expect(runtime.getProviderSummary("claude"))
      .rejects.toMatchObject({ code: "provider_not_found" });
  });

  test("rejects an injected legacy provider instead of publishing a mismatched canonical entry", async () => {
    const legacy = fauxProvider({
      provider: "claude",
      models: [{ id: "claude-opus-4-8", name: "Opus" }],
    });
    const models = createModels({ credentials: new InMemoryCredentialStore() });
    models.setProvider(legacy.provider);
    const runtime = new PiAiRuntime({ models });

    await expect(runtime.getCatalog()).rejects.toMatchObject({
      code: "provider_not_found",
      message: "Unsupported AI provider: claude",
    });
  });

  test("bridges OAuth events and prompts without returning credentials", async () => {
    const credentials = new InMemoryCredentialStore();
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-4-8" }] });
    const provider = createProvider({
      id: "anthropic",
      name: "Anthropic",
      auth: {
        oauth: {
          name: "Claude Pro/Max",
          login: async (interaction) => {
            interaction.notify({ type: "auth_url", url: "https://example.test/login" });
            const code = await interaction.prompt({ type: "text", message: "Paste code" });
            return { type: "oauth", access: `access-${code}`, refresh: "refresh-secret", expires: Date.now() + 60_000 };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.models,
      api: { stream: faux.provider.stream, streamSimple: faux.provider.streamSimple },
    });
    const models = createModels({ credentials });
    models.setProvider(provider);
    const runtime = new PiAiRuntime({ models });
    const events: unknown[] = [];
    const prompts: unknown[] = [];

    const connected = await runtime.login(
      { providerId: "anthropic", type: "oauth" },
      {
        notify: (event) => events.push(event),
        prompt: async (prompt) => {
          prompts.push(prompt);
          return "login-code";
        },
      },
    );

    expect(events).toEqual([{ type: "auth_url", url: "https://example.test/login" }]);
    expect(prompts).toEqual([{ type: "text", message: "Paste code" }]);
    expect(connected.connection).toEqual({
      state: "connected",
      type: "oauth",
      source: "OAuth",
      origin: "stored",
      disconnectable: true,
    });
    expect(JSON.stringify(connected)).not.toContain("login-code");
    expect((await runtime.logout("anthropic")).connection).toEqual({ state: "not_connected" });
  });

  test("does not report an expired OAuth credential as connected when refresh fails", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: Date.now() - 1,
    }));
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-4-8" }] });
    const provider = createProvider({
      id: "anthropic",
      name: "Anthropic",
      auth: {
        oauth: {
          name: "Claude Pro/Max",
          login: async () => { throw new Error("unused"); },
          refresh: async () => { throw new Error("refresh rejected"); },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.models,
      api: { stream: faux.provider.stream, streamSimple: faux.provider.streamSimple },
    });
    const models = createModels({ credentials });
    models.setProvider(provider);
    const runtime = new PiAiRuntime({ models });

    expect((await runtime.getProviderSummary("anthropic")).connection).toMatchObject({
      state: "error",
      message: expect.stringContaining("OAuth refresh failed"),
    });
    await expect(runtime.resolveModel({ providerId: "anthropic" }))
      .rejects.toMatchObject({ code: "provider_not_configured" });
  });

  test("normalizes provider failures and cancellation", async () => {
    const failed = createFauxRuntime();
    failed.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Authorization: Bearer super-secret-token",
      }),
    ]);
    const failure = failed.runtime.runText({ providerId: "anthropic", prompt: "fail" }).done;
    await expect(failure).rejects.toBeInstanceOf(PiRuntimeError);
    await expect(failure).rejects.not.toThrow("super-secret-token");

    const slow = createFauxRuntime({ tokensPerSecond: 0.01 });
    slow.faux.setResponses([fauxAssistantMessage("This response should be cancelled.")]);
    const run = slow.runtime.runText({ providerId: "anthropic", prompt: "cancel" });
    run.cancel();
    await expect(run.done).rejects.toBeInstanceOf(PiRunCancelledError);
  });

  test("runs typed tools through pi-agent-core and returns the final agent response", async () => {
    const { faux, runtime } = createFauxRuntime();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remote_control", { request: "schema" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Remote schema loaded."),
    ]);
    const toolCalls: unknown[] = [];
    const chunks: string[] = [];

    const run = runtime.runAgent({
      providerId: "anthropic",
      prompt: "Inspect the app",
      tools: [{
        name: "remote_control",
        label: "Gloomberb remote control",
        description: "Send a request to the running Gloomberb app.",
        parameters: Type.Object({ request: Type.String() }),
        execute: async (_toolCallId, params) => {
          const request = (params as { request: string }).request;
          toolCalls.push({ request });
          return {
            content: [{ type: "text", text: '{"actions":[]}' }],
            details: { request },
          };
        },
      }],
      onChunk: (chunk) => chunks.push(chunk),
    });

    const result = await run.done;
    expect(toolCalls).toEqual([{ request: "schema" }]);
    expect(result.text).toBe("Remote schema loaded.");
    expect(chunks.at(-1)).toBe("Remote schema loaded.");
    expect(result.messages.some((message) => message.role === "toolResult")).toBe(true);
  });
});
