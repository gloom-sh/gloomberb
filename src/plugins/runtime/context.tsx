import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import type { BrokerAdapter } from "../../types/broker";
import type { ConnectionHealthRegistry } from "../../core/connection-health";
import type { CapabilityInvoker, PluginCapability } from "../../capabilities";
import type { DataProvider } from "../../types/data-provider";
import type { PluginRuntimeHostActions } from "../registry/host-actions";

export interface PluginRuntimeAccess extends CapabilityInvoker, PluginRuntimeHostActions {
  getMarketData(): DataProvider | null;
  getConnectionHealth(): ConnectionHealthRegistry;
  getCapability(capabilityId: string): PluginCapability | null;
  getBrokerAdapter(brokerType: string): BrokerAdapter | null;
  /** Every broker adapter installed now, read when called: plugins come and go. */
  listBrokerAdapters(): BrokerAdapter[];
  subscribeResumeState(pluginId: string, key: string, listener: () => void): () => void;
  getResumeState<T = unknown>(pluginId: string, key: string, schemaVersion?: number): T | null;
  setResumeState(pluginId: string, key: string, value: unknown, schemaVersion?: number): void;
  deleteResumeState(pluginId: string, key: string): void;
  getConfigState<T = unknown>(pluginId: string, key: string): T | null;
  setConfigState(pluginId: string, key: string, value: unknown): Promise<void>;
  setConfigStates(pluginId: string, values: Record<string, unknown>): Promise<void>;
  deleteConfigState(pluginId: string, key: string): Promise<void>;
  getConfigStateKeys(pluginId: string): string[];
}

interface PluginRenderContextValue {
  pluginId: string;
  runtime: PluginRuntimeAccess;
}

const PluginRenderContext = createContext<PluginRenderContextValue | null>(null);

export function PluginRenderProvider({
  pluginId,
  runtime,
  children,
}: {
  pluginId: string;
  runtime: PluginRuntimeAccess;
  children: ReactNode;
}) {
  return (
    <PluginRenderContext value={{ pluginId, runtime }}>
      {children}
    </PluginRenderContext>
  );
}

/**
 * Renders a plugin's pane, tab or slot inside its render context. Pass the
 * plugin's state namespace so every surface of one plugin reads the same state.
 */
export function withPluginRender<P>(
  pluginId: string,
  runtime: PluginRuntimeAccess,
  component: (props: P) => ReactNode,
): (props: P) => ReactNode {
  return (props) => (
    <PluginRenderProvider pluginId={pluginId} runtime={runtime}>
      {createElement(component as (props: any) => ReactNode, props)}
    </PluginRenderProvider>
  );
}

export function usePluginRenderContext(): PluginRenderContextValue {
  const context = useContext(PluginRenderContext);
  if (!context) {
    throw new Error("Plugin runtime hooks must be used inside a plugin render context");
  }
  return context;
}
