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
import type {
  AppNotificationRequest,
  BrokerInstanceUpdateOptions,
  PaneDef,
  PaneTemplateCreateOptions,
  PinTickerOptions,
  TickerResearchTabDef,
} from "../../types/plugin";

export interface PluginRuntimeAccess extends CapabilityInvoker {
  getMarketData(): DataProvider | null;
  getConnectionHealth(): ConnectionHealthRegistry;
  getCapability(capabilityId: string): PluginCapability | null;
  getBrokerAdapter(brokerType: string): BrokerAdapter | null;
  connectBrokerInstance(instanceId: string): Promise<void>;
  updateBrokerInstance(instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions): Promise<void>;
  syncBrokerInstance(instanceId: string): Promise<void>;
  removeBrokerInstance(instanceId: string): Promise<void>;
  pinTicker(symbol: string, options?: PinTickerOptions): void;
  navigateTicker(symbol: string, options?: { sourcePaneId?: string | null }): void;
  selectTicker(symbol: string, paneId?: string): void;
  switchTab(tabId: string, paneId?: string): void;
  switchPanel(panel: "left" | "right"): void;
  openCommandBar(query?: string): void;
  showPane(paneId: string): void;
  createPaneFromTemplate(templateId: string, options?: PaneTemplateCreateOptions): void;
  hidePane(paneId: string): void;
  focusPane(paneId: string): void;
  openPaneSettings(paneId?: string): void;
  openPluginCommandWorkflow(commandId: string): void;
  notify(notification: AppNotificationRequest): void;
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

export function wrapPaneDefWithRuntime(
  pluginId: string,
  pane: PaneDef,
  runtime: PluginRuntimeAccess,
): PaneDef {
  return {
    ...pane,
    component: (props) => createElement(
      PluginRenderProvider,
      {
        pluginId,
        runtime,
        children: createElement(pane.component as any, props),
      },
    ),
  };
}

export function wrapTickerResearchTabDefWithRuntime(
  pluginId: string,
  tab: TickerResearchTabDef,
  runtime: PluginRuntimeAccess,
): TickerResearchTabDef {
  return {
    ...tab,
    component: (props) => createElement(
      PluginRenderProvider,
      {
        pluginId,
        runtime,
        children: createElement(tab.component as any, props),
      },
    ),
  };
}

export function usePluginRenderContext(): PluginRenderContextValue {
  const context = useContext(PluginRenderContext);
  if (!context) {
    throw new Error("Plugin runtime hooks must be used inside a plugin render context");
  }
  return context;
}
