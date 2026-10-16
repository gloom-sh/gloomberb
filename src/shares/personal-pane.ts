import type { LayoutBounds, ResolvedPane } from "../layout/pane-manager";
import { getPaneSettings } from "../pane-settings";
import type { PluginRegistry } from "../plugins/registry";
import { resolveCollectionForPane, resolveTickerForPane, type AppState } from "../state/app/context";
import type { LayoutConfig } from "../types/config";
import type { PanePersonalData, PanePersonalDataContext } from "../types/plugin";
import { resolvePanePersonalData } from "./pane-image";

export interface PanePersonalDataSource {
  registry: Pick<PluginRegistry, "brokers" | "getPanePluginId" | "getBrokerPluginId">;
  state: AppState;
  /** The layout the pane is in, for its `personalData` rule. */
  layout: LayoutConfig;
  pane: Pick<ResolvedPane, "instance" | "def">;
}

/** What a pane shows now, for its `personalData` rule. */
function personalDataContext({ state, layout, pane }: Omit<PanePersonalDataSource, "registry">): PanePersonalDataContext {
  const paneId = pane.instance.instanceId;
  return {
    config: state.config,
    layout,
    paneId,
    paneType: pane.instance.paneId,
    pane: pane.instance,
    settings: getPaneSettings(pane.instance),
    paneState: state.paneState[paneId] ?? {},
    activeTicker: resolveTickerForPane(state, paneId),
    activeCollectionId: resolveCollectionForPane(state, paneId),
    tickers: state.tickers,
  };
}

/** Whether the plugin that owns a pane also connects a broker. */
function ownerConnectsBroker(registry: PanePersonalDataSource["registry"], paneType: string): boolean {
  const owner = registry.getPanePluginId(paneType);
  return !!owner && [...registry.brokers.keys()].some((brokerType) => registry.getBrokerPluginId(brokerType) === owner);
}

/**
 * The personal data a pane shows now, from its `PaneDef.personalData` (and,
 * for a pane that declares nothing, the fallback in `resolvePanePersonalData`);
 * null for market data. The one answer to "does this pane show the person's
 * own data, so ask before it leaves the device": a public link to it, its
 * picture in a bug report and attaching it to an Ask Gloom question all read
 * it here, from the same context.
 */
export function panePersonalData({ registry, ...source }: PanePersonalDataSource): PanePersonalData | null {
  return resolvePanePersonalData(source.pane.def, personalDataContext(source), {
    ownerConnectsBroker: ownerConnectsBroker(registry, source.pane.def.id),
  });
}

export interface CapturedPersonalDataSource extends Omit<PanePersonalDataSource, "pane"> {
  /** The pane pictured. */
  paneId: string;
  panes: ReadonlyMap<string, Pick<ResolvedPane, "instance" | "def">>;
  /**
   * Where each pane of the window is drawn, docked and floating, when the
   * picture is read off the screen; null when it paints the pane alone.
   */
  drawn: ReadonlyMap<string, LayoutBounds> | null;
}

function overlaps(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The personal data a picture of a pane can show. The desktop and the web
 * paint the pane's own DOM, so that is the pane's answer. The terminal reads
 * the picture off the screen, where a floating pane can cover part of it, so
 * there it is also the answer of every pane drawn on any part of its area.
 */
export function capturedPersonalData({ paneId, panes, drawn, ...source }: CapturedPersonalDataSource): PanePersonalData | null {
  const pane = panes.get(paneId);
  const own = pane ? panePersonalData({ ...source, pane }) : null;
  const area = drawn?.get(paneId);
  if (own || !drawn || !area) return own;
  for (const [otherId, rect] of drawn) {
    const other = otherId === paneId || !overlaps(area, rect) ? undefined : panes.get(otherId);
    const kind = other ? panePersonalData({ ...source, pane: other }) : null;
    if (kind) return kind;
  }
  return null;
}
