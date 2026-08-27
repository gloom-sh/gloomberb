import type { AppState } from "../../../../state/app/context";
import { normalizeTickerInput } from "../../../../tickers/search";
import {
  getCollectionCommandAction,
  getCollectionCommandKind,
  getCollectionCommandVerb,
  isCollectionCommand,
} from "../../helpers";
import {
  getPaneTemplateArgKind,
} from "../../pane-templates/items";
import type { ShortcutIntent } from "./shortcuts";
import type { CommandBarRoute } from "../../workflow/types";
import {
  resolvePreferredCollectionTarget,
  resolveSoleCollectionTarget,
} from "../../workflow/ops";

export function buildRootShortcutFeedback({
  activeCollectionId,
  activeTickerSymbol,
  currentRoute,
  rootShortcutIntent,
  state,
}: {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  currentRoute: CommandBarRoute | null;
  rootShortcutIntent: ShortcutIntent;
  state: AppState;
}): string | null {
  if (currentRoute || rootShortcutIntent.kind === "none") return null;

  if (rootShortcutIntent.source === "pane-template") {
    const argKind = getPaneTemplateArgKind(rootShortcutIntent.template);
    if (argKind === "ticker") {
      if (rootShortcutIntent.template.shortcut?.argOptional && !rootShortcutIntent.argText) {
        return `Shortcut: ${rootShortcutIntent.label}`;
      }
      const symbol = normalizeTickerInput(activeTickerSymbol, rootShortcutIntent.argText);
      if (symbol) {
        return rootShortcutIntent.kind === "inferred-complete"
          ? `Shortcut: ${rootShortcutIntent.label} for ${symbol} · Tab to accept`
          : `Shortcut: ${rootShortcutIntent.label} for ${symbol}`;
      }
      return `Shortcut: ${rootShortcutIntent.label} · Enter to choose ticker`;
    }
    if (argKind === "ticker-list") {
      if (rootShortcutIntent.argText) {
        return `Shortcut: ${rootShortcutIntent.label} · ${rootShortcutIntent.argText}`;
      }
      const inferred = normalizeTickerInput(activeTickerSymbol, undefined);
      if (inferred) {
        return `Shortcut: ${rootShortcutIntent.label} for ${inferred} · Tab to accept`;
      }
      return `Shortcut: ${rootShortcutIntent.label} · Enter tickers`;
    }
    return `Shortcut: ${rootShortcutIntent.label}`;
  }

  if (rootShortcutIntent.source === "plugin-command") {
    return rootShortcutIntent.argText
      ? `Shortcut: ${rootShortcutIntent.label} · ${rootShortcutIntent.argText}`
      : `Shortcut: ${rootShortcutIntent.label}`;
  }

  if (rootShortcutIntent.command.id === "security-description") {
    const symbol = normalizeTickerInput(activeTickerSymbol, rootShortcutIntent.argText);
    if (symbol) {
      return rootShortcutIntent.kind === "inferred-complete"
        ? `Shortcut: ${rootShortcutIntent.prefix} ${symbol} · Tab to accept`
        : `Shortcut: ${rootShortcutIntent.prefix} ${symbol}`;
    }
    return "Shortcut: Description";
  }

  if (isCollectionCommand(rootShortcutIntent.command.id)) {
    const commandId = rootShortcutIntent.command.id;
    const action = getCollectionCommandAction(commandId);
    const kind = getCollectionCommandKind(commandId);
    const displayTicker = normalizeTickerInput(activeTickerSymbol, rootShortcutIntent.argText);
    const localTicker = displayTicker ? state.tickers.get(displayTicker) ?? null : null;
    const preferredTargetId = resolvePreferredCollectionTarget(
      state,
      kind,
      activeCollectionId,
      action,
      localTicker,
    ) ?? (commandId === "add-watchlist"
      ? resolveSoleCollectionTarget(
        state,
        kind,
        action,
        localTicker,
      )
      : null);
    const preferredTargetName = preferredTargetId
      ? (kind === "watchlist"
        ? state.config.watchlists.find((entry) => entry.id === preferredTargetId)?.name
        : state.config.portfolios.find((entry) => entry.id === preferredTargetId)?.name)
      : null;
    if (displayTicker) {
      return preferredTargetName
        ? `Shortcut: ${getCollectionCommandVerb(action)} ${displayTicker} ${action === "add" ? "to" : "from"} "${preferredTargetName}"`
        : `Shortcut: ${getCollectionCommandVerb(action)} ${displayTicker} · choose ${kind}`;
    }
    return `Shortcut: ${rootShortcutIntent.command.label}`;
  }

  return null;
}
