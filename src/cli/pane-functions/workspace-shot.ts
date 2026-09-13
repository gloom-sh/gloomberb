import { mkdir } from "fs/promises";
import { dirname } from "path";
import { apiClient } from "../../api-client";
import type { PaneRuntimeState } from "../../core/state/app/state";
import type { AppConfig, DockLayoutNode, PaneInstanceConfig } from "../../types/config";
import {
  renderDesktopPaneScreenshot,
  type DesktopPaneShotPayload,
} from "../desktop-pane-shot";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import type { ParsedPaneFunctionArgs } from "./options";
import { resolvePaneFunction, type ResolvedPaneFunction } from "./resolver";
import {
  buildDesktopShotPayload,
  createDesktopShotBridge,
  resolveDesktopShotApiProxy,
  stripDesktopShotCredentials,
} from "./screenshot";

/**
 * `gloomberb shot workspace` captures the app rather than one pane: the
 * header, a dock of panes, and the status bar, under whatever theme is asked
 * for. A theme is a decision about how panes sit next to each other, and a
 * single floating pane cannot show that.
 */
export const WORKSPACE_SHOT_TOKEN = "workspace";

interface WorkspacePaneSpec {
  /** Pane function token, as accepted by `gloomberb shot <token>`. */
  token: string;
  arg: string;
  options?: Record<string, string | true>;
}

interface WorkspaceLayoutSpec {
  panes: WorkspacePaneSpec[];
  /** Dock tree over pane indexes into `panes`. */
  dock: WorkspaceDockSpec;
  focus: number;
}

type WorkspaceDockSpec =
  | number
  | { axis: "horizontal" | "vertical"; ratio: number; first: WorkspaceDockSpec; second: WorkspaceDockSpec };

/**
 * One screen that exercises everything a style touches: a dense table with
 * sparklines, a chart, a news list and a quote board, next to the header and
 * the status bar. The chart is focused so the focus treatment shows.
 */
const DEFAULT_WORKSPACE: WorkspaceLayoutSpec = {
  panes: [
    { token: "PF", arg: "" },
    { token: "WEI", arg: "" },
    { token: "GP", arg: "AAPL" },
    { token: "TOP", arg: "" },
  ],
  dock: {
    axis: "horizontal",
    ratio: 0.46,
    first: { axis: "vertical", ratio: 0.56, first: 0, second: 1 },
    second: { axis: "vertical", ratio: 0.6, first: 2, second: 3 },
  },
  focus: 2,
};

export interface WorkspaceShotResult {
  kind: "workspace-screenshot";
  outputPath: string;
  panes: string[];
  theme: string | null;
  loadingStateDetected: boolean;
  errorStateDetected: boolean;
}

function dockNodeFor(spec: WorkspaceDockSpec, instances: PaneInstanceConfig[]): DockLayoutNode {
  if (typeof spec === "number") {
    const instance = instances[spec];
    if (!instance) throw new Error(`Workspace dock refers to pane ${spec}, which does not exist.`);
    return { kind: "pane", instanceId: instance.instanceId };
  }
  return {
    kind: "split",
    axis: spec.axis,
    ratio: spec.ratio,
    first: dockNodeFor(spec.first, instances),
    second: dockNodeFor(spec.second, instances),
  };
}

/**
 * The same data path every pane shot takes, once per pane, then merged: the
 * page fetches what it can through the bridge, and the payload carries the
 * tickers and financials the panes need on first paint.
 */
async function buildWorkspacePayload({
  registry,
  context,
  parsed,
  spec,
}: {
  registry: PaneFunctionCatalog;
  context: MarketContext;
  parsed: ParsedPaneFunctionArgs;
  spec: WorkspaceLayoutSpec;
}): Promise<DesktopPaneShotPayload> {
  const resolvedPanes: ResolvedPaneFunction[] = [];
  for (const pane of spec.panes) {
    resolvedPanes.push(await resolvePaneFunction(registry, context, {
      ...parsed,
      target: pane.token,
      arg: pane.arg,
      options: pane.options ?? {},
    }));
  }

  const payloads: DesktopPaneShotPayload[] = [];
  for (const [index, resolved] of resolvedPanes.entries()) {
    payloads.push(await buildDesktopShotPayload(
      resolved,
      context,
      spec.panes[index]!.arg,
      spec.panes[index]!.options ?? {},
      parsed.width,
      parsed.height,
      parsed.theme,
      parsed.scale,
      parsed.watermark,
    ));
  }
  const base = payloads[0];
  if (!base) throw new Error("A workspace needs at least one pane.");

  const instances = payloads.map((payload) => payload.config.layout.instances[0]!);
  const paneState: Record<string, PaneRuntimeState> = {};
  for (const payload of payloads) Object.assign(paneState, payload.paneState);
  const focused = instances[spec.focus] ?? instances[0]!;
  const layout = {
    dockRoot: dockNodeFor(spec.dock, instances),
    instances,
    floating: [],
    detached: [],
  };
  const config = stripDesktopShotCredentials<AppConfig>({
    ...base.config,
    layout,
    layouts: [{
      name: "Workspace",
      layout,
      paneState,
      focusedPaneId: focused.instanceId,
      activePanel: "right" as const,
    }],
    activeLayoutIndex: 0,
  });

  const mergeBy = <T>(entries: T[][], key: (entry: T) => string): T[] => {
    const seen = new Map<string, T>();
    for (const list of entries) for (const entry of list) if (!seen.has(key(entry))) seen.set(key(entry), entry);
    return [...seen.values()];
  };

  return {
    config,
    paneId: focused.instanceId,
    workspace: { commandBarQuery: parsed.options.commandBar === true ? "" : typeof parsed.options.commandBar === "string" ? parsed.options.commandBar : null },
    widthCells: base.widthCells,
    heightCells: base.heightCells,
    widthPx: base.widthPx,
    heightPx: base.heightPx,
    deviceScaleFactor: base.deviceScaleFactor,
    watermark: base.watermark,
    tickers: mergeBy(payloads.map((payload) => payload.tickers), (ticker) => ticker.metadata.ticker),
    financials: mergeBy(payloads.map((payload) => payload.financials), ([symbol]) => symbol),
    intradayHistories: mergeBy(payloads.map((payload) => payload.intradayHistories), (history) => `${history.symbol}:${history.rangePreset}`),
    optionsChains: mergeBy(payloads.map((payload) => payload.optionsChains), ([symbol]) => symbol),
    valuationSeries: mergeBy(payloads.map((payload) => payload.valuationSeries), ([key]) => key),
    statSeries: mergeBy(payloads.map((payload) => payload.statSeries), ([key]) => key),
    paneState,
    externalPlugins: base.externalPlugins,
    ...(payloads.find((payload) => payload.chartModel)?.chartModel
      ? { chartModel: payloads.find((payload) => payload.chartModel)!.chartModel }
      : {}),
  };
}

export async function renderWorkspaceShot({
  registry,
  context,
  parsed,
  outputPath,
}: {
  registry: PaneFunctionCatalog;
  context: MarketContext;
  parsed: ParsedPaneFunctionArgs;
  outputPath: string;
}): Promise<WorkspaceShotResult> {
  await mkdir(dirname(outputPath), { recursive: true });
  const apiProxy = resolveDesktopShotApiProxy(context);
  const previousSessionToken = apiClient.getSessionToken();
  apiClient.setSessionToken(apiProxy.sessionToken);
  try {
    const payload = await buildWorkspacePayload({ registry, context, parsed, spec: DEFAULT_WORKSPACE });
    const render = await renderDesktopPaneScreenshot(payload, outputPath, apiProxy, {
      bridge: createDesktopShotBridge(context),
    });
    return {
      kind: "workspace-screenshot",
      outputPath,
      panes: payload.config.layout.instances.map((instance) => instance.paneId),
      theme: parsed.theme,
      loadingStateDetected: render.loadingStateDetected,
      errorStateDetected: render.errorStateDetected,
    };
  } finally {
    apiClient.setSessionToken(previousSessionToken);
  }
}
