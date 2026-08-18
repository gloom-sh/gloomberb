import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  AI_RUNNER_CAPABILITY_ID,
  BROKER_CAPABILITY_ID,
  NOTES_FILES_CAPABILITY_ID,
  type CapabilityOperation,
  type PluginCapability,
} from "../../../capabilities";
import type { AppServices } from "../../../core/app-services";
import {
  isAiProviderId,
  type AiProviderId,
} from "../../../plugins/builtin/ai/providers";
import { createPiAiHost } from "../../../plugins/builtin/ai/pi";
import {
  isAiRunCancelled,
  type AiConversationMessage,
  type AiRuntimeAuthType,
} from "../../../plugins/builtin/ai/runner";
import {
  normalizeAiAgentHistory,
  type AiAgentHistoryMessage,
} from "../../../plugins/builtin/ai/agent-history";
import type { BrokerAdapter } from "../../../types/broker";
import type { AppConfig, BrokerInstanceConfig } from "../../../types/config";

const DESKTOP_CORE_PLUGIN_ID = "desktop-core";
const NOTES_INDEX_FILE = "__quick-notes-index__.json";

const BROKER_INVOKE_OPERATIONS = new Set([
  "validate",
  "importPositions",
  "importPortfolioSnapshot",
  "connect",
  "disconnect",
  "getPersistedConfigUpdate",
  "listAccounts",
  "getPortfolioPerformance",
  "searchInstruments",
  "getTickerFinancials",
  "getQuote",
  "getPriceHistory",
  "getPriceHistoryForResolution",
  "getDetailedPriceHistory",
  "getChartResolutionSupport",
  "getChartResolutionCapabilities",
  "getOptionsChain",
  "listOpenOrders",
  "listExecutions",
  "previewOrder",
  "placeOrder",
  "modifyOrder",
  "cancelOrder",
]);

interface CoreCapabilityOptions {
  getConfig(): AppConfig;
  getServices(): AppServices;
}

function op(handler: CapabilityOperation["handler"], kind: CapabilityOperation["kind"] = "read"): CapabilityOperation {
  return { kind, rendererSafe: true, handler };
}

function stream(subscribe: CapabilityOperation["subscribe"]): CapabilityOperation {
  return { kind: "stream", rendererSafe: true, subscribe };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveBrokerInstance(
  options: CoreCapabilityOptions,
  instanceId: string | undefined,
): { instance: BrokerInstanceConfig; broker: BrokerAdapter } {
  if (!instanceId) throw new Error("Broker request requires an instance.");
  const instance = options.getConfig().brokerInstances.find((entry) => entry.id === instanceId);
  if (!instance) throw new Error(`Broker profile "${instanceId}" was not found.`);
  const broker = options.getServices().pluginRegistry.brokers.get(instance.brokerType);
  if (!broker) throw new Error(`Broker "${instance.brokerType}" is not available.`);
  return { instance, broker };
}

function brokerStatus(options: CoreCapabilityOptions, broker: BrokerAdapter, instanceId: string) {
  const instance = options.getConfig().brokerInstances.find((entry) => entry.id === instanceId);
  if (!instance) return { state: "disconnected" as const, updatedAt: Date.now() };
  return broker.getStatus?.(instance) ?? { state: "disconnected" as const, updatedAt: Date.now() };
}

function invokeBrokerOperation(
  broker: BrokerAdapter,
  instance: BrokerInstanceConfig,
  operation: string,
  args: unknown[],
) {
  if (!BROKER_INVOKE_OPERATIONS.has(operation)) {
    throw new Error(`Broker operation "${operation}" is not supported.`);
  }

  switch (operation) {
    case "validate":
    case "importPositions":
    case "importPortfolioSnapshot":
    case "connect":
    case "disconnect":
    case "getPersistedConfigUpdate":
    case "listAccounts":
    case "listOpenOrders":
    case "listExecutions":
      return (broker[operation] as any)?.call(broker, instance);
    case "getPortfolioPerformance":
      return broker.getPortfolioPerformance?.(instance, args[0] as string);
    case "searchInstruments":
      return broker.searchInstruments?.(args[0] as string, instance);
    case "getTickerFinancials":
    case "getQuote":
    case "getPriceHistory":
    case "getPriceHistoryForResolution":
    case "getDetailedPriceHistory":
    case "getChartResolutionSupport":
    case "getChartResolutionCapabilities":
    case "getOptionsChain":
      return (broker[operation] as any)?.call(broker, args[0], instance, ...args.slice(1));
    case "previewOrder":
    case "placeOrder":
      return (broker[operation] as any)?.call(broker, instance, args[0]);
    case "modifyOrder":
      return broker.modifyOrder?.(instance, args[0] as number, args[1] as never);
    case "cancelOrder":
      return broker.cancelOrder?.(instance, args[0] as number);
    default:
      throw new Error(`Broker operation "${operation}" is not supported.`);
  }
}

function createBrokerCapability(options: CoreCapabilityOptions): PluginCapability {
  return {
    id: BROKER_CAPABILITY_ID,
    kind: "broker",
    name: "Broker Service",
    operations: {
      invoke: op(async (input: any) => {
        const { instance, broker } = resolveBrokerInstance(options, input.instanceId);
        const operation = requireString(input.operation, "Broker operation");
        const args = Array.isArray(input.args) ? input.args : [];
        const result = await invokeBrokerOperation(broker, instance, operation, args);
        if (result === undefined && typeof (broker as any)[operation] !== "function") {
          throw new Error(`Broker operation "${operation}" is not available on "${broker.name}".`);
        }
        return result ?? null;
      }, "action"),
      status: stream((input: any, emit) => {
        const instanceId = requireString(input.instanceId, "Broker instance");
        const { instance, broker } = resolveBrokerInstance(options, instanceId);
        const pushStatus = () => {
          emit({
            kind: "status",
            instanceId,
            status: brokerStatus(options, broker, instanceId),
          });
        };
        const unsubscribe = broker.subscribeStatus?.(instance, pushStatus) ?? (() => {});
        pushStatus();
        return unsubscribe;
      }),
      quotes: stream((input: any, emit) => {
        const instanceId = requireString(input.instanceId, "Broker instance");
        const { instance, broker } = resolveBrokerInstance(options, instanceId);
        if (!broker.subscribeQuotes) throw new Error(`Broker "${broker.name}" does not support quote subscriptions.`);
        return broker.subscribeQuotes(
          instance,
          Array.isArray(input.targets) ? input.targets : [],
          (target, quote) => {
            emit({ kind: "quote", target, quote });
          },
        );
      }),
      removeInstance: op(async (input: any) => {
        const { instance, broker } = resolveBrokerInstance(options, input.instanceId);
        await broker.disconnect?.(instance);
        return null;
      }, "action"),
      destroyAll: op(async () => {
        const config = options.getConfig();
        await Promise.allSettled(config.brokerInstances.map(async (instance) => {
          const broker = options.getServices().pluginRegistry.brokers.get(instance.brokerType);
          await broker?.disconnect?.(instance);
        }));
        return null;
      }, "action"),
    },
  };
}

function notePath(dataDir: string, symbol: string): string {
  return join(dataDir, `${symbol}.md`);
}

function notesIndexPath(dataDir: string): string {
  return join(dataDir, NOTES_INDEX_FILE);
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function writeTextEnsuringParent(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

async function deleteFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createNotesFilesCapability(): PluginCapability {
  return {
    id: NOTES_FILES_CAPABILITY_ID,
    kind: "notes-files",
    name: "Notes Files",
    operations: {
      load: op((input: any) => readTextOrEmpty(notePath(
        requireString(input.dataDir, "Notes dataDir"),
        requireString(input.symbol, "Notes symbol"),
      ))),
      save: op(async (input: any) => {
        await writeTextEnsuringParent(
          notePath(
            requireString(input.dataDir, "Notes dataDir"),
            requireString(input.symbol, "Notes symbol"),
          ),
          optionalString(input.notes) ?? "",
        );
        return null;
      }, "action"),
      delete: op(async (input: any) => {
        await deleteFileIfPresent(notePath(
          requireString(input.dataDir, "Notes dataDir"),
          requireString(input.symbol, "Notes symbol"),
        ));
        return null;
      }, "action"),
      loadQuickNotesIndex: op(async (input: any) => {
        const raw = await readTextOrEmpty(notesIndexPath(requireString(input.dataDir, "Notes dataDir")));
        if (!raw.trim()) return [];
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      }),
      saveQuickNotesIndex: op(async (input: any) => {
        await writeTextEnsuringParent(
          notesIndexPath(requireString(input.dataDir, "Notes dataDir")),
          JSON.stringify(input.entries ?? []),
        );
        return null;
      }, "action"),
    },
  };
}

function createAiRunnerCapability(options: CoreCapabilityOptions): PluginCapability {
  const aiHost = createPiAiHost({
    appKind: "desktop",
    dataDir: options.getConfig().dataDir,
  });
  const requireProviderId = (value: unknown): AiProviderId => {
    const providerId = requireString(value, "AI provider");
    if (!isAiProviderId(providerId)) {
      throw new Error(`Unknown AI provider: ${providerId}`);
    }
    return providerId;
  };
  const requireCatalogProvider = async (value: unknown): Promise<AiProviderId> => {
    const providerId = requireProviderId(value);
    const catalog = await aiHost.getCatalog?.();
    if (!catalog?.providers.some((provider) => provider.providerId === providerId)) {
      throw new Error(`Unknown AI provider: ${providerId}`);
    }
    return providerId;
  };
  const optionalAuthType = (value: unknown): AiRuntimeAuthType | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (value === "oauth" || value === "api_key") return value;
    throw new Error(`Unknown AI authentication method: ${String(value)}`);
  };
  const optionalMessages = (value: unknown): AiConversationMessage[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new Error("AI conversation messages must be an array.");
    return value.map((message, index) => {
      if (!message || typeof message !== "object") {
        throw new Error(`AI conversation message ${index + 1} is invalid.`);
      }
      const role = (message as { role?: unknown }).role;
      const content = (message as { content?: unknown }).content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        throw new Error(`AI conversation message ${index + 1} is invalid.`);
      }
      return { role, content };
    });
  };
  const optionalAgentMessages = (value: unknown): AiAgentHistoryMessage[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new Error("AI agent messages must be an array.");
    const messages = normalizeAiAgentHistory(value);
    if (messages.length !== value.length) {
      throw new Error("AI agent message history is invalid.");
    }
    return messages;
  };

  return {
    id: AI_RUNNER_CAPABILITY_ID,
    kind: "ai-runner",
    name: "AI Runner",
    operations: {
      getCatalog: op(async () => aiHost.getCatalog?.() ?? { providers: [], accounts: [], models: [] }),
      connectProvider: stream(async (input: any, emit) => {
        const providerId = await requireCatalogProvider(input.providerId);
        const authType = optionalAuthType(input.authType);
        if (!aiHost.connect) throw new Error("In-app AI sign-in is unavailable.");
        let disposed = false;
        aiHost.connect(providerId, authType, (event) => {
          if (!disposed) emit({ kind: "account-auth", event });
        }).then((catalog) => {
          if (!disposed) emit({ kind: "account-connected", catalog });
        }).catch((error) => {
          if (!disposed) emit({
            kind: "account-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return () => {
          disposed = true;
        };
      }),
      disconnectProvider: op(async (input: any) => {
        const providerId = await requireCatalogProvider(input.providerId);
        if (!aiHost.disconnect) throw new Error("In-app AI account disconnection is unavailable.");
        return aiHost.disconnect(providerId);
      }, "action"),
      checkProviderStatus: op(async (input: any) => {
        const providerId = await requireCatalogProvider(input.providerId);
        if (!aiHost.checkStatus) {
          throw new Error("AI provider status checks are unavailable.");
        }
        return aiHost.checkStatus(providerId);
      }),
      run: stream(async (input: any, emit) => {
        const providerId = await requireCatalogProvider(input.providerId);
        const prompt = requireString(input.prompt, "AI prompt");
        const messages = optionalMessages(input.messages);
        const agentMessages = optionalAgentMessages(input.agentMessages);
        let completedAgentMessages: AiAgentHistoryMessage[] | undefined;
        const modelId = optionalString(input.modelId);
        const providerStatus = await aiHost.checkStatus?.(providerId);
        if (providerStatus && !providerStatus.authenticated) {
          throw new Error(
            providerStatus.message
              ?? `${providerId} is not connected.`,
          );
        }

        let disposed = false;
        const controller = aiHost.run({
          providerId,
          prompt,
          messages,
          agentMessages,
          modelId: modelId ?? undefined,
          outputMode: input.outputMode === "structured" || input.outputMode === "screener"
            ? input.outputMode
            : "plain",
          onChunk: (output) => {
            if (!disposed) emit({ kind: "chunk", output });
          },
          onAgentMessages: (nextMessages) => {
            completedAgentMessages = nextMessages;
          },
        });

        controller.done.then((output) => {
          if (!disposed) emit({
            kind: "done",
            output,
            ...(completedAgentMessages ? { agentMessages: completedAgentMessages } : {}),
          });
        }).catch((error) => {
          if (disposed) return;
          if (isAiRunCancelled(error)) {
            emit({ kind: "cancelled" });
            return;
          }
          emit({ kind: "error", error: error instanceof Error ? error.message : String(error) });
        });

        return () => {
          disposed = true;
          controller.cancel();
        };
      }),
    },
  };
}

export function registerElectrobunCoreCapabilities(options: CoreCapabilityOptions): void {
  const registry = options.getServices().pluginRegistry.capabilities;
  registry.register(DESKTOP_CORE_PLUGIN_ID, createBrokerCapability(options));
  registry.register(DESKTOP_CORE_PLUGIN_ID, createNotesFilesCapability());
  registry.register(DESKTOP_CORE_PLUGIN_ID, createAiRunnerCapability(options));
}
