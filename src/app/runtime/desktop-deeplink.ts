import { useEffect, type Dispatch } from "react";
import { getDockedPaneIds } from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import {
  findPaneInstance,
  resolveFollowBindingInstance,
  TICKER_RESEARCH_PANE_ID,
} from "../../types/config";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import { requestAccountManagementTab } from "../../plugins/builtin/account-management/navigation";
import { chatController } from "../../plugins/builtin/chat/controller";
import { getShare } from "../../shares/api";
import { openPaneShare } from "../../shares/pane";

type CloudDeepLinkRoute = {
  kind: "cloud-alerts" | "cloud-emails" | "cloud-roundup" | "cloud-success";
  week: string | null;
};

type CollectionDeepLinkKind = "collection" | "portfolio" | "watchlist";
type AlertDeepLinkCondition = "above" | "below" | "crosses";
type NewsDeepLinkKind = "breaking" | "feed" | "ticker" | "top";
const SHARE_ID = /^[a-f0-9]{32}$/;

export type DesktopDeepLinkAction =
  | { type: "open-account-management"; route: CloudDeepLinkRoute; message: string }
  | { type: "open-ticker"; symbol: string; tabId: string | null; message: string }
  | { type: "open-collection"; kind: CollectionDeepLinkKind; collectionId: string; message: string }
  | {
      type: "create-alert";
      values: { symbol: string; condition: AlertDeepLinkCondition; price: string };
      message: string;
    }
  | { type: "open-chat-channel"; channelId: string; messageId: string | null; message: string }
  | { type: "open-chat-dm"; participants: string; message: string }
  | { type: "open-news"; kind: NewsDeepLinkKind; symbol: string | null; message: string }
  | { type: "open-share"; id: string; message: string }
  | { type: "unsupported"; message: string };

interface ParsedGloomUrl {
  url: URL;
  host: string;
  segments: string[];
}

interface DesktopDeepLinkHandlerOptions {
  dispatch: Dispatch<AppAction>;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
}

function weekSuffix(week: string | null): string {
  return week ? ` for ${week}` : "";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => safeDecode(segment).trim())
    .filter(Boolean);
}

function parseGloomUrl(rawUrl: string): ParsedGloomUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "gloomberb:") return null;

  const host = url.hostname.trim().toLowerCase();
  if (host) {
    return { url, host, segments: splitPathSegments(url.pathname) };
  }

  const segments = splitPathSegments(url.pathname);
  const opaqueHost = segments.shift()?.toLowerCase();
  return opaqueHost ? { url, host: opaqueHost, segments } : null;
}

function param(url: URL, ...names: string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function normalizeSymbol(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^\$/, "");
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

function normalizeAlertCondition(value: string | null): AlertDeepLinkCondition | null {
  switch (value?.trim().toLowerCase()) {
    case ">":
    case "above":
    case "over":
    case "gt":
      return "above";
    case "<":
    case "below":
    case "under":
    case "lt":
      return "below";
    case "x":
    case "cross":
    case "crosses":
      return "crosses";
    default:
      return null;
  }
}

function normalizePrice(value: string | null): string | null {
  const trimmed = value?.trim().replace(/^\$/, "");
  if (!trimmed) return null;
  const price = Number.parseFloat(trimmed);
  return Number.isFinite(price) && price > 0 ? String(price) : null;
}

function tickerMessage(symbol: string, tabId: string | null): string {
  return tabId ? `Opened ${symbol} ${tabId} tab.` : `Opened ${symbol}.`;
}

function collectionMessage(kind: CollectionDeepLinkKind, collectionId: string): string {
  const label = kind === "watchlist" ? "watchlist" : kind === "portfolio" ? "portfolio" : "collection";
  return `Opened ${label} ${collectionId}.`;
}

function parseCloudDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  const route = parsed.segments[0] ?? "";
  const week = parsed.url.searchParams.get("week");
  if (route === "roundup") {
    return {
      type: "open-account-management",
      route: { kind: "cloud-roundup", week },
      message: `Opened weekly roundup settings${weekSuffix(week)}.`,
    };
  }
  if (route === "alerts") {
    return {
      type: "open-account-management",
      route: { kind: "cloud-alerts", week },
      message: `Opened portfolio alert settings${weekSuffix(week)}.`,
    };
  }
  if (route === "emails") {
    return {
      type: "open-account-management",
      route: { kind: "cloud-emails", week: null },
      message: "Opened email settings.",
    };
  }
  if (route === "success") {
    return {
      type: "open-account-management",
      route: { kind: "cloud-success", week: null },
      message: "Pro is active.",
    };
  }
  return { type: "unsupported", message: "Unsupported Gloomberb cloud link." };
}

function parseTickerDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  const symbol = normalizeSymbol(parsed.segments[0] ?? param(parsed.url, "symbol", "ticker"));
  if (!symbol) return { type: "unsupported", message: "Ticker links need a symbol." };
  const tabId = param(parsed.url, "tab");
  return { type: "open-ticker", symbol, tabId, message: tickerMessage(symbol, tabId) };
}

function parseCollectionDeepLink(parsed: ParsedGloomUrl, kind: CollectionDeepLinkKind): DesktopDeepLinkAction {
  const collectionId = parsed.segments[0] ?? param(parsed.url, "id", "collection");
  if (!collectionId) return { type: "unsupported", message: "Collection links need an id." };
  return {
    type: "open-collection",
    kind,
    collectionId,
    message: collectionMessage(kind, collectionId),
  };
}

function parseAlertDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  if ((parsed.segments[0] ?? "new") !== "new") {
    return { type: "unsupported", message: "Unsupported Gloomberb alert link." };
  }
  const symbol = normalizeSymbol(param(parsed.url, "symbol", "ticker"));
  const condition = normalizeAlertCondition(param(parsed.url, "condition", "side", "trigger"));
  const price = normalizePrice(param(parsed.url, "price", "target"));
  if (!symbol || !condition || !price) {
    return { type: "unsupported", message: "Alert links need symbol, condition, and price." };
  }
  return {
    type: "create-alert",
    values: { symbol, condition, price },
    message: `Created ${symbol} ${condition} ${price} alert.`,
  };
}

function parseChatDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  const route = parsed.segments[0] ?? "default";
  if (route === "channel") {
    const channelId = parsed.segments[1] ?? param(parsed.url, "id", "channel");
    if (!channelId) return { type: "unsupported", message: "Chat channel links need a channel id." };
    const messageId = param(parsed.url, "message", "messageId");
    return { type: "open-chat-channel", channelId, messageId, message: `Opened chat ${channelId}.` };
  }
  if (route === "dm") {
    const participants = param(parsed.url, "users", "participants", "user") ?? parsed.segments.slice(1).join(",");
    if (!participants.trim()) return { type: "unsupported", message: "DM links need at least one username." };
    return { type: "open-chat-dm", participants, message: "Opened DM." };
  }
  if (route === "default") {
    return { type: "open-chat-channel", channelId: "", messageId: null, message: "Opened chat." };
  }
  return { type: "open-chat-channel", channelId: route, messageId: null, message: `Opened chat ${route}.` };
}

function parseNewsDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  const ticker = normalizeSymbol(param(parsed.url, "ticker", "symbol") ?? (parsed.segments[0] === "ticker" ? parsed.segments[1] : null));
  if (ticker) return { type: "open-news", kind: "ticker", symbol: ticker, message: `Opened ${ticker} news.` };

  const route = parsed.segments[0] ?? "top";
  if (route === "breaking") {
    return { type: "open-news", kind: "breaking", symbol: null, message: "Opened breaking news." };
  }
  if (route === "feed") {
    return { type: "open-news", kind: "feed", symbol: null, message: "Opened news feed." };
  }
  if (route === "top") {
    return { type: "open-news", kind: "top", symbol: null, message: "Opened top news." };
  }
  return { type: "unsupported", message: "Unsupported Gloomberb news link." };
}

function parseShareDeepLink(parsed: ParsedGloomUrl): DesktopDeepLinkAction {
  const id = parsed.segments[0] ?? param(parsed.url, "id", "share");
  return id && SHARE_ID.test(id)
    ? { type: "open-share", id, message: "Opened shared pane." }
    : { type: "unsupported", message: "Share links need a valid id." };
}

export function resolveDesktopDeepLinkAction(rawUrl: string): DesktopDeepLinkAction {
  const parsed = parseGloomUrl(rawUrl);
  if (!parsed) return { type: "unsupported", message: "Unsupported Gloomberb link." };

  switch (parsed.host) {
    case "cloud":
      return parseCloudDeepLink(parsed);
    case "ticker":
      return parseTickerDeepLink(parsed);
    case "portfolio":
      return parseCollectionDeepLink(parsed, "portfolio");
    case "watchlist":
      return parseCollectionDeepLink(parsed, "watchlist");
    case "collection":
      return parseCollectionDeepLink(parsed, "collection");
    case "alert":
      return parseAlertDeepLink(parsed);
    case "chat":
      return parseChatDeepLink(parsed);
    case "news":
      return parseNewsDeepLink(parsed);
    case "share":
      return parseShareDeepLink(parsed);
    default:
      return { type: "unsupported", message: "Unsupported Gloomberb link." };
  }
}

function notifyError(pluginRegistry: PluginRegistry, body: string): void {
  pluginRegistry.notify({ body, type: "error" });
}

function notifySuccess(pluginRegistry: PluginRegistry, body: string): void {
  pluginRegistry.notify({ body, type: "success" });
}

function requirePane(pluginRegistry: PluginRegistry, paneId: string, unavailableMessage: string): boolean {
  if (pluginRegistry.panes.has(paneId)) return true;
  notifyError(pluginRegistry, unavailableMessage);
  return false;
}

function resolveCollectionRecord(
  state: AppState,
  action: Extract<DesktopDeepLinkAction, { type: "open-collection" }>,
): { name?: string } | null {
  const portfolio = state.config.portfolios.find((entry) => entry.id === action.collectionId);
  const watchlist = state.config.watchlists.find((entry) => entry.id === action.collectionId);
  if (action.kind === "portfolio") return portfolio ?? null;
  if (action.kind === "watchlist") return watchlist ?? null;
  return portfolio ?? watchlist ?? null;
}

function visiblePaneIds(state: AppState): Set<string> {
  return new Set([
    ...getDockedPaneIds(state.config.layout),
    ...state.config.layout.floating.map((entry) => entry.instanceId),
    ...state.config.layout.detached.map((entry) => entry.instanceId),
  ]);
}

function isVisiblePane(state: AppState, paneId: string | null | undefined): paneId is string {
  return !!paneId && visiblePaneIds(state).has(paneId);
}

function resolveVisibleCollectionPaneId(state: AppState): string | null {
  const followedPaneId = resolveFollowBindingInstance(
    state.config.layout,
    state.focusedPaneId,
    (instance) => instance.paneId === "portfolio-list",
  )?.instanceId;
  if (isVisiblePane(state, followedPaneId)) return followedPaneId;

  const focusedPane = state.focusedPaneId ? findPaneInstance(state.config.layout, state.focusedPaneId) : null;
  if (focusedPane?.paneId === "portfolio-list" && isVisiblePane(state, focusedPane.instanceId)) {
    return focusedPane.instanceId;
  }

  const visibleIds = visiblePaneIds(state);
  return state.config.layout.instances.find((instance) => (
    instance.paneId === "portfolio-list" && visibleIds.has(instance.instanceId)
  ))?.instanceId ?? null;
}

function applyCollectionSelection(
  collectionId: string,
  { dispatch, stateRef }: Pick<DesktopDeepLinkHandlerOptions, "dispatch" | "stateRef">,
): boolean {
  const targetPaneId = resolveVisibleCollectionPaneId(stateRef.current);
  if (!targetPaneId) return false;
  dispatch({ type: "UPDATE_PANE_STATE", paneId: targetPaneId, patch: { collectionId } });
  dispatch({ type: "FOCUS_PANE", paneId: targetPaneId });
  return true;
}

function retryCollectionSelection(
  collectionId: string,
  options: Pick<DesktopDeepLinkHandlerOptions, "dispatch" | "stateRef">,
): void {
  globalThis.setTimeout(() => {
    applyCollectionSelection(collectionId, options);
  }, 50);
}

function handleOpenTicker(
  action: Extract<DesktopDeepLinkAction, { type: "open-ticker" }>,
  pluginRegistry: PluginRegistry,
): void {
  if (!requirePane(pluginRegistry, TICKER_RESEARCH_PANE_ID, "Ticker research is unavailable.")) return;
  if (action.tabId && !pluginRegistry.getTickerResearchTabPluginId(action.tabId)) {
    notifyError(pluginRegistry, `Ticker tab "${action.tabId}" is unavailable.`);
    return;
  }

  pluginRegistry.pinTicker(action.symbol, {
    floating: true,
    paneType: TICKER_RESEARCH_PANE_ID,
  });

  if (action.tabId) {
    globalThis.setTimeout(() => {
      pluginRegistry.switchTab(action.tabId!);
    }, 80);
  }
  notifySuccess(pluginRegistry, action.message);
}

function handleOpenCollection(
  action: Extract<DesktopDeepLinkAction, { type: "open-collection" }>,
  options: DesktopDeepLinkHandlerOptions,
): void {
  const collection = resolveCollectionRecord(options.stateRef.current, action);
  if (!collection) {
    notifyError(options.pluginRegistry, `Collection "${action.collectionId}" is unavailable.`);
    return;
  }
  if (!requirePane(options.pluginRegistry, "portfolio-list", "Collections are unavailable.")) return;

  options.pluginRegistry.showPane("portfolio-list");
  if (!applyCollectionSelection(action.collectionId, options)) {
    retryCollectionSelection(action.collectionId, options);
  }
  notifySuccess(options.pluginRegistry, collection.name ? `Opened ${collection.name}.` : action.message);
}

function handleCreateAlert(
  action: Extract<DesktopDeepLinkAction, { type: "create-alert" }>,
  pluginRegistry: PluginRegistry,
): void {
  const command = pluginRegistry.commands.get("set-alert");
  if (!command) {
    notifyError(pluginRegistry, "Alerts are unavailable.");
    return;
  }
  void Promise.resolve(command.execute(action.values)).catch((error) => {
    notifyError(pluginRegistry, error instanceof Error ? error.message : "Failed to create alert.");
  });
}

function handleOpenChatChannel(
  action: Extract<DesktopDeepLinkAction, { type: "open-chat-channel" }>,
  pluginRegistry: PluginRegistry,
): void {
  if (!pluginRegistry.paneTemplates.has("new-chat-pane")) {
    notifyError(pluginRegistry, "Chat is unavailable.");
    return;
  }
  const options = action.channelId
    ? {
        arg: action.channelId,
        ...(action.messageId ? { values: { messageId: action.messageId } } : {}),
      }
    : undefined;
  void pluginRegistry.createPaneFromTemplateAsyncFn("new-chat-pane", options).then(() => {
    notifySuccess(pluginRegistry, action.message);
  }).catch((error) => {
    notifyError(pluginRegistry, error instanceof Error ? error.message : "Failed to open chat.");
  });
}

function handleOpenChatDm(
  action: Extract<DesktopDeepLinkAction, { type: "open-chat-dm" }>,
  pluginRegistry: PluginRegistry,
): void {
  const command = pluginRegistry.commands.get("direct-message");
  if (!command) {
    notifyError(pluginRegistry, "Direct messages are unavailable.");
    return;
  }
  void Promise.resolve(command.execute({ participants: action.participants })).then(() => {
    notifySuccess(pluginRegistry, action.message);
  }).catch((error) => {
    notifyError(pluginRegistry, error instanceof Error ? error.message : "Failed to open DM.");
  });
}

function handleOpenNews(
  action: Extract<DesktopDeepLinkAction, { type: "open-news" }>,
  pluginRegistry: PluginRegistry,
): void {
  if (action.kind === "ticker") {
    if (!action.symbol || !pluginRegistry.paneTemplates.has("ticker-news-pane")) {
      notifyError(pluginRegistry, "Ticker news is unavailable.");
      return;
    }
    void pluginRegistry.createPaneFromTemplateAsyncFn("ticker-news-pane", { symbol: action.symbol }).then(() => {
      notifySuccess(pluginRegistry, action.message);
    }).catch((error) => {
      notifyError(pluginRegistry, error instanceof Error ? error.message : "Failed to open ticker news.");
    });
    return;
  }

  const paneId = action.kind === "breaking"
    ? "news-breaking"
    : action.kind === "feed"
      ? "news-feed"
      : "news-top";
  if (!requirePane(pluginRegistry, paneId, "News is unavailable.")) return;
  pluginRegistry.showPane(paneId);
  notifySuccess(pluginRegistry, action.message);
}

async function handleOpenShare(
  action: Extract<DesktopDeepLinkAction, { type: "open-share" }>,
  pluginRegistry: PluginRegistry,
): Promise<void> {
  const share = await getShare(action.id, fetch, { trackView: false });
  if (!share) throw new Error("This share is unavailable or has expired.");
  if (share.kind !== "pane") throw new Error("This link contains a snapshot, not a live pane.");
  await openPaneShare(pluginRegistry, share.data);
  notifySuccess(pluginRegistry, action.message);
}

export function handleDesktopDeepLink(rawUrl: string, options: DesktopDeepLinkHandlerOptions): void {
  const action = resolveDesktopDeepLinkAction(rawUrl);
  if (action.type === "unsupported") {
    notifyError(options.pluginRegistry, action.message);
    return;
  }

  switch (action.type) {
    case "open-account-management":
      if (!requirePane(options.pluginRegistry, "account-management", "Account management is unavailable.")) return;
      if (action.route.kind === "cloud-emails") requestAccountManagementTab("emails");
      if (action.route.kind === "cloud-success") {
        requestAccountManagementTab("pro");
        // Checkout just completed: re-read the session so the new plan shows at once.
        void chatController.refreshSession().catch(() => {});
      }
      options.pluginRegistry.showPane("account-management");
      notifySuccess(options.pluginRegistry, action.message);
      return;
    case "open-ticker":
      handleOpenTicker(action, options.pluginRegistry);
      return;
    case "open-collection":
      handleOpenCollection(action, options);
      return;
    case "create-alert":
      handleCreateAlert(action, options.pluginRegistry);
      return;
    case "open-chat-channel":
      handleOpenChatChannel(action, options.pluginRegistry);
      return;
    case "open-chat-dm":
      handleOpenChatDm(action, options.pluginRegistry);
      return;
    case "open-news":
      handleOpenNews(action, options.pluginRegistry);
      return;
    case "open-share":
      void handleOpenShare(action, options.pluginRegistry).catch((error) => {
        notifyError(options.pluginRegistry, error instanceof Error ? error.message : "Could not open shared pane.");
      });
      return;
  }
}

export function useDesktopDeepLinkRuntime({
  desktopDeepLinkBridge,
  desktopWindowKind,
  dispatch,
  initialized,
  pluginRegistry,
  stateRef,
}: {
  desktopDeepLinkBridge?: DesktopDeepLinkBridge;
  desktopWindowKind?: DesktopWindowBridge["kind"];
  dispatch: Dispatch<AppAction>;
  initialized: boolean;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
}) {
  useEffect(() => {
    if (!initialized || desktopWindowKind === "detached" || !desktopDeepLinkBridge) return;
    return desktopDeepLinkBridge.subscribe((deeplink) => {
      handleDesktopDeepLink(deeplink.url, { dispatch, pluginRegistry, stateRef });
    });
  }, [desktopDeepLinkBridge, desktopWindowKind, dispatch, initialized, pluginRegistry, stateRef]);
}
