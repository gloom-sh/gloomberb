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
  eventDisposers: Array<() => void>;
  capabilityDisposers: Array<() => void>;
  newsQueryWatchDisposers: Array<() => void>;
}

interface RegistryContributionsOptions {
  wrapPaneDef: (pluginId: string, pane: PaneDef) => PaneDef;
  wrapTickerResearchTabDef: (pluginId: string, tab: TickerResearchTabDef) => TickerResearchTabDef;
  wrapBrokerAdapter?: (broker: BrokerAdapter, pluginId: string) => BrokerAdapter;
}

/** Registration and ownership change together, including explicit withdrawal. */
class OwnedContributions<T> extends Map<string, T> {
  readonly owners = new Map<string, string>();

  register(pluginId: string, id: string, value: T, replace = false): () => void {
    if (!replace && this.has(id)) throw new Error(`Duplicate plugin contribution id: ${id}`);
    this.set(id, value);
    this.owners.set(id, pluginId);
    return () => {
      if (this.get(id) !== value || this.owners.get(id) !== pluginId) return;
      this.delete(id);
      this.owners.delete(id);
    };
  }

  ids(pluginId: string): string[] {
    return [...this.owners].filter(([, owner]) => owner === pluginId).map(([id]) => id);
  }

  unregister(pluginId: string): void {
    for (const id of this.ids(pluginId)) {
      this.delete(id);
      this.owners.delete(id);
    }
  }
}

export class RegistryContributions {
  readonly pluginItems = new Map<string, PluginItems>();
  readonly capabilityOwners = new Map<string, string>();

  readonly panesMap = new OwnedContributions<PaneDef>();
  readonly paneTemplatesMap = new OwnedContributions<PaneTemplateDef>();
  readonly commandsMap = new OwnedContributions<CommandDef>();
  readonly commandBarSearchProvidersMap = new OwnedContributions<CommandBarSearchProvider>();
  readonly columnsMap = new OwnedContributions<CustomColumnDef>();
  readonly brokersMap = new OwnedContributions<BrokerAdapter>();
  readonly tickerResearchTabsMap = new OwnedContributions<TickerResearchTabDef>();
  readonly shortcutsMap = new OwnedContributions<KeyboardShortcut>();
  readonly tickerActionsMap = new OwnedContributions<TickerAction>();
  readonly contextMenuProvidersMap = new OwnedContributions<ContextMenuProviderEntry>();

  constructor(private readonly options: RegistryContributionsOptions) { }

  getOrCreatePluginItems(pluginId: string): PluginItems {
    const existing = this.pluginItems.get(pluginId);
    if (existing) return existing;

    const items: PluginItems = { eventDisposers: [], capabilityDisposers: [], newsQueryWatchDisposers: [] };
    this.pluginItems.set(pluginId, items);
    return items;
  }

  registerPane(pluginId: string, pane: PaneDef): void {
    this.panesMap.register(pluginId, pane.id, this.options.wrapPaneDef(pluginId, pane));
  }

  registerPaneTemplate(pluginId: string, template: PaneTemplateDef): void {
    this.paneTemplatesMap.register(pluginId, template.id, template);
  }

  registerCommand(pluginId: string, command: CommandDef): void {
    this.commandsMap.register(pluginId, command.id, command);
  }

  registerCommandBarSearchProvider(pluginId: string, provider: CommandBarSearchProvider): () => void {
    return this.commandBarSearchProvidersMap.register(pluginId, provider.id, provider);
  }

  registerColumn(pluginId: string, column: CustomColumnDef): void {
    this.columnsMap.register(pluginId, column.id, column);
  }

  registerBroker(pluginId: string, broker: BrokerAdapter): void {
    this.brokersMap.register(pluginId, broker.id, this.options.wrapBrokerAdapter?.(broker, pluginId) ?? broker);
  }

  registerCapability(pluginId: string, capabilityId: string): void {
    this.capabilityOwners.set(capabilityId, pluginId);
  }

  registerTickerResearchTab(pluginId: string, tab: TickerResearchTabDef): void {
    this.tickerResearchTabsMap.register(pluginId, tab.id, this.options.wrapTickerResearchTabDef(pluginId, tab));
  }

  registerShortcut(pluginId: string, shortcut: KeyboardShortcut): void {
    this.shortcutsMap.register(pluginId, shortcut.id, shortcut);
  }

  registerTickerAction(pluginId: string, action: TickerAction): void {
    this.tickerActionsMap.register(pluginId, action.id, action);
  }

  registerContextMenuProvider(pluginId: string, provider: ContextMenuProviderDef): void {
    this.contextMenuProvidersMap.register(pluginId, `${pluginId}:${provider.id}`, { pluginId, provider }, true);
  }

  unregister(pluginId: string): void {
    const items = this.pluginItems.get(pluginId);
    if (!items) return;

    for (const collection of [
      this.panesMap, this.paneTemplatesMap, this.commandsMap, this.commandBarSearchProvidersMap,
      this.columnsMap, this.brokersMap, this.tickerResearchTabsMap, this.shortcutsMap,
      this.tickerActionsMap, this.contextMenuProvidersMap,
    ]) collection.unregister(pluginId);
    for (const [id, owner] of this.capabilityOwners) {
      if (owner === pluginId) this.capabilityOwners.delete(id);
    }
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
