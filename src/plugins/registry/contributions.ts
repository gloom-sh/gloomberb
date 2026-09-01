import type { BrokerAdapter } from "../../types/broker";
import type {
  CommandBarSearchProvider,
  CommandDef,
  ContextMenuProviderDef,
  CustomColumnDef,
  KeyboardShortcut,
  PaneDef,
  PaneTemplateDef,
  TickerAction,
  TickerResearchTabDef,
} from "../../types/plugin";

export interface ContextMenuProviderEntry {
  pluginId: string;
  provider: ContextMenuProviderDef;
}

export interface PluginItems {
  panes: string[];
  paneTemplates: string[];
  commands: string[];
  commandBarSearchProviders: string[];
  columns: string[];
  brokers: string[];
  capabilities: string[];
  tickerResearchTabs: string[];
  shortcuts: string[];
  tickerActions: string[];
  contextMenuProviders: string[];
  eventDisposers: Array<() => void>;
  capabilityDisposers: Array<() => void>;
  newsQueryWatchDisposers: Array<() => void>;
}

interface RegistryContributionsOptions {
  wrapPaneDef: (pluginId: string, pane: PaneDef) => PaneDef;
  wrapTickerResearchTabDef: (pluginId: string, tab: TickerResearchTabDef) => TickerResearchTabDef;
  wrapBrokerAdapter?: (broker: BrokerAdapter, pluginId: string) => BrokerAdapter;
}

function setUnique<T>(map: Map<string, T>, id: string, value: T): void {
  if (map.has(id)) throw new Error(`Duplicate plugin contribution id: ${id}`);
  map.set(id, value);
}

export class RegistryContributions {
  readonly pluginItems = new Map<string, PluginItems>();
  readonly commandOwners = new Map<string, string>();
  readonly commandBarSearchProviderOwners = new Map<string, string>();
  readonly paneOwners = new Map<string, string>();
  readonly paneTemplateOwners = new Map<string, string>();
  readonly shortcutOwners = new Map<string, string>();
  readonly capabilityOwners = new Map<string, string>();
  readonly tickerResearchTabOwners = new Map<string, string>();

  readonly panesMap = new Map<string, PaneDef>();
  readonly paneTemplatesMap = new Map<string, PaneTemplateDef>();
  readonly commandsMap = new Map<string, CommandDef>();
  readonly commandBarSearchProvidersMap = new Map<string, CommandBarSearchProvider>();
  readonly columnsMap = new Map<string, CustomColumnDef>();
  readonly brokersMap = new Map<string, BrokerAdapter>();
  readonly tickerResearchTabsMap = new Map<string, TickerResearchTabDef>();
  readonly shortcutsMap = new Map<string, KeyboardShortcut>();
  readonly tickerActionsMap = new Map<string, TickerAction>();
  readonly contextMenuProvidersMap = new Map<string, ContextMenuProviderEntry>();

  constructor(private readonly options: RegistryContributionsOptions) {}

  getOrCreatePluginItems(pluginId: string): PluginItems {
    const existing = this.pluginItems.get(pluginId);
    if (existing) return existing;

    const items: PluginItems = {
      panes: [],
      paneTemplates: [],
      commands: [],
      commandBarSearchProviders: [],
      columns: [],
      brokers: [],
      capabilities: [],
      tickerResearchTabs: [],
      shortcuts: [],
      tickerActions: [],
      contextMenuProviders: [],
      eventDisposers: [],
      capabilityDisposers: [],
      newsQueryWatchDisposers: [],
    };
    this.pluginItems.set(pluginId, items);
    return items;
  }

  registerPane(pluginId: string, pane: PaneDef, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.panesMap, pane.id, this.options.wrapPaneDef(pluginId, pane));
    this.paneOwners.set(pane.id, pluginId);
    items.panes.push(pane.id);
  }

  registerPaneTemplate(pluginId: string, template: PaneTemplateDef, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.paneTemplatesMap, template.id, template);
    this.paneTemplateOwners.set(template.id, pluginId);
    items.paneTemplates.push(template.id);
  }

  registerCommand(pluginId: string, command: CommandDef, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.commandsMap, command.id, command);
    this.commandOwners.set(command.id, pluginId);
    items.commands.push(command.id);
  }

  registerCommandBarSearchProvider(
    pluginId: string,
    provider: CommandBarSearchProvider,
    items = this.getOrCreatePluginItems(pluginId),
  ): () => void {
    setUnique(this.commandBarSearchProvidersMap, provider.id, provider);
    this.commandBarSearchProviderOwners.set(provider.id, pluginId);
    items.commandBarSearchProviders.push(provider.id);
    return () => {
      // Only the registration still in place may be withdrawn: a re-registered
      // provider under the same id belongs to whoever registered it last.
      if (this.commandBarSearchProvidersMap.get(provider.id) !== provider) return;
      this.commandBarSearchProvidersMap.delete(provider.id);
      this.commandBarSearchProviderOwners.delete(provider.id);
      items.commandBarSearchProviders = items.commandBarSearchProviders.filter((id) => id !== provider.id);
    };
  }

  registerColumn(_pluginId: string, column: CustomColumnDef, items: PluginItems): void {
    setUnique(this.columnsMap, column.id, column);
    items.columns.push(column.id);
  }

  registerBroker(pluginId: string, broker: BrokerAdapter, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.brokersMap, broker.id, this.options.wrapBrokerAdapter?.(broker, pluginId) ?? broker);
    items.brokers.push(broker.id);
  }

  registerCapability(pluginId: string, capabilityId: string, items: PluginItems): void {
    this.capabilityOwners.set(capabilityId, pluginId);
    items.capabilities.push(capabilityId);
  }

  registerTickerResearchTab(pluginId: string, tab: TickerResearchTabDef, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.tickerResearchTabsMap, tab.id, this.options.wrapTickerResearchTabDef(pluginId, tab));
    this.tickerResearchTabOwners.set(tab.id, pluginId);
    items.tickerResearchTabs.push(tab.id);
  }

  registerShortcut(pluginId: string, shortcut: KeyboardShortcut, items = this.getOrCreatePluginItems(pluginId)): void {
    setUnique(this.shortcutsMap, shortcut.id, shortcut);
    this.shortcutOwners.set(shortcut.id, pluginId);
    items.shortcuts.push(shortcut.id);
  }

  registerTickerAction(_pluginId: string, action: TickerAction, items: PluginItems): void {
    setUnique(this.tickerActionsMap, action.id, action);
    items.tickerActions.push(action.id);
  }

  registerContextMenuProvider(pluginId: string, provider: ContextMenuProviderDef, items: PluginItems): void {
    const providerKey = `${pluginId}:${provider.id}`;
    this.contextMenuProvidersMap.set(providerKey, { pluginId, provider });
    items.contextMenuProviders.push(providerKey);
  }

  unregister(pluginId: string): void {
    const items = this.pluginItems.get(pluginId);
    if (!items) return;

    for (const paneId of items.panes) {
      this.panesMap.delete(paneId);
      this.paneOwners.delete(paneId);
    }
    for (const templateId of items.paneTemplates) {
      this.paneTemplatesMap.delete(templateId);
      this.paneTemplateOwners.delete(templateId);
    }
    for (const commandId of items.commands) {
      this.commandsMap.delete(commandId);
      this.commandOwners.delete(commandId);
    }
    for (const providerId of items.commandBarSearchProviders) {
      this.commandBarSearchProvidersMap.delete(providerId);
      this.commandBarSearchProviderOwners.delete(providerId);
    }
    for (const columnId of items.columns) this.columnsMap.delete(columnId);
    for (const brokerId of items.brokers) this.brokersMap.delete(brokerId);
    for (const capabilityId of items.capabilities) this.capabilityOwners.delete(capabilityId);
    for (const tabId of items.tickerResearchTabs) {
      this.tickerResearchTabsMap.delete(tabId);
      this.tickerResearchTabOwners.delete(tabId);
    }
    for (const shortcutId of items.shortcuts) {
      this.shortcutsMap.delete(shortcutId);
      this.shortcutOwners.delete(shortcutId);
    }
    for (const actionId of items.tickerActions) this.tickerActionsMap.delete(actionId);
    for (const providerKey of items.contextMenuProviders) this.contextMenuProvidersMap.delete(providerKey);
    let disposeError: unknown;
    for (const dispose of [...items.eventDisposers, ...items.capabilityDisposers, ...items.newsQueryWatchDisposers]) {
      try {
        dispose();
      } catch (error) {
        disposeError ??= error;
      }
    }
    this.pluginItems.delete(pluginId);
    if (disposeError) throw disposeError;
  }
}
