import type { AppServices } from "../../../../core/app-services";
import type { DesktopCapabilityRequest } from "../../shared/protocol";
import { encodeRpcValue } from "../../view/rpc-codec";

type CapabilityRegistry = AppServices["pluginRegistry"]["capabilities"];

interface DesktopCapabilityRpc {
  send: {
    "capability.event": (payload: { subscriptionId: string; event: unknown }) => void;
  };
}

interface DesktopCapabilityBridgeOptions<Rpc extends DesktopCapabilityRpc> {
  getRegistry: () => CapabilityRegistry;
  getWindowKey: (rpc: Rpc) => string | null | undefined;
}

export class DesktopCapabilityBridge<Rpc extends DesktopCapabilityRpc> {
  private readonly subscriptions = new Map<string, () => void>();
  private readonly invocations = new Map<string, AbortController>();

  constructor(private readonly options: DesktopCapabilityBridgeOptions<Rpc>) {}

  disposeAll(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      try {
        unsubscribe();
      } catch {
        // ignore teardown failures
      }
    }
    this.subscriptions.clear();
    for (const controller of this.invocations.values()) controller.abort();
    this.invocations.clear();
  }

  disposeWindow(windowKey: string): void {
    const scopedPrefix = `${windowKey}:`;
    for (const [id, unsubscribe] of this.subscriptions) {
      if (!id.startsWith(scopedPrefix)) continue;
      try {
        unsubscribe();
      } catch {
        // ignore teardown failures
      }
      this.subscriptions.delete(id);
    }
    for (const [id, controller] of this.invocations) {
      if (!id.startsWith(scopedPrefix)) continue;
      controller.abort();
      this.invocations.delete(id);
    }
  }

  async handle(
    rpc: Rpc,
    request: DesktopCapabilityRequest,
  ): Promise<unknown> {
    const registry = this.options.getRegistry();
    switch (request.method) {
      case "capability.invoke": {
        const clientInvocationId = request.payload.invocationId;
        if (!clientInvocationId) {
          return registry.invoke(
            request.payload.capabilityId,
            request.payload.operationId,
            request.payload.payload,
            { renderer: true },
          );
        }
        const scopedInvocationId = this.scopeClientId(rpc, clientInvocationId);
        if (this.invocations.has(scopedInvocationId)) {
          throw new Error(`Capability invocation "${clientInvocationId}" is already active.`);
        }
        const controller = new AbortController();
        this.invocations.set(scopedInvocationId, controller);
        try {
          return await registry.invoke(
            request.payload.capabilityId,
            request.payload.operationId,
            request.payload.payload,
            { renderer: true, signal: controller.signal },
          );
        } finally {
          if (this.invocations.get(scopedInvocationId) === controller) {
            this.invocations.delete(scopedInvocationId);
          }
        }
      }
      case "capability.cancel": {
        this.invocations.get(this.scopeClientId(rpc, request.payload.invocationId))?.abort();
        return null;
      }
      case "capability.subscribe": {
        const clientSubscriptionId = request.payload.subscriptionId;
        const scopedSubscriptionId = this.scopeClientId(rpc, clientSubscriptionId);
        this.subscriptions.get(scopedSubscriptionId)?.();
        await registry.subscribe(
          request.payload.capabilityId,
          request.payload.operationId,
          request.payload.payload,
          (event) => {
            rpc.send["capability.event"]({
              subscriptionId: clientSubscriptionId,
              event: encodeRpcValue(event),
            });
          },
          { renderer: true, subscriptionId: scopedSubscriptionId },
        );
        this.subscriptions.set(scopedSubscriptionId, () => registry.unsubscribe(scopedSubscriptionId));
        return null;
      }
      case "capability.unsubscribe": {
        const scopedSubscriptionId = this.scopeClientId(rpc, request.payload.subscriptionId);
        this.subscriptions.get(scopedSubscriptionId)?.();
        this.subscriptions.delete(scopedSubscriptionId);
        return null;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown capability method: ${String(exhaustive)}`);
      }
    }
  }

  private scopeClientId(rpc: Rpc, id: string): string {
    return `${this.options.getWindowKey(rpc) ?? "window"}:${id}`;
  }
}
