import type { AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import {
  addTickerToPortfolio,
  isManualPortfolio,
  removeTickerFromPortfolio,
} from "../../../plugins/builtin/portfolio-list/mutations";
import {
  applyCollectionMembershipChange,
  getCollectionTargetOptions,
  resolvePreferredCollectionTarget,
  resolveSoleCollectionTarget,
  resolveTickerInput,
} from "../workflow/ops";
import {
  getCollectionCommandAction,
  getCollectionCommandKind,
  getCollectionCommandVerb,
} from "../helpers";
import type { CommandBarRoute } from "../workflow/types";

export type CollectionCommandId =
  | "add-watchlist"
  | "add-portfolio"
  | "remove-watchlist"
  | "remove-portfolio";

type WorkflowDeps = Parameters<typeof resolveTickerInput>[3];

export async function executeCollectionCommandAction(options: {
  commandId: CollectionCommandId;
  rawInput?: string;
  explicitTargetId?: string | null;
  selectedTicker?: TickerRecord;
  activeTickerSymbol: string | null;
  activeCollectionId: string | null;
  getState: () => AppState;
  buildWorkflowDeps: () => WorkflowDeps;
  openModeRoute: (screen: "ticker-search", initialQuery?: string, payload?: Record<string, unknown>) => void;
  openAddToPortfolioWorkflow: (ticker: TickerRecord, preferredPortfolioId?: string | null) => void;
  pushRoute: (route: CommandBarRoute) => void;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
}): Promise<void> {
  const stateForCommand = options.getState();
  const kind = getCollectionCommandKind(options.commandId);
  const action = getCollectionCommandAction(options.commandId);
  const deps = options.buildWorkflowDeps();
  const resolvedTicker = options.selectedTicker
    ? { symbol: options.selectedTicker.metadata.ticker, ticker: options.selectedTicker }
    : await resolveTickerInput(
      options.rawInput,
      options.activeTickerSymbol,
      options.activeCollectionId,
      deps,
    );

  if (!resolvedTicker) {
    options.openModeRoute("ticker-search", options.rawInput?.trim() || "", {
      action: "collection-command",
      commandId: options.commandId,
    });
    return;
  }

  if (kind === "portfolio" && action === "add") {
    const manualPortfolios = stateForCommand.config.portfolios.filter(isManualPortfolio);
    if (manualPortfolios.length === 0) {
      options.notify("Create a manual portfolio first.", { type: "info" });
      return;
    }

    const preferredTargetId = options.explicitTargetId
      ?? (options.activeCollectionId && manualPortfolios.some((portfolio) => portfolio.id === options.activeCollectionId)
        ? options.activeCollectionId
        : manualPortfolios.length === 1
          ? manualPortfolios[0]!.id
          : null);

    if (!preferredTargetId) {
      options.pushRoute({
        kind: "picker",
        pickerId: "collection-target",
        title: `Add ${resolvedTicker.symbol} to Portfolio`,
        query: "",
        selectedIdx: 0,
        hoveredIdx: null,
        options: manualPortfolios.map((portfolio) => {
          const isMember = resolvedTicker.ticker.metadata.portfolios.includes(portfolio.id);
          const description = isMember
            ? `Update position in "${portfolio.name}"`
            : `Add to "${portfolio.name}"`;
          return {
            id: portfolio.id,
            label: portfolio.name,
            detail: description,
            description,
          };
        }),
        payload: {
          commandId: options.commandId,
          kind,
          action,
          symbol: resolvedTicker.symbol,
        },
      });
      return;
    }

    options.openAddToPortfolioWorkflow(resolvedTicker.ticker, preferredTargetId);
    return;
  }

  const targetId = options.explicitTargetId
    ?? (
      kind === "watchlist" && action === "add"
        ? resolvePreferredCollectionTarget(
          stateForCommand,
          kind,
          options.activeCollectionId,
          action,
          resolvedTicker.ticker,
        ) ?? resolveSoleCollectionTarget(
          stateForCommand,
          kind,
          action,
          resolvedTicker.ticker,
        )
        : resolvePreferredCollectionTarget(
          stateForCommand,
          kind,
          options.activeCollectionId,
          action,
          resolvedTicker.ticker,
        )
    );

  if (!targetId) {
    const targetOptions = getCollectionTargetOptions(stateForCommand, kind, action, resolvedTicker.ticker)
      .map((option) => ({
        id: option.id,
        label: option.label,
        detail: option.description,
        description: option.description,
      }));
    if (targetOptions.length === 0) {
      options.notify(
        action === "add"
          ? `No ${kind}s are available for ${resolvedTicker.symbol}.`
          : `${resolvedTicker.symbol} is not in any ${kind}.`,
        { type: "info" },
      );
      return;
    }
    options.pushRoute({
      kind: "picker",
      pickerId: "collection-target",
      title: `${getCollectionCommandVerb(action)} ${resolvedTicker.symbol} ${action === "add" ? "to" : "from"} ${kind === "watchlist" ? "Watchlist" : "Portfolio"}`,
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      options: targetOptions,
      payload: {
        commandId: options.commandId,
        kind,
        action,
        symbol: resolvedTicker.symbol,
      },
    });
    return;
  }

  let changed = false;
  if (kind === "watchlist") {
    ({ changed } = await applyCollectionMembershipChange(
      resolvedTicker.ticker,
      kind,
      action,
      targetId,
      deps,
    ));
  } else {
    const portfolio = stateForCommand.config.portfolios.find((entry) => entry.id === targetId);
    if (!portfolio || !isManualPortfolio(portfolio)) {
      options.notify("Choose a manual portfolio.", { type: "error" });
      return;
    }

    const result = action === "add"
      ? addTickerToPortfolio(resolvedTicker.ticker, targetId)
      : removeTickerFromPortfolio(resolvedTicker.ticker, targetId);

    changed = result.changed;
    if (result.changed) {
      await deps.tickerRepository.saveTicker(result.ticker);
      deps.dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
    }
  }

  const targetName = (kind === "watchlist"
    ? stateForCommand.config.watchlists.find((entry) => entry.id === targetId)?.name
    : stateForCommand.config.portfolios.find((entry) => entry.id === targetId)?.name) || targetId;
  if (changed) {
    options.notify(
      `${action === "add" ? "Added" : "Removed"} ${resolvedTicker.symbol} ${action === "add" ? "to" : "from"} "${targetName}".`,
      { type: "success" },
    );
  } else {
    options.notify(
      action === "add"
        ? `${resolvedTicker.symbol} is already in "${targetName}".`
        : `${resolvedTicker.symbol} is not in "${targetName}".`,
      { type: "info" },
    );
  }
  options.closeAll({ revertThemePreview: false });
}
