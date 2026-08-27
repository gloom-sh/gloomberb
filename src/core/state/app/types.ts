import type { BrokerAccount } from "../../../types/trading";
import type { AppConfig, LayoutConfig, OnboardingProgress } from "../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../types/desktop-window";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { ReleaseInfo, UpdateProgress } from "../../../updater";

export interface PaneRuntimeState {
  cursorSymbol?: string | null;
  collectionId?: string;
  activeTabId?: string;
  collectionSorts?: Record<string, CollectionSortPreference>;
  pluginState?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface LayoutHistoryEntry {
  past: LayoutConfig[];
  future: LayoutConfig[];
}

type SortDirection = "asc" | "desc";

export interface CollectionSortPreference {
  columnId: string | null;
  direction: SortDirection;
}

interface CommandBarLaunchRequestBase {
  sequence: number;
}

interface CommandBarPluginLaunchRequest extends CommandBarLaunchRequestBase {
  kind: "plugin-command";
  commandId: string;
}

interface CommandBarTickerSearchLaunchRequest extends CommandBarLaunchRequestBase {
  kind: "ticker-search";
  query?: string;
}

export interface AppState {
  config: AppConfig;
  tickers: Map<string, TickerRecord>;
  financials: Map<string, TickerFinancials>;
  exchangeRates: Map<string, number>;
  brokerAccounts: Record<string, BrokerAccount[]>;
  activePanel: "left" | "right";
  focusedPaneId: string | null;
  previousFocusedPaneId: string | null;
  paneState: Record<string, PaneRuntimeState>;
  recentTickers: string[];
  commandBarOpen: boolean;
  commandBarQuery: string;
  commandBarLaunchRequest: CommandBarPluginLaunchRequest | CommandBarTickerSearchLaunchRequest | null;
  themePreview: string | null;
  refreshing: Set<string>;
  initialized: boolean;
  statusBarVisible: boolean;
  inputCaptured: boolean;
  updateAvailable: ReleaseInfo | null;
  updateProgress: UpdateProgress | null;
  updateCheckInProgress: boolean;
  updateNotice: string | null;
  layoutHistory: Record<number, LayoutHistoryEntry>;
}

export type AppAction =
  | { type: "SET_CONFIG"; config: AppConfig }
  | {
      type: "SET_ONBOARDING_STATE";
      complete: boolean;
      progress: OnboardingProgress | undefined;
    }
  | { type: "SET_TICKERS"; tickers: Map<string, TickerRecord> }
  | { type: "UPDATE_TICKER"; ticker: TickerRecord }
  | { type: "REMOVE_TICKER"; symbol: string }
  | { type: "SET_FINANCIALS"; symbol: string; data: TickerFinancials }
  | { type: "MERGE_QUOTE"; symbol: string; quote: Quote }
  | { type: "HYDRATE_FINANCIALS"; financials: Map<string, TickerFinancials> }
  | { type: "TRACK_TICKER"; symbol: string | null }
  | { type: "SET_ACTIVE_PANEL"; panel: "left" | "right"; preserveFocus?: boolean }
  | { type: "TOGGLE_COMMAND_BAR" }
  | {
      type: "SET_COMMAND_BAR";
      open: boolean;
      query?: string;
      launch?: { kind: "plugin-command"; commandId: string } | { kind: "ticker-search"; query?: string } | null;
    }
  | { type: "SET_COMMAND_BAR_QUERY"; query: string }
  | { type: "SET_REFRESHING"; symbol: string; refreshing: boolean }
  | { type: "SET_BROKER_ACCOUNTS"; instanceId: string; accounts: BrokerAccount[] }
  | { type: "SET_INITIALIZED" }
  | { type: "TOGGLE_STATUS_BAR" }
  | { type: "SET_THEME"; theme: string }
  | { type: "PREVIEW_THEME"; theme: string | null }
  | { type: "SET_UPDATE_AVAILABLE"; release: ReleaseInfo | null }
  | { type: "SET_UPDATE_PROGRESS"; progress: UpdateProgress | null }
  | { type: "SET_UPDATE_CHECK_IN_PROGRESS"; checking: boolean }
  | { type: "SET_UPDATE_NOTICE"; notice: string | null }
  | { type: "TOGGLE_PLUGIN"; pluginId: string }
  | { type: "SET_INPUT_CAPTURED"; captured: boolean }
  | { type: "SET_EXCHANGE_RATE"; currency: string; rate: number }
  | { type: "HYDRATE_EXCHANGE_RATES"; exchangeRates: Map<string, number> }
  | { type: "PUSH_LAYOUT_HISTORY" }
  | { type: "UNDO_LAYOUT" }
  | { type: "REDO_LAYOUT" }
  | { type: "UPDATE_LAYOUT"; layout: LayoutConfig; focusedPaneId?: string | null }
  | { type: "SWITCH_LAYOUT"; index: number }
  | { type: "REORDER_LAYOUT"; fromIndex: number; toIndex: number }
  | { type: "NEW_LAYOUT"; name: string }
  | { type: "INSTALL_LAYOUT_COPY"; name: string; layout: LayoutConfig }
  | { type: "DELETE_LAYOUT"; index: number }
  | { type: "RENAME_LAYOUT"; index: number; name: string }
  | { type: "DUPLICATE_LAYOUT"; index: number }
  | { type: "FOCUS_PANE"; paneId: string }
  | { type: "FOCUS_NEXT"; paneOrder: string[] }
  | { type: "FOCUS_PREV"; paneOrder: string[] }
  | { type: "HYDRATE_DESKTOP_SNAPSHOT"; snapshot: DesktopSharedStateSnapshot }
  | {
      type: "UPDATE_PLUGIN_PANE_STATE";
      paneId: string;
      pluginId: string;
      key: string;
      value: unknown;
    }
  | { type: "REPLACE_PANE_STATE"; paneId: string; state: PaneRuntimeState }
  | { type: "UPDATE_PANE_STATE"; paneId: string; patch: Partial<PaneRuntimeState> };
