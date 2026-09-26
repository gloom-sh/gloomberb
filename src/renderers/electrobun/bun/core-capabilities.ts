import {
  BROKER_CAPABILITY_ID,
  NOTES_FILES_CAPABILITY_ID,
  type CapabilityOperation,
  type PluginCapability,
} from "../../../capabilities";
import type { AppServices } from "../../../core/app-services";
import { diskNotesFilesIO, isNotesFile } from "../../../plugins/builtin/notes/files";
import type { BrokerAdapter } from "../../../types/broker";
import type { AppConfig, BrokerInstanceConfig } from "../../../types/config";

const DESKTOP_CORE_PLUGIN_ID = "desktop-core";

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

/**
 * The desktop view's notes: it runs `NotesFiles` over these operations, so
 * the files and their layout are the ones the terminal reads.
 */
function createNotesFilesCapability(): PluginCapability {
  const io = (input: any) => diskNotesFilesIO(requireString(input.dataDir, "Notes dataDir"));
  const file = (input: any) => {
    const name = requireString(input.file, "Notes file");
    if (!isNotesFile(name)) throw new Error(`"${name}" is not a notes file.`);
    return name;
  };
  return {
    id: NOTES_FILES_CAPABILITY_ID,
    kind: "notes-files",
    name: "Notes Files",
    operations: {
      read: op((input: any) => io(input).read(file(input))),
      write: op(async (input: any) => {
        await io(input).write(file(input), optionalString(input.text) ?? "");
        return null;
      }, "action"),
      delete: op(async (input: any) => {
        await io(input).delete(file(input));
        return null;
      }, "action"),
      listKeys: op((input: any) => io(input).listKeys()),
    },
  };
}

export function registerElectrobunCoreCapabilities(options: CoreCapabilityOptions): void {
  const registry = options.getServices().pluginRegistry.capabilities;
  registry.register(DESKTOP_CORE_PLUGIN_ID, createBrokerCapability(options));
  registry.register(DESKTOP_CORE_PLUGIN_ID, createNotesFilesCapability());
}
