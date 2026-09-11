import type { Dispatch } from "react";
import {
  dockPane,
  floatPane,
  getDockLeafLayouts,
  gridlockAllPanes,
  insertAtRootEdge,
  removeFloatingPanes,
} from "../plugins/pane-manager";
import type { PluginRegistry } from "../plugins/registry";
import type { AppAction, AppState } from "../state/app/context";
import { PANE_LOCK_SETTING_KEY, setPaneSettings } from "../pane-settings";
import type { DesktopWindowBridge } from "../types/desktop-window";
import { applyJsonPatch } from "./json-patch";
import { revisionFor } from "./revision";
import type {
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteJsonPatchOperation,
  RemoteMarketDataRequest,
  RemoteStateInclude,
} from "./types";
import type { RemoteUiRegistry } from "./semantic-tree";
import { commandBarResultsFromNodes, isCommandBarInputNode } from "./command-bar";
import { REMOTE_AGENT_HELP, remoteControlSchema } from "./schema";
import {
  asRecord,
  fail,
  mutationSummary,
  numberInput,
  ok,
  optionalNumber,
  optionalString,
  stringInput,
} from "./controller-utils";
import {
  buildGridDockRoot,
  regionToDockPosition,
  regionToRootEdge,
  requirePaneInstance,
  visiblePaneIds,
} from "./layout-helpers";
import { createRemoteResources } from "./resources";

interface AppRemoteControllerOptions {
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  pluginRegistry: PluginRegistry;
  uiRegistry: RemoteUiRegistry | null;
  desktopWindowBridge?: DesktopWindowBridge;
  afterMutation?: () => Promise<void> | void;
}

const DEFAULT_MUTATION_INCLUDE: RemoteStateInclude[] = ["app", "layout", "panes", "commandBar"];
const MAX_MARKET_DATA_SEARCH_RESULTS = 20;
const MAX_MARKET_DATA_FILINGS = 20;
const MAX_MARKET_DATA_EARNINGS_SYMBOLS = 25;
const MAX_MARKET_DATA_HOLDERS = 25;
const MAX_MARKET_DATA_EVENT_ROWS = 20;

function requiredMarketDataText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Market data ${field} is required.`);
  return normalized;
}

function normalizedMarketDataSymbol(symbol: string): string {
  return requiredMarketDataText(symbol, "symbol").toUpperCase();
}

function normalizedOptionalExchange(exchange: string | undefined): string | undefined {
  const normalized = exchange?.trim().toUpperCase();
  return normalized || undefined;
}

export function createAppRemoteController({
  dispatch,
  getState,
  pluginRegistry,
  uiRegistry,
  desktopWindowBridge,
  afterMutation = () => {},
}: AppRemoteControllerOptions) {
  const { buildIncludedState, getResource, patchTarget } = createRemoteResources({
    dispatch,
    getState,
    pluginRegistry,
    uiRegistry,
  });

  const getAfterMutationSummary = async (extra?: Record<string, unknown>): Promise<unknown> => {
    await afterMutation();
    return mutationSummary(getState(), extra);
  };

  const queryMarketData = async (request: RemoteMarketDataRequest): Promise<unknown> => {
    const marketData = pluginRegistry.marketData;
    switch (request.operation) {
      case "search":
        return (await marketData.search(requiredMarketDataText(request.query, "query")))
          .slice(0, MAX_MARKET_DATA_SEARCH_RESULTS)
          .map((result) => ({
            providerId: result.providerId,
            symbol: result.symbol,
            name: result.name,
            exchange: result.exchange,
            primaryExchange: result.primaryExchange,
            type: result.type,
            currency: result.currency,
          }));
      case "quote":
        return marketData.getQuote(
          normalizedMarketDataSymbol(request.symbol),
          normalizedOptionalExchange(request.exchange),
        );
      case "financials": {
        const financials = await marketData.getTickerFinancials(
          normalizedMarketDataSymbol(request.symbol),
          normalizedOptionalExchange(request.exchange),
        );
        return {
          quote: financials.quote,
          fundamentals: financials.fundamentals,
          profile: financials.profile,
          annualStatements: financials.annualStatements.slice(0, 5),
          quarterlyStatements: financials.quarterlyStatements.slice(0, 8),
        };
      }
      case "secFilings": {
        if (!marketData.getSecFilings) throw new Error("The configured market data sources do not provide SEC filings.");
        const count = Math.max(1, Math.min(
          MAX_MARKET_DATA_FILINGS,
          Number.isFinite(request.count) ? Math.trunc(request.count!) : 10,
        ));
        return (await marketData.getSecFilings(
          normalizedMarketDataSymbol(request.symbol),
          count,
          normalizedOptionalExchange(request.exchange),
        )).slice(0, count);
      }
      case "holders": {
        if (!marketData.getHolders) throw new Error("The configured market data sources do not provide holder data.");
        const holders = await marketData.getHolders(
          normalizedMarketDataSymbol(request.symbol),
          normalizedOptionalExchange(request.exchange),
        );
        return {
          ...holders,
          holders: holders.holders.slice(0, MAX_MARKET_DATA_HOLDERS),
        };
      }
      case "analystResearch": {
        if (!marketData.getAnalystResearch) throw new Error("The configured market data sources do not provide analyst research.");
        const research = await marketData.getAnalystResearch(
          normalizedMarketDataSymbol(request.symbol),
          normalizedOptionalExchange(request.exchange),
        );
        return {
          ...research,
          recommendations: research.recommendations.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
          ratings: research.ratings.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
          earningsEstimates: research.earningsEstimates.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
          revenueEstimates: research.revenueEstimates.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
        };
      }
      case "corporateActions": {
        if (!marketData.getCorporateActions) throw new Error("The configured market data sources do not provide corporate actions.");
        const actions = await marketData.getCorporateActions(
          normalizedMarketDataSymbol(request.symbol),
          normalizedOptionalExchange(request.exchange),
        );
        return {
          ...actions,
          dividends: actions.dividends.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
          splits: actions.splits.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
          earnings: actions.earnings.slice(0, MAX_MARKET_DATA_EVENT_ROWS),
        };
      }
      case "earningsCalendar": {
        if (!marketData.getEarningsCalendar) throw new Error("The configured market data sources do not provide an earnings calendar.");
        const symbols = request.symbols
          .map((symbol) => normalizedMarketDataSymbol(symbol))
          .filter((symbol, index, all) => all.indexOf(symbol) === index)
          .slice(0, MAX_MARKET_DATA_EARNINGS_SYMBOLS);
        if (symbols.length === 0) throw new Error("Market data symbols are required.");
        return marketData.getEarningsCalendar(symbols);
      }
      default:
        throw new Error(
          `Unknown market data operation "${String((request as { operation?: unknown }).operation)}".`,
        );
    }
  };

  const openCommandBar = async (input: Record<string, unknown>): Promise<unknown> => {
    const mode = optionalString(input, "mode") ?? "command";
    const query = optionalString(input, "query") ?? "";
    if (getState().commandBarOpen) {
      dispatch({ type: "SET_COMMAND_BAR", open: false });
      await afterMutation();
    }
    if (mode === "ticker") {
      dispatch({ type: "SET_COMMAND_BAR", open: true, launch: { kind: "ticker-search", query } });
      await afterMutation();
      return mutationSummary(getState(), { commandBar: getResource("app://command-bar") });
    }
    if (mode !== "command" && mode !== "default") {
      throw new Error(`Unsupported command-bar mode "${mode}".`);
    }
    dispatch({ type: "SET_COMMAND_BAR", open: true, query });
    await afterMutation();
    return mutationSummary(getState(), { commandBar: getResource("app://command-bar") });
  };

  const setVisibleCommandBarQuery = async (query: string): Promise<void> => {
    dispatch({ type: "SET_COMMAND_BAR_QUERY", query });
    await afterMutation();
    const inputNode = (uiRegistry?.snapshot() ?? [])
      .find((node) => isCommandBarInputNode(node) && node.metadata?.focused === true && node.actions.includes("setValue"));
    if (!inputNode) return;
    if (inputNode.metadata?.value === query) return;
    await uiRegistry?.invoke(inputNode.id, "setValue", { value: query });
    await afterMutation();
  };

  const activateCommandBarResult = async (input: Record<string, unknown>): Promise<unknown> => {
    const nodeId = optionalString(input, "nodeId");
    const index = optionalNumber(input, "index");
    const itemId = optionalString(input, "itemId");
    const label = optionalString(input, "label");
    const results = commandBarResultsFromNodes(uiRegistry?.snapshot() ?? []);
    const result = nodeId
      ? results.find((entry) => entry.nodeId === nodeId)
      : itemId
        ? results.find((entry) => entry.itemId === itemId)
        : label
          ? results.find((entry) => entry.label === label)
      : typeof index === "number"
        ? results.find((entry) => entry.index === index)
        : results.find((entry) => entry.selected) ?? results[0];
    if (!result) throw new Error("No matching command-bar result is visible.");
    if (!result.actions.includes("activate")) {
      throw new Error(`Command-bar result "${result.nodeId}" does not expose activate.`);
    }
    await uiRegistry?.invoke(result.nodeId, "activate", result.actionInput);
    return getAfterMutationSummary({ activatedResult: result });
  };

  const invokeMatchingUiNode = async (input: Record<string, unknown>): Promise<unknown> => {
    const role = optionalString(input, "role");
    const label = optionalString(input, "label");
    const contains = optionalString(input, "contains");
    const index = optionalNumber(input, "index");
    const action = optionalString(input, "action") ?? "press";
    const metadataFilter = asRecord(input.metadata);
    const candidates = (uiRegistry?.snapshot() ?? []).filter((node) => {
      if (role && node.role !== role) return false;
      if (label && node.label !== label && node.metadata?.item && typeof node.metadata.item === "object") {
        const item = node.metadata.item as Record<string, unknown>;
        if (item.label !== label && item.id !== label) return false;
      } else if (label && node.label !== label) {
        return false;
      }
      if (contains) {
        const haystack = [
          node.label,
          node.role,
          JSON.stringify(node.metadata ?? {}),
        ].filter((entry): entry is string => typeof entry === "string").join(" ").toLowerCase();
        if (!haystack.includes(contains.toLowerCase())) return false;
      }
      for (const [key, value] of Object.entries(metadataFilter)) {
        if (node.metadata?.[key] !== value) return false;
      }
      if (!node.actions.includes(action)) return false;
      if (node.disabled) return false;
      return true;
    });
    const node = typeof index === "number" ? candidates[index] : candidates[0];
    if (!node) throw new Error("No matching semantic UI node is visible.");
    const result = await uiRegistry?.invoke(node.id, action, input.input);
    return getAfterMutationSummary({ invokedNode: node, result });
  };

  const call = async (operation: string, rawInput: unknown, dryRun?: boolean): Promise<unknown> => {
    const input = asRecord(rawInput);
    const dryRunResult = () => ({ operation, input, dryRun: true });
    if (dryRun) return dryRunResult();

    switch (operation) {
      case "app.openCommandBar":
        return openCommandBar(input);
      case "app.closeCommandBar":
        dispatch({ type: "SET_COMMAND_BAR", open: false });
        return getAfterMutationSummary();
      case "app.setCommandBarQuery":
        await setVisibleCommandBarQuery(stringInput(input, "query"));
        return mutationSummary(getState(), { commandBar: getResource("app://command-bar") });
      case "app.search":
        return openCommandBar(input);
      case "app.switchPanel":
        dispatch({ type: "SET_ACTIVE_PANEL", panel: input.panel === "right" ? "right" : "left" });
        return getAfterMutationSummary();
      case "app.notify":
        pluginRegistry.notify({ body: stringInput(input, "body"), type: input.type as never });
        return null;
      case "commandBar.activateResult":
        return activateCommandBarResult(input);
      case "pane.show":
        pluginRegistry.showPane(stringInput(input, "paneId"));
        return getAfterMutationSummary();
      case "pane.focus":
        pluginRegistry.focusPane(stringInput(input, "paneId"));
        return getAfterMutationSummary();
      case "pane.close": {
        const paneId = stringInput(input, "paneId");
        pluginRegistry.hidePane(paneId);
        return getAfterMutationSummary({ affectedPaneIds: [paneId] });
      }
      case "pane.createFromTemplate":
        await pluginRegistry.createPaneFromTemplateAsyncFn(
          stringInput(input, "templateId"),
          asRecord(input.options),
        );
        return getAfterMutationSummary();
      case "pane.setState":
        dispatch({
          type: "UPDATE_PANE_STATE",
          paneId: stringInput(input, "paneId"),
          patch: asRecord(input.patch),
        });
        return getAfterMutationSummary({ affectedPaneIds: [stringInput(input, "paneId")] });
      case "pane.setSetting": {
        const paneId = stringInput(input, "paneId");
        const key = stringInput(input, "key");
        const descriptor = pluginRegistry.resolvePaneSettings(paneId);
        const field = descriptor?.settingsDef.fields.find((entry) => entry.key === key);
        if (field) {
          await pluginRegistry.applyPaneSettingValueFn(descriptor!.paneId, field, input.value);
        } else {
          const instanceId = descriptor?.paneId ?? paneId;
          const current = pluginRegistry.resolvePaneSettings(instanceId)?.context.settings ?? {};
          // The lock is resolved into the settings view but lives on the instance.
          const { [PANE_LOCK_SETTING_KEY]: _locked, ...currentSettings } = current;
          pluginRegistry.updateLayoutFn(setPaneSettings(getState().config.layout, instanceId, {
            ...currentSettings,
            [key]: input.value,
          }));
        }
        return getAfterMutationSummary({ affectedPaneIds: [paneId] });
      }
      case "ticker.navigate":
        pluginRegistry.navigateTicker(stringInput(input, "symbol"), { sourcePaneId: optionalString(input, "sourcePaneId") });
        return getAfterMutationSummary({ symbol: stringInput(input, "symbol") });
      case "ticker.pin":
        pluginRegistry.pinTicker(stringInput(input, "symbol"), {
          floating: input.floating === true,
          forceNewPane: input.forceNewPane === true,
          paneType: optionalString(input, "paneType"),
        });
        return getAfterMutationSummary({ symbol: stringInput(input, "symbol") });
      case "ticker.select":
        pluginRegistry.selectTicker(stringInput(input, "symbol"), optionalString(input, "paneId"));
        return getAfterMutationSummary({ symbol: stringInput(input, "symbol") });
      case "ticker.switchTab":
        pluginRegistry.switchTab(stringInput(input, "tabId"), optionalString(input, "paneId"));
        return getAfterMutationSummary({ tabId: stringInput(input, "tabId") });
      case "layout.switch":
        dispatch({ type: "SWITCH_LAYOUT", index: numberInput(input, "index") });
        return getAfterMutationSummary();
      case "layout.new":
        dispatch({ type: "NEW_LAYOUT", name: stringInput(input, "name") });
        return getAfterMutationSummary();
      case "layout.rename":
        dispatch({ type: "RENAME_LAYOUT", index: numberInput(input, "index"), name: stringInput(input, "name") });
        return getAfterMutationSummary();
      case "layout.duplicate":
        dispatch({ type: "DUPLICATE_LAYOUT", index: numberInput(input, "index") });
        return getAfterMutationSummary();
      case "layout.delete":
        dispatch({ type: "DELETE_LAYOUT", index: numberInput(input, "index") });
        return getAfterMutationSummary();
      case "layout.undo":
        dispatch({ type: "UNDO_LAYOUT" });
        return getAfterMutationSummary();
      case "layout.redo":
        dispatch({ type: "REDO_LAYOUT" });
        return getAfterMutationSummary();
      case "layout.gridlock": {
        const { width, height } = pluginRegistry.getTermSizeFn();
        pluginRegistry.updateLayoutFn(gridlockAllPanes(
          getState().config.layout,
          { x: 0, y: 0, width, height },
          pluginRegistry.panes,
        ));
        return getAfterMutationSummary();
      }
      case "layout.closeFloating": {
        const floatingPaneIds = getState().config.layout.floating.map((entry) => entry.instanceId);
        pluginRegistry.updateLayoutFn(removeFloatingPanes(getState().config.layout));
        return getAfterMutationSummary({ affectedPaneIds: floatingPaneIds });
      }
      case "layout.placePane": {
        const pane = requirePaneInstance(getState().config.layout, stringInput(input, "paneId"));
        const region = stringInput(input, "region");
        const { width, height } = pluginRegistry.getTermSizeFn();
        const def = pluginRegistry.panes.get(pane.paneId);
        const nextLayout = region === "floating"
          ? floatPane(getState().config.layout, pane.instanceId, width, height, def)
          : optionalString(input, "relativeTo")
            ? dockPane(getState().config.layout, pane.instanceId, {
              relativeTo: requirePaneInstance(getState().config.layout, optionalString(input, "relativeTo")!).instanceId,
              position: regionToDockPosition(region),
            })
            : insertAtRootEdge(getState().config.layout, pane.instanceId, regionToRootEdge(region));
        pluginRegistry.updateLayoutFn(nextLayout);
        return getAfterMutationSummary({ affectedPaneIds: [pane.instanceId] });
      }
      case "layout.focusRegion": {
        const region = stringInput(input, "region");
        const { width, height } = pluginRegistry.getTermSizeFn();
        const leaves = getDockLeafLayouts(getState().config.layout, { x: 0, y: 0, width, height });
        if (leaves.length === 0) throw new Error("No docked panes are visible.");
        const target = leaves
          .map((leaf) => {
            const centerX = leaf.rect.x + leaf.rect.width / 2;
            const centerY = leaf.rect.y + leaf.rect.height / 2;
            const score = region === "left" ? centerX
              : region === "right" ? -centerX
                : region === "top" ? centerY
                  : region === "bottom" ? -centerY
                    : Math.abs(centerX - width / 2) + Math.abs(centerY - height / 2);
            return { leaf, score };
          })
          .sort((a, b) => a.score - b.score)[0]!.leaf;
        dispatch({ type: "FOCUS_PANE", paneId: target.instanceId });
        return getAfterMutationSummary({ affectedPaneIds: [target.instanceId] });
      }
      case "layout.setGrid": {
        const rawPaneIds = Array.isArray(input.paneIds) ? input.paneIds : visiblePaneIds(getState().config.layout);
        const paneIds = rawPaneIds.map((id) => requirePaneInstance(getState().config.layout, String(id)).instanceId);
        const nextLayout = {
          ...getState().config.layout,
          dockRoot: buildGridDockRoot(paneIds, optionalNumber(input, "columns")),
          floating: getState().config.layout.floating.filter((entry) => !paneIds.includes(entry.instanceId)),
          detached: (getState().config.layout.detached ?? []).filter((entry) => !paneIds.includes(entry.instanceId)),
        };
        pluginRegistry.updateLayoutFn(nextLayout);
        return getAfterMutationSummary({ affectedPaneIds: paneIds });
      }
      case "desktop.popOutPane":
        await desktopWindowBridge?.popOutPane?.(stringInput(input, "paneId"));
        return getAfterMutationSummary({ affectedPaneIds: [stringInput(input, "paneId")] });
      case "desktop.dockPane":
        await desktopWindowBridge?.dockDetachedPane?.(stringInput(input, "paneId"));
        return getAfterMutationSummary({ affectedPaneIds: [stringInput(input, "paneId")] });
      case "desktop.closeDetachedPane":
        await desktopWindowBridge?.closeDetachedPane?.(stringInput(input, "paneId"));
        return getAfterMutationSummary({ affectedPaneIds: [stringInput(input, "paneId")] });
      case "desktop.focusDetachedPane":
        await desktopWindowBridge?.focusDetachedPane?.(stringInput(input, "paneId"));
        return getAfterMutationSummary({ affectedPaneIds: [stringInput(input, "paneId")] });
      case "capability.invoke":
        return await pluginRegistry.capabilities.invoke(
          stringInput(input, "capabilityId"),
          stringInput(input, "operationId"),
          input.payload ?? {},
        );
      case "ui.invoke": {
        const result = await uiRegistry?.invoke(
          stringInput(input, "nodeId"),
          optionalString(input, "action") ?? "press",
          input.input,
        );
        return getAfterMutationSummary({ result });
      }
      case "ui.invokeMatching":
        return invokeMatchingUiNode(input);
      default:
        throw new Error(`Unknown remote operation "${operation}".`);
    }
  };

  const handle = async (request: RemoteControlRequest): Promise<RemoteControlResponse> => {
    try {
      switch (request.type) {
        case "help":
          return ok(REMOTE_AGENT_HELP, revisionFor(REMOTE_AGENT_HELP));
        case "schema":
          return ok(remoteControlSchema());
        case "get": {
          const data = getResource(request.resource);
          return ok(data, revisionFor(data), buildIncludedState(request.include));
        }
        case "data":
          return ok(await queryMarketData(request));
        case "call": {
          const data = await call(request.operation, request.input, request.dryRun);
          return ok(data, undefined, buildIncludedState(request.include, request.dryRun ? [] : DEFAULT_MUTATION_INCLUDE));
        }
        case "patch": {
          const target = patchTarget(request.resource);
          const currentRev = revisionFor(target.value);
          if (request.expectRev && request.expectRev !== currentRev) {
            throw new Error(`Revision mismatch for ${request.resource}: expected ${request.expectRev}, got ${currentRev}.`);
          }
          const nextValue = applyJsonPatch(target.value, request.patch as RemoteJsonPatchOperation[]);
          if (!request.dryRun) {
            await target.apply(nextValue);
            await afterMutation();
          }
          return ok(
            nextValue,
            revisionFor(nextValue),
            buildIncludedState(request.include, request.dryRun ? [] : DEFAULT_MUTATION_INCLUDE),
          );
        }
        case "batch": {
          const responses = [];
          const haltOnError = request.haltOnError !== false;
          let haltedAt: number | null = null;
          for (const entry of request.requests) {
            const entryRequest = request.dryRun && (entry.type === "call" || entry.type === "patch")
              ? { ...entry, dryRun: true, include: entry.include ?? [] } as RemoteControlRequest
              : (entry.type === "call" || entry.type === "patch")
                ? { ...entry, include: entry.include ?? [] } as RemoteControlRequest
                : entry;
            const response = await handle(entryRequest);
            responses.push(response);
            if (request.settle === "afterEach") await afterMutation();
            if (!response.ok && haltOnError) {
              haltedAt = responses.length - 1;
              break;
            }
          }
          if (request.settle === "afterBatch") await afterMutation();
          return ok({
            ok: responses.every((response) => response.ok),
            haltedAt,
            responses,
          }, undefined, buildIncludedState(request.include, request.dryRun ? [] : DEFAULT_MUTATION_INCLUDE));
        }
        default:
          throw new Error(`Unknown remote request type: ${(request as { type?: unknown }).type}`);
      }
    } catch (error) {
      return fail("remote_error", error);
    }
  };

  return { handle };
}
