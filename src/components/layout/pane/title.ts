import { resolveCollectionForPane, resolveTickerForPane, type AppState } from "../../../state/app/context";
import { t, tf } from "../../../i18n";
import {
  findPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type PaneInstanceConfig,
} from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";
import { paneTitleMnemonic, TITLE_TICKER } from "../../../layout/pane-follow";
import { canFollowTickerSource, isTickerLinkPeer } from "../../../layout/ticker-navigation";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";

/**
 * A ticker key as a title names it: the venue's own code (`9992:HKEX`,
 * `SHOP:NASDAQ`), as the CLI and a chart's legend do, never the key a
 * listing is saved or bound under (`9992:XHKG`). A bare key stays bare.
 */
function displayTicker(key: string): string {
  return parsePublicTickerKey(key).exchange ? canonicalTickerKey(key) : key;
}

/**
 * A title a template wrote, its command and the ticker keys it opened on
 * ("FA 9992:XHKG", "RV 9992:XHKG,PLTR"), with each key by its venue's code
 * ("FA 9992:HKEX"). Any other title is the user's or the pane's own and stays.
 */
function displayStoredTitle(title: string): string {
  const mnemonic = paneTitleMnemonic(title);
  if (!mnemonic) return title;
  // Keys and the separators between them as written ("AAPL, MSFT" keeps its space).
  const parts = title.slice(mnemonic.length).split(/(\s*,\s*)/);
  const keys = parts.filter((_, index) => index % 2 === 0).map((key) => key.trim());
  if (!keys[0] || !keys.every((key) => TITLE_TICKER.test(key))) return title;
  return `${title.slice(0, mnemonic.length)}${parts.map((part, index) => index % 2 === 0 ? part.replace(part.trim(), displayTicker(part.trim())) : part).join("")}`;
}

/** Single-cell link glyph: emoji link icons render double-width in terminals. */
const LINK_GLYPH = "\u29c9";

/** The title without the link suffix. */
export function getBasePaneDisplayTitle(
  state: Pick<AppState, "config" | "paneState">,
  instance: PaneInstanceConfig,
  paneDef: PaneDef,
  panes?: ReadonlyMap<string, PaneDef>,
): string {
  if (instance.paneId === "chat") {
    const channelId = typeof instance.settings?.channelId === "string" && instance.settings.channelId.trim()
      ? instance.settings.channelId.trim()
      : "everyone";
    const title = typeof instance.title === "string" ? instance.title.trim() : "";
    const displayTitle = title && !title.startsWith("dm:") && !title.startsWith("group:") ? title : undefined;
    if (channelId.startsWith("dm:")) return displayTitle ?? "DM";
    if (channelId.startsWith("group:")) return displayTitle ?? "Group";
    return displayTitle ?? `#${channelId}`;
  }

  if (instance.paneId === TICKER_RESEARCH_PANE_ID) {
    const ticker = resolveTickerForPane(state as AppState, instance.instanceId);
    if (ticker) return displayTicker(ticker);
    const collectionId = resolveCollectionForPane(state as AppState, instance.instanceId);
    return state.config.portfolios.find((portfolio) => portfolio.id === collectionId)?.name
      ?? state.config.watchlists.find((watchlist) => watchlist.id === collectionId)?.name
      ?? instance.title
      ?? t(paneDef.name);
  }

  // A linked pane stores only its command ("OPX") and shows the ticker its source has selected.
  const mnemonic = instance.binding?.kind === "follow" && panes && canFollowTickerSource(instance, panes)
    ? paneTitleMnemonic(instance.title)
    : null;
  if (mnemonic) {
    const ticker = resolveTickerForPane(state as AppState, instance.instanceId);
    return ticker ? `${mnemonic} ${displayTicker(ticker)}` : mnemonic;
  }

  if (instance.title) return displayStoredTitle(instance.title);

  if (instance.paneId === "portfolio-list") {
    const collectionId = resolveCollectionForPane(state as AppState, instance.instanceId);
    return state.config.portfolios.find((portfolio) => portfolio.id === collectionId)?.name
      ?? state.config.watchlists.find((watchlist) => watchlist.id === collectionId)?.name
      ?? t(paneDef.name);
  }

  // A source pane owns the cursor symbol; echoing it in its own title would just repeat the row.
  if (paneDef.tickerSource) return t(paneDef.name);

  const ticker = resolveTickerForPane(state as AppState, instance.instanceId);
  return ticker ? `${t(paneDef.name)}: ${displayTicker(ticker)}` : t(paneDef.name);
}

export function getPaneDisplayTitle(
  state: Pick<AppState, "config" | "paneState">,
  instance: PaneInstanceConfig,
  paneDef: PaneDef,
  panes?: ReadonlyMap<string, PaneDef>,
): string {
  const title = getBasePaneDisplayTitle(state, instance, paneDef, panes);
  if (instance.binding?.kind !== "follow" || !panes) return title;
  const research = instance.paneId === TICKER_RESEARCH_PANE_ID;
  if (!research && !canFollowTickerSource(instance, panes)) return title;

  const source = findPaneInstance(state.config.layout, instance.binding.sourceInstanceId);
  const sourceDef = source ? panes.get(source.paneId) : null;
  if (!source || !sourceDef) return title;
  // Name the list, scanner, or single-ticker pane this one follows. A follow pointed at anything
  // else (a desk's OMON following a comparison chart) reads as it always has.
  if (!sourceDef.tickerSource && !isTickerLinkPeer(source, panes)) return title;
  const sourceTitle = getTickerLinkSourceTitle(state, source, sourceDef, panes, "title");
  return `${title}  ${LINK_GLYPH} ${tf("Linked to {source}", { source: sourceTitle })}`;
}

/**
 * How a follower names the pane it follows. A list or scanner goes by its title. A single-ticker
 * pane shows the follower's own symbol, so a title names only its command ("OMON SPY  ⧉ Linked to
 * OVDV"), and a menu row keeps the symbol to tell two of them apart ("Link to OVDV SPY"). Ticker
 * Research's title is only its symbol, which would read as a ticker, so it goes by its name
 * ("Link to Ticker Research AAPL").
 */
export function getTickerLinkSourceTitle(
  state: Pick<AppState, "config" | "paneState">,
  source: PaneInstanceConfig,
  sourceDef: PaneDef,
  panes: ReadonlyMap<string, PaneDef>,
  place: "menu" | "title",
): string {
  const title = getBasePaneDisplayTitle(state, source, sourceDef, panes);
  if (sourceDef.tickerSource) return title;
  const research = source.paneId === TICKER_RESEARCH_PANE_ID;
  const kind = research ? t("Ticker Research") : paneTitleMnemonic(title);
  if (!kind) return title;
  if (place === "title") return kind;
  const symbol = research ? resolveTickerForPane(state as AppState, source.instanceId) : null;
  return symbol ? `${kind} ${symbol}` : title;
}
