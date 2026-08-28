import { describe, expect, test } from "bun:test";
import type { PiCatalog, PiProviderSummary } from "../../plugins/builtin/ai/pi";
import type { AiProviderId } from "../../plugins/builtin/ai/providers";
import { createDefaultConfig } from "../../types/config";
import type { CliCommandContext } from "../../types/plugin";
import { createAiCliCommand } from "./automation";

function piProvider(
  id: AiProviderId,
  connection: PiProviderSummary["connection"],
): PiProviderSummary {
  return {
    id,
    label: id,
    name: id,
    authMethods: [],
    connection,
    models: [],
  };
}

function createHarness(options: {
  catalog: PiCatalog;
  configuredProviderId?: string;
  configuredModelId?: string;
  response?: string;
}) {
  const config = createDefaultConfig("/tmp/gloomberb-ai-cli");
  config.pluginConfig.ai = {
    ...(options.configuredProviderId
      ? { defaultProviderId: options.configuredProviderId }
      : {}),
    ...(options.configuredModelId
      ? { defaultModelId: options.configuredModelId }
      : {}),
  };
  const output: unknown[] = [];
  const runs: Array<{ providerId: string; modelId?: string; prompt: string }> = [];
  let closed = 0;
  let runtimeDataDir = "";
  const command = createAiCliCommand({
    createRuntime(dataDir) {
      runtimeDataDir = dataDir;
      return {
        getCatalog: async () => options.catalog,
        runText(request) {
          runs.push(request);
          return {
            done: Promise.resolve(options.response ?? "answer"),
            cancel() {},
          };
        },
      };
    },
  });
  const context = {
    initConfigData: async () => ({
      config,
      dataDir: config.dataDir,
      persistence: { close: () => { closed += 1; } },
      store: {},
    }),
    printResult: (result: { data: unknown }) => { output.push(result.data); },
    fail(message: string): never {
      throw new Error(message);
    },
  } as unknown as CliCommandContext;

  return {
    command,
    context,
    output,
    runs,
    closed: () => closed,
    runtimeDataDir: () => runtimeDataDir,
  };
}

describe("headless Pi AI command", () => {
  test("lists canonical Pi providers and their connection state", async () => {
    const harness = createHarness({
      catalog: {
        providers: [
          piProvider("anthropic", {
            state: "connected",
            type: "oauth",
            source: "Claude Pro/Max",
            origin: "stored",
            disconnectable: true,
          }),
          piProvider("openai-codex", { state: "not_connected" }),
        ],
        refreshErrors: {},
      },
    });

    await harness.command.execute(["providers"], harness.context);

    expect(harness.runtimeDataDir()).toBe("/tmp/gloomberb-ai-cli");
    expect(harness.output[0]).toEqual([
      {
        id: "anthropic",
        name: "anthropic",
        connectionState: "connected",
        connectionSource: "Claude Pro/Max",
        connectionError: "",
        availableModels: 0,
      },
      {
        id: "openai-codex",
        name: "openai-codex",
        connectionState: "not_connected",
        connectionSource: "",
        connectionError: "",
        availableModels: 0,
      },
    ]);
    expect(harness.closed()).toBe(1);
  });

  test("uses the configured connected provider and model through Pi", async () => {
    const harness = createHarness({
      catalog: {
        providers: [
          piProvider("google", {
            state: "connected",
            type: "oauth",
            origin: "stored",
            disconnectable: true,
          }),
          piProvider("anthropic", {
            state: "connected",
            type: "oauth",
            origin: "stored",
            disconnectable: true,
          }),
        ],
        refreshErrors: {},
      },
      configuredProviderId: "claude",
      configuredModelId: "claude-opus-4-8",
      response: "Pi answer",
    });

    await harness.command.execute(["ask", "Explain", "cash", "flow"], harness.context);

    expect(harness.runs).toEqual([{
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      prompt: "Explain cash flow",
    }]);
    expect(harness.output[0]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      text: "Pi answer",
    });
    expect(harness.closed()).toBe(1);
  });

  test("supports explicit canonicalized overrides and rejects disconnected accounts", async () => {
    const connected = createHarness({
      catalog: {
        providers: [piProvider("google", {
          state: "connected",
          type: "oauth",
          origin: "stored",
          disconnectable: true,
        })],
        refreshErrors: {},
      },
    });

    await connected.command.execute([
      "ask",
      "--provider",
      "gemini",
      "--model",
      "gemini-2.5-pro",
      "Find",
      "compounders",
    ], connected.context);

    expect(connected.runs).toEqual([{
      providerId: "google",
      modelId: "gemini-2.5-pro",
      prompt: "Find compounders",
    }]);

    const disconnected = createHarness({
      catalog: {
        providers: [piProvider("anthropic", { state: "not_connected" })],
        refreshErrors: {},
      },
    });
    await expect(disconnected.command.execute(
      ["ask", "--provider", "claude", "Hello"],
      disconnected.context,
    )).rejects.toThrow("is not connected");
    expect(disconnected.runs).toEqual([]);
    expect(disconnected.closed()).toBe(1);
  });

  test("rejects unsupported verbs instead of returning a stub payload", async () => {
    const harness = createHarness({
      catalog: { providers: [], refreshErrors: {} },
    });
    await expect(harness.command.execute(["screen"], harness.context))
      .rejects.toThrow("Usage: gloomberb ai providers|ask");
    expect(harness.output).toEqual([]);
  });
});
