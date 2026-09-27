import type { AppState } from "../../../../state/app/context";
import type {
  CommandDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../../types/plugin";
import { isManualPortfolio } from "../../../../plugins/builtin/portfolio-list/mutations";
import { normalizeTickerInput } from "../../../../tickers/search";
import {
  getCollectionCommandAction,
  getCollectionCommandKind,
  getCollectionCommandVerb,
  isCollectionCommand,
} from "../../helpers";
import type { ResultItem } from "../../list/model";
import {
  resolvePreferredCollectionTarget,
  resolveSoleCollectionTarget,
} from "../../workflow/ops";
import type { parseRootShortcutIntent } from "./shortcuts";
import { recordFunctionOpen } from "../../../../telemetry/usage-counts";

type RootShortcutIntent = ReturnType<typeof parseRootShortcutIntent>;

interface PaneTemplateItemOptions {
  category?: string;
  createOptions?: PaneTemplateCreateOptions;
  showShortcut?: boolean;
  shortcutExecution?: boolean;
}

interface RootShortcutItemOptions {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  createPaneTemplateItem: (
    template: PaneTemplateDef,
    options?: PaneTemplateItemOptions,
  ) => ResultItem;
  createPluginCommandItem: (
    command: CommandDef,
    options?: { shortcutArg?: string },
  ) => ResultItem;
  executeCollectionCommand: (
    commandId: "add-watchlist" | "add-portfolio" | "remove-watchlist" | "remove-portfolio",
    rawInput?: string,
  ) => void | Promise<void>;
  rootShortcutIntent: RootShortcutIntent;
  runSecurityDescriptionShortcut: (query?: string) => void | Promise<void>;
  state: AppState;
}

export function buildRootShortcutItem({
  activeCollectionId,
  activeTickerSymbol,
  createPaneTemplateItem,
  createPluginCommandItem,
  executeCollectionCommand,
  rootShortcutIntent,
  runSecurityDescriptionShortcut,
  state,
}: RootShortcutItemOptions): ResultItem | null {
  if (rootShortcutIntent.kind === "none") return null;

  if (rootShortcutIntent.source === "pane-template") {
    return createPaneTemplateItem(rootShortcutIntent.template, {
      category: "Panes",
      createOptions: rootShortcutIntent.argText
        ? { arg: rootShortcutIntent.argText }
        : undefined,
      showShortcut: true,
      shortcutExecution: true,
    });
  }

  if (rootShortcutIntent.source === "plugin-command") {
    return createPluginCommandItem(rootShortcutIntent.command, {
      shortcutArg: rootShortcutIntent.argText,
    });
  }

  const { command } = rootShortcutIntent;
  if (command.id === "security-description") {
    const inferredSymbol = normalizeTickerInput(activeTickerSymbol, undefined);
    if (!rootShortcutIntent.argText && inferredSymbol) {
      return {
        id: "security-description:inferred",
        label: inferredSymbol,
        detail: `Open security details for ${inferredSymbol}`,
        category: "Search",
        kind: "action",
        right: command.prefix,
        shortcutQuery: command.prefix,
        action: () => {
          void runSecurityDescriptionShortcut(inferredSymbol);
        },
      };
    }
    return null;
  }

  if (!isCollectionCommand(command.id)) return null;

  const manualPortfolios = state.config.portfolios.filter(isManualPortfolio);
  const commandId = command.id;
  const action = getCollectionCommandAction(commandId);
  const kind = getCollectionCommandKind(commandId);
  const displayTicker = normalizeTickerInput(
    activeTickerSymbol,
    rootShortcutIntent.argText,
  );
  const displayName = kind === "watchlist" ? "Watchlist" : "Portfolio";
  const localTicker = displayTicker ? state.tickers.get(displayTicker) ?? null : null;
  const preferredTargetId = commandId === "add-portfolio"
    ? (activeCollectionId && manualPortfolios.some(
      (portfolio) => portfolio.id === activeCollectionId,
    )
      ? activeCollectionId
      : manualPortfolios.length === 1
        ? manualPortfolios[0]!.id
        : null)
    : (
      resolvePreferredCollectionTarget(
        state,
        kind,
        activeCollectionId,
        action,
        localTicker,
      )
      ?? (commandId === "add-watchlist"
        ? resolveSoleCollectionTarget(state, kind, action, localTicker)
        : null)
    );
  const preferredTargetName = preferredTargetId
    ? (kind === "watchlist"
      ? state.config.watchlists.find((entry) => entry.id === preferredTargetId)?.name
      : state.config.portfolios.find((entry) => entry.id === preferredTargetId)?.name)
    : null;

  return {
    id: `shortcut:${command.id}:${displayTicker || ""}`,
    label: displayTicker
      ? `${getCollectionCommandVerb(action)} ${displayTicker} ${action === "add" ? "to" : "from"} ${displayName}`
      : command.label,
    detail: preferredTargetName
      ? `${action === "add" ? "Target" : "Current"} "${preferredTargetName}"`
      : displayTicker
        ? `Choose a ${displayName.toLowerCase()}`
        : "Choose a ticker",
    category: command.category,
    kind: "command",
    right: command.prefix,
    shortcutQuery: command.prefix,
    action: () => {
      recordFunctionOpen({ shortcut: command.prefix, externalPluginId: null });
      void executeCollectionCommand(
        commandId,
        rootShortcutIntent.argText || undefined,
      );
    },
  };
}
