import type { TickerRecord } from "../types/ticker";
import type { TickerFinancials } from "../types/financials";
import type { AppConfig } from "../types/config";
import { debugLog } from "../utils/debug-log";

const busLog = debugLog.createLogger("event-bus");

/** All events plugins can subscribe to or emit */
export interface PluginEvents {
  "ticker:selected": { symbol: string | null; previous: string | null };
  "ticker:refreshed": { symbol: string; financials: TickerFinancials };
  "ticker:added": { symbol: string; ticker: TickerRecord };
  "ticker:removed": { symbol: string };
  "command-bar:portfolio-membership-persisted": { symbol: string; portfolioId: string };
  "config:changed": { config: AppConfig };
  "plugin:registered": { pluginId: string };
  "plugin:unregistered": { pluginId: string };
}

type EventHandler<T> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventHandler<any>>>();

  on<K extends keyof PluginEvents>(event: K, handler: EventHandler<PluginEvents[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return () => { this.listeners.get(event)?.delete(handler); };
  }

  emit<K extends keyof PluginEvents>(event: K, payload: PluginEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try { handler(payload); } catch (err) {
        busLog.error(`Handler error on ${String(event)}: ${err}`);
      }
    }
  }
}
