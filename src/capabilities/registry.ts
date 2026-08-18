import {
  recordSchema,
  type CapabilityManifest,
  type CapabilityOperationManifest,
  type CapabilityRegistryOptions,
  type PluginCapability,
  type RegisteredCapability,
} from "./types";

interface SubscriptionEntry {
  capabilityId: string;
  dispose: () => void;
}

const LOCAL_READ_OPERATIONS = new Set([
  "canProvide",
  "supports",
  "getCachedFinancialsForTargets",
  "getCachedNews",
  "getChartResolutionSupport",
  "getChartResolutionCapabilities",
]);

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private nextSubscriptionId = 1;

  constructor(private readonly options: CapabilityRegistryOptions = {}) {}

  register(pluginId: string, capability: PluginCapability): () => void {
    const existing = this.capabilities.get(capability.id);
    if (existing) {
      throw new Error(`Capability "${capability.id}" already registered by plugin "${existing.pluginId}".`);
    }
    const registration = { pluginId, capability };
    this.capabilities.set(capability.id, registration);
    return () => {
      if (this.capabilities.get(capability.id) !== registration) return;
      this.capabilities.delete(capability.id);
      let firstError: unknown;
      for (const [subscriptionId, entry] of this.subscriptions) {
        if (entry.capabilityId === capability.id) {
          try {
            this.unsubscribe(subscriptionId);
          } catch (error) {
            firstError ??= error;
          }
        }
      }
      if (firstError) throw firstError;
    };
  }

  get(id: string): RegisteredCapability | undefined {
    return this.capabilities.get(id);
  }

  list(kind?: string): RegisteredCapability[] {
    return [...this.capabilities.values()]
      .filter((entry) => !kind || entry.capability.kind === kind)
      .filter((entry) => this.isEnabled(entry))
      .sort((left, right) => (
        (left.capability.priority ?? 1000) - (right.capability.priority ?? 1000)
        || left.capability.id.localeCompare(right.capability.id)
      ));
  }

  manifests({ rendererOnly = false }: { rendererOnly?: boolean } = {}): CapabilityManifest[] {
    return this.list().map(({ capability }) => {
      const operations: CapabilityOperationManifest[] = Object.entries(capability.operations)
        .filter(([, operation]) => !rendererOnly || operation.rendererSafe === true)
        .map(([id, operation]) => ({
          id,
          kind: operation.kind,
          rendererSafe: operation.rendererSafe === true,
          ...operation.cli,
        }));
      return {
        id: capability.id,
        kind: capability.kind,
        name: capability.name,
        priority: capability.priority,
        sourceId: capability.sourceId,
        operations,
      };
    });
  }

  async invoke<T = unknown>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    options: { renderer?: boolean } = {},
  ): Promise<T> {
    const { capability, operation } = this.resolveOperation(capabilityId, operationId, options);
    if (!operation.handler) throw new Error(`Capability operation "${capabilityId}.${operationId}" is not invokable.`);
    const input = (operation.input ?? recordSchema).parse(payload);
    const invoke = () => Promise.resolve(operation.handler!(input, { capability, operationId }));
    const health = this.options.connectionHealth;
    const result = health?.hasSource(capabilityId) && !LOCAL_READ_OPERATIONS.has(operationId)
      ? await health.track(capabilityId, operationId, invoke)
      : await invoke();
    return (operation.output ? operation.output.parse(result) : result) as T;
  }

  async subscribe<T = unknown>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    emit: (event: T) => void,
    options: { renderer?: boolean; subscriptionId?: string } = {},
  ): Promise<string> {
    const { capability, operation } = this.resolveOperation(capabilityId, operationId, options);
    if (!operation.subscribe) throw new Error(`Capability operation "${capabilityId}.${operationId}" is not subscribable.`);
    const input = (operation.input ?? recordSchema).parse(payload);
    const subscriptionId = options.subscriptionId ?? `${capabilityId}:${operationId}:${this.nextSubscriptionId++}`;
    this.unsubscribe(subscriptionId);
    const dispose = await operation.subscribe(input, emit, { capability, operationId });
    if (this.capabilities.get(capabilityId)?.capability !== capability) {
      dispose();
      throw new Error(`Capability "${capabilityId}" is not available.`);
    }
    this.subscriptions.set(subscriptionId, { capabilityId, dispose });
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) return;
    this.subscriptions.delete(subscriptionId);
    entry.dispose();
  }

  destroy(): void {
    for (const subscriptionId of [...this.subscriptions.keys()]) {
      try {
        this.unsubscribe(subscriptionId);
      } catch {
        // Continue releasing the remaining subscriptions.
      }
    }
    this.capabilities.clear();
  }

  private resolveOperation(capabilityId: string, operationId: string, options: { renderer?: boolean }) {
    const entry = this.capabilities.get(capabilityId);
    if (!entry || !this.isEnabled(entry)) throw new Error(`Capability "${capabilityId}" is not available.`);
    const operation = entry.capability.operations[operationId];
    if (!operation) throw new Error(`Capability operation "${capabilityId}.${operationId}" is not available.`);
    if (options.renderer && operation.rendererSafe !== true) {
      throw new Error(`Capability operation "${capabilityId}.${operationId}" is not available to renderers.`);
    }
    return { ...entry, operation };
  }

  private isEnabled(entry: RegisteredCapability): boolean {
    if (this.options.isPluginEnabled && !this.options.isPluginEnabled(entry.pluginId)) return false;
    if (this.options.isCapabilityEnabled && !this.options.isCapabilityEnabled(entry.capability, entry.pluginId)) return false;
    return entry.capability.isEnabled?.() ?? true;
  }
}
