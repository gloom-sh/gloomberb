import {
  PiAiRuntime,
  type PiCatalog,
  type PiTextRunController,
} from "../../plugins/builtin/ai/pi";
import {
  isAiProviderId,
  migrateLegacyAiProviderId,
  type AiProviderId,
} from "../../plugins/builtin/ai/providers";
import { createRssNewsCapability } from "../../plugins/builtin/news/wire/rss/source";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices, withConfigData } from "../context";
import { requireArg, takeOption } from "./command-utils";

export const brokerCliCommand: CliCommandDef = {
  name: "broker",
  aliases: ["brokers"],
  description: "Inspect broker profiles",
  help: { usage: ["broker list", "broker status"] },
  execute: async (args, ctx) => {
    const action = args[0] ?? "list";
    if (action !== "list" && action !== "status") {
      ctx.fail("Usage: gloomberb broker list|status");
    }
    await withCliServices(ctx, async (services) => {
      ctx.printResult({
        data: services.config.brokerInstances.map((instance) => ({
          id: instance.id,
          type: instance.brokerType,
          label: instance.label,
          enabled: instance.enabled !== false,
          connectionMode: instance.connectionMode ?? "",
          lastSyncedAt: instance.lastSyncedAt ? new Date(instance.lastSyncedAt).toISOString() : "",
        })),
      });
    });
  },
};

export const ibkrCliCommand: CliCommandDef = {
  name: "ibkr",
  description: "Inspect IBKR profiles",
  help: { usage: ["ibkr accounts", "ibkr status"] },
  execute: async (args, ctx) => {
    const action = args[0] ?? "status";
    if (action !== "accounts" && action !== "status") {
      ctx.fail("Usage: gloomberb ibkr accounts|status");
    }
    await withCliServices(ctx, async (services) => {
      ctx.printResult({
        data: services.config.brokerInstances
          .filter((instance) => instance.brokerType === "ibkr")
          .map((instance) => ({
            id: instance.id,
            label: instance.label,
            enabled: instance.enabled !== false,
            connectionMode: instance.connectionMode ?? "",
            lastSyncedAt: instance.lastSyncedAt ? new Date(instance.lastSyncedAt).toISOString() : "",
          })),
      });
    });
  },
};

interface HeadlessPiRuntime {
  getCatalog(): Promise<PiCatalog>;
  runText(options: {
    providerId: AiProviderId;
    modelId?: string;
    prompt: string;
  }): PiTextRunController;
}

interface CreateAiCliCommandOptions {
  createRuntime?: (dataDir: string) => HeadlessPiRuntime;
}

function configuredAiSelection(config: Record<string, unknown> | undefined): {
  providerId: AiProviderId | null;
  modelId: string | null;
} {
  const rawProviderId = typeof config?.defaultProviderId === "string"
    ? config.defaultProviderId.trim()
    : "";
  const providerId = migrateLegacyAiProviderId(rawProviderId);
  const modelId = typeof config?.defaultModelId === "string"
    ? config.defaultModelId.trim()
    : "";
  return {
    providerId: isAiProviderId(providerId) ? providerId : null,
    modelId: modelId || null,
  };
}

function connectionFailure(provider: PiCatalog["providers"][number]): string {
  if (provider.connection.state === "error") {
    return `${provider.label} could not connect: ${provider.connection.message}`;
  }
  return `${provider.label} is not connected. Connect it from AI pane settings first.`;
}

export function createAiCliCommand(options: CreateAiCliCommandOptions = {}): CliCommandDef {
  const createRuntime = options.createRuntime ?? ((dataDir: string) => new PiAiRuntime({ dataDir }));
  return {
    name: "ai",
    description: "Inspect AI providers and run guarded headless AI prompts",
    help: {
      usage: [
        "ai providers",
        "ai ask [--provider id] [--model id] <prompt>",
      ],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "providers";
      if (action !== "providers" && action !== "ask") {
        ctx.fail("Usage: gloomberb ai providers|ask");
      }

      const rawArgs = args.slice(1);
      const requestedProvider = takeOption(rawArgs, "--provider")?.trim();
      const requestedModel = takeOption(rawArgs, "--model")?.trim();
      const prompt = rawArgs.join(" ").trim();
      if (action === "ask" && !prompt) {
        ctx.fail("Usage: gloomberb ai ask [--provider id] [--model id] <prompt>");
      }

      await withConfigData(ctx, async (context) => {
        const runtime = createRuntime(context.dataDir);
        const catalog = await runtime.getCatalog();
        if (action === "providers") {
          ctx.printResult({
            data: catalog.providers.map((provider) => ({
              id: provider.id,
              name: provider.label,
              connectionState: provider.connection.state,
              connectionSource: provider.connection.state === "connected"
                ? provider.connection.source ?? ""
                : "",
              connectionError: provider.connection.state === "error"
                ? provider.connection.message
                : "",
              availableModels: provider.models.filter((model) => model.available).length,
            })),
          });
          return;
        }

        const configured = configuredAiSelection(context.config.pluginConfig.ai);
        const canonicalRequestedId = requestedProvider
          ? migrateLegacyAiProviderId(requestedProvider)
          : null;
        const requestedProviderId = canonicalRequestedId && isAiProviderId(canonicalRequestedId)
          ? canonicalRequestedId
          : null;
        const requested = requestedProviderId
          ? catalog.providers.find((provider) => provider.id === requestedProviderId)
          : null;
        if (requestedProvider && (!requestedProviderId || !requested)) {
          ctx.fail(`Unknown AI provider: ${requestedProvider}.`);
        }

        const configuredProvider = configured.providerId
          ? catalog.providers.find((provider) => (
            provider.id === configured.providerId
            && provider.connection.state === "connected"
          ))
          : null;
        const selected = requested
          ?? configuredProvider
          ?? catalog.providers.find((provider) => provider.connection.state === "connected");
        if (!selected) {
          ctx.fail("No AI provider is connected. Connect an account from AI pane settings first.");
          throw new Error("AI provider selection failed.");
        }
        if (selected.connection.state !== "connected") {
          ctx.fail(connectionFailure(selected));
        }

        const modelId = requestedModel
          || (selected.id === configured.providerId ? configured.modelId : null)
          || undefined;
        const text = await runtime.runText({
          providerId: selected.id,
          modelId,
          prompt,
        }).done;
        ctx.printResult({
          data: {
            provider: selected.id,
            model: modelId ?? null,
            text,
          },
        });
      });
    },
  };
}

export const aiCliCommand = createAiCliCommand();

export const rssCliCommand: CliCommandDef = {
  name: "rss",
  description: "Fetch an RSS feed as news rows",
  help: { usage: ["rss fetch <url> [--name label]"] },
  execute: async (args, ctx) => {
    const action = args[0] ?? "fetch";
    if (action !== "fetch") ctx.fail("Usage: gloomberb rss fetch <url> [--name label]");
    const rawArgs = args.slice(1);
    const name = takeOption(rawArgs, "--name") ?? "RSS";
    const url = requireArg(rawArgs[0], "Usage: gloomberb rss fetch <url> [--name label]", ctx);
    const capability = createRssNewsCapability([{
      id: "cli-feed",
      url,
      name,
      category: "cli",
      authority: 50,
      enabled: true,
    }]);
    const articles = await capability.provider.fetchNews({ feed: "latest", limit: ctx.cliOptions.limit ?? 20 });
    ctx.printResult({ data: articles.map((article) => ({
      title: article.title,
      source: article.source,
      publishedAt: article.publishedAt.toISOString(),
      url: article.url,
      summary: article.summary ?? "",
    })) });
  },
};
