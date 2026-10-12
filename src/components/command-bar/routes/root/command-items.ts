import type { AppState } from "../../../../state/app/context";
import type { TickerRecord } from "../../../../types/ticker";
import { isManualPortfolio } from "../../../../plugins/builtin/portfolio-list/mutations";
import type { Command } from "../../commands/registry";
import type { ResultItem } from "../../list/model";
import { canRestartToApply } from "../../../../updater";

interface RootCommandItemBuilderOptions {
  activeCollectionId: string | null;
  activeTickerData: TickerRecord | null | undefined;
  activeTickerSymbol: string | null;
  hasPaneSettings: (paneId: string) => boolean;
  runDirectCommand: (command: Command, arg: string) => void;
  state: AppState;
}

export function createRootCommandItemBuilder({
  activeCollectionId,
  activeTickerData,
  activeTickerSymbol,
  hasPaneSettings,
  runDirectCommand,
  state,
}: RootCommandItemBuilderOptions): (command: Command, arg?: string) => ResultItem | null {
  const isWatchlistTab = state.config.watchlists.some(
    (entry) => entry.id === activeCollectionId,
  );
  const isPortfolioTab = state.config.portfolios.some(
    (entry) => entry.id === activeCollectionId,
  );
  const manualPortfolios = state.config.portfolios.filter(isManualPortfolio);
  const tickerData = activeTickerData;
  const focusedPaneHasSettings =
    !!state.focusedPaneId && hasPaneSettings(state.focusedPaneId);

  const targetWatchlistId = isWatchlistTab
    ? activeCollectionId
    : state.config.watchlists[0]?.id ?? null;
  const targetPortfolioId = isPortfolioTab
    ? manualPortfolios.find((entry) => entry.id === activeCollectionId)?.id ?? null
    : manualPortfolios[0]?.id ?? null;

  function shouldShow(command: Command): boolean {
    switch (command.id) {
      case "add-watchlist":
        return (
          !!tickerData &&
          !!targetWatchlistId &&
          !tickerData.metadata.watchlists.includes(targetWatchlistId)
        );
      case "remove-watchlist":
        return !!tickerData && tickerData.metadata.watchlists.length > 0;
      case "add-portfolio":
        return !!tickerData && manualPortfolios.length > 0;
      case "remove-portfolio":
        return !!tickerData && tickerData.metadata.portfolios.some((id) =>
          state.config.portfolios.some(
            (entry) => entry.id === id && isManualPortfolio(entry),
          ),
        );
      case "set-portfolio-position":
        return manualPortfolios.length > 0;
      case "disconnect-broker-account":
        return state.config.brokerInstances.length > 0;
      case "delete-watchlist":
        return state.config.watchlists.length > 0;
      case "delete-portfolio":
        return manualPortfolios.length > 0;
      case "pane-settings":
        return focusedPaneHasSettings;
      default:
        return true;
    }
  }

  function smartLabel(command: Command): string {
    switch (command.id) {
      case "add-watchlist":
        return activeTickerSymbol ? `Add ${activeTickerSymbol} to Watchlist` : command.label;
      case "remove-watchlist":
        return activeTickerSymbol ? `Remove ${activeTickerSymbol} from Watchlist` : command.label;
      case "add-portfolio":
        return activeTickerSymbol ? `Add ${activeTickerSymbol} to Portfolio` : command.label;
      case "remove-portfolio":
        return activeTickerSymbol ? `Remove ${activeTickerSymbol} from Portfolio` : command.label;
      case "set-portfolio-position":
        return activeTickerSymbol ? `Set Position for ${activeTickerSymbol}` : command.label;
      // The row only shows its label, so a downloaded update is announced there.
      case "check-for-updates":
        return state.updateProgress?.phase === "ready" ? "Update ready, restart to apply" : command.label;
      default:
        return command.label;
    }
  }

  function smartDetail(command: Command): string {
    switch (command.id) {
      case "add-watchlist": {
        const name = state.config.watchlists.find(
          (entry) => entry.id === targetWatchlistId,
        )?.name;
        return name ? `in "${name}"` : command.description;
      }
      case "remove-watchlist": {
        const names = tickerData?.metadata.watchlists
          .map((id) => state.config.watchlists.find((entry) => entry.id === id)?.name)
          .filter(Boolean);
        return names?.length ? `from "${names.join(", ")}"` : command.description;
      }
      case "add-portfolio": {
        const name = state.config.portfolios.find(
          (entry) => entry.id === targetPortfolioId,
        )?.name;
        return name ? `in "${name}"` : command.description;
      }
      case "remove-portfolio": {
        const names = tickerData?.metadata.portfolios
          .map((id) => state.config.portfolios.find(
            (entry) => entry.id === id && isManualPortfolio(entry),
          )?.name)
          .filter(Boolean);
        return names?.length ? `from "${names.join(", ")}"` : command.description;
      }
      case "set-portfolio-position": {
        const name = state.config.portfolios.find(
          (entry) => entry.id === targetPortfolioId,
        )?.name;
        return name ? `in "${name}"` : command.description;
      }
      case "check-for-updates":
        if (state.updateProgress?.phase === "downloading") {
          return `Downloading v${state.updateAvailable?.version}: ${state.updateProgress.percent ?? 0}%`;
        }
        if (state.updateProgress?.phase === "replacing") return "Installing update";
        if (state.updateProgress?.phase === "ready") return "Update ready, restart to apply";
        if (state.updateProgress?.phase === "done") {
          return state.updateProgress.message ?? "Update ready, restart to apply";
        }
        if (state.updateProgress?.phase === "error") {
          return `Update failed: ${state.updateProgress.error}`;
        }
        if (state.updateCheckInProgress) return "Checking releases now";
        if (state.updateAvailable) {
          return `Latest available: v${state.updateAvailable.version}`;
        }
        if (state.updateNotice) return state.updateNotice;
        return command.description;
      case "toggle-value-flashing":
        return state.config.valueFlashingEnabled ? "Currently on" : "Currently off";
      case "toggle-presentation-mode":
        return state.config.presentationMode ? "Currently on" : "Currently off";
      case "toggle-crash-reports":
        return state.config.telemetry?.crashReports === false ? "Currently off" : "Currently on";
      case "toggle-usage-counts":
        return state.config.telemetry?.usage === false ? "Currently off" : "Currently on";
      case "toggle-attention-counts":
        return state.config.telemetry?.attention === true
          ? "Currently on: share ticker research counts"
          : "Currently off: opt in to sharing ticker research counts";
      case "font-size-increase":
      case "font-size-decrease":
        return `Currently ${state.config.fontSize ?? 12}px`;
      default:
        return command.description;
    }
  }

  /** The shortcut on the right; the telemetry switches show their state there instead. */
  function smartRight(command: Command, arg: string): string | undefined {
    switch (command.id) {
      case "language":
        return arg || command.prefix;
      case "toggle-crash-reports":
        return state.config.telemetry?.crashReports === false ? "off" : "on";
      case "toggle-usage-counts":
        return state.config.telemetry?.usage === false ? "off" : "on";
      case "toggle-attention-counts":
        return state.config.telemetry?.attention === true ? "on" : "off";
      default:
        return command.prefix || undefined;
    }
  }

  function smartSearchText(command: Command): string {
    switch (command.id) {
      case "set-portfolio-position":
        return "edit position update position modify position manual position portfolio position";
      case "check-for-updates":
        return state.updateProgress?.phase === "ready" ? "check for updates restart relaunch" : "";
      default:
        return "";
    }
  }

  return (command, arg = "") => {
    if (!shouldShow(command)) return null;
    return {
      id: command.id,
      label: smartLabel(command),
      detail: smartDetail(command),
      category: command.category,
      kind: "command",
      right: smartRight(command, arg),
      shortcutQuery: command.prefix || undefined,
      searchText: smartSearchText(command),
      disabled:
        command.id === "check-for-updates" &&
        (state.updateCheckInProgress || (!!state.updateProgress && !canRestartToApply(state.updateProgress))),
      action: () => runDirectCommand(command, arg),
    };
  };
}
