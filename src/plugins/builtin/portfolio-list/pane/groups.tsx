import { useCallback, useMemo, useRef } from "react";
import { ChoiceDialog, confirmDialog, TextPromptDialog, usePaneFooter, usePaneMenuItems } from "../../../../components";
import type { TickerTableGroup } from "../../../../components/ticker/list-table-view";
import { t, tf } from "../../../../i18n";
import {
  renameWatchlistGroup,
  sectionWatchlistItems,
  setWatchlistGroup,
  UNGROUPED_LABEL,
  watchlistGroupOf,
  watchlistGroups,
  watchlistTakesGroups,
} from "../../../../portfolio/watchlist-groups";
import { syncConfigActiveLayoutState, useAppDispatch, useAppStateRef } from "../../../../state/app/context";
import { scheduleConfigSave } from "../../../../state/config-save-scheduler";
import type { AppConfig } from "../../../../types/config";
import type { ContextMenuItem } from "../../../../types/context-menu";
import type { TickerRecord, Watchlist } from "../../../../types/ticker";
import { useDialog, type PromptContext } from "../../../../ui/dialog";
import { logFailure } from "../../../../utils/log-failure";
import { usePluginAppActions } from "../../../runtime";

/** `g` moves the cursor row to a group: the row menu shows it beside Move to Group…. */
const MOVE_TO_GROUP_KEY = "g";
/** The section of the tickers in no group; no group's name is empty. */
const UNGROUPED_ID = "";
const NEW_GROUP_CHOICE = "\u0000new-group";

/** A section the pane shows collapsed, by its list: the group's name, or "" for Ungrouped. Kept in the pane's state. */
export interface CollapsedGroup {
  list: string;
  group: string;
}

/**
 * A watchlist's rows under its groups, each group's rows in the order given
 * (the table's sort), then Ungrouped. Undefined when no row is in a group, so
 * a list without groups shows as it always has.
 */
export function buildWatchlistTableGroups(
  watchlist: Pick<Watchlist, "id" | "groups"> | null,
  sortedTickers: readonly TickerRecord[],
  collapsed: readonly CollapsedGroup[],
): TickerTableGroup[] | undefined {
  if (!watchlist) return undefined;
  const sections = sectionWatchlistItems(watchlistGroups(watchlist), sortedTickers, (ticker) => ticker.metadata.ticker);
  if (!sections) return undefined;
  return sections.map(({ name, items }) => {
    const id = name ?? UNGROUPED_ID;
    return {
      id,
      label: name ?? t(UNGROUPED_LABEL),
      tickers: items,
      collapsed: collapsed.some((entry) => entry.list === watchlist.id && entry.group === id),
    };
  });
}

/** The pane's collapsed sections with one of a list's flipped. */
export function toggleCollapsedGroup(collapsed: readonly CollapsedGroup[], list: string, group: string): CollapsedGroup[] {
  const shown = collapsed.filter((entry) => entry.list !== list || entry.group !== group);
  return shown.length < collapsed.length ? shown : [...collapsed, { list, group }];
}

/**
 * Moving the rows of a personal watchlist between its groups: Move to Group…
 * (`g`) and Remove from Group in a row's menu, and Rename Group… and Delete
 * Group… in the pane menu while the cursor is on a group's header. `onMoved`
 * hears the group a row went to, so the pane can show it.
 */
export function useWatchlistGroupActions({
  watchlist,
  cursorTicker,
  cursorGroup,
  enabled,
  onMoved,
}: {
  watchlist: Watchlist | null;
  /** The ticker under the cursor, for `g`. */
  cursorTicker: TickerRecord | null;
  /** The named group whose header the cursor is on. */
  cursorGroup: string | null;
  enabled: boolean;
  onMoved: (symbol: string, group: string | null) => void;
}): ((ticker: TickerRecord) => ContextMenuItem[]) | undefined {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { notify } = usePluginAppActions();
  const busyRef = useRef(false);
  const takesGroups = !!watchlist && watchlistTakesGroups(watchlist);
  const listId = takesGroups ? watchlist.id : null;
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;

  // With the panes' live state in the layout, so the config keeps the cursor where the row went.
  const save = useCallback((config: AppConfig) => {
    const state = stateRef.current;
    const synced = syncConfigActiveLayoutState(config, state.paneState, state.focusedPaneId);
    dispatch({ type: "SET_CONFIG", config: synced });
    scheduleConfigSave(synced);
  }, [dispatch, stateRef]);

  // The list as it is now, in case a sync changed it while a dialog was open.
  const currentList = useCallback(() => (listId ? stateRef.current.config.watchlists.find((entry) => entry.id === listId) ?? null : null), [listId, stateRef]);

  const fail = useCallback((error: unknown) => {
    notify({ type: "error", body: error instanceof Error ? error.message : String(error) });
  }, [notify]);

  const moveTo = useCallback((symbol: string, group: string | null) => {
    const list = currentList();
    if (!list) return;
    try {
      const result = setWatchlistGroup(stateRef.current.config, list.id, [symbol], group);
      if (result.moved.length > 0) save(result.config);
      onMovedRef.current(symbol, result.group);
    } catch (error) {
      fail(error);
    }
  }, [currentList, fail, save, stateRef]);

  /** The name a new group is given, typed in a prompt; null when none was. */
  const askName = useCallback(async (title: string, body: string | null, confirmLabel: string, initialValue = "") => {
    const typed = await dialog.prompt<string>({
      content: (context) => (
        <TextPromptDialog {...context} title={title} body={body ? [body] : undefined} label={t("Name")} initialValue={initialValue}
          placeholder={t("Energy")} confirmLabel={confirmLabel} width={52} />
      ),
    });
    return typed?.trim() ? typed : null;
  }, [dialog]);

  const promptMove = useCallback(async (symbol: string) => {
    const list = currentList();
    if (!list || busyRef.current) return;
    busyRef.current = true;
    try {
      const current = watchlistGroupOf(list, symbol);
      const others = watchlistGroups(list).filter((group) => group.name !== current);
      let choice: string | undefined = NEW_GROUP_CHOICE;
      if (others.length > 0) {
        choice = await dialog.prompt<string>({
          content: (context: PromptContext<string>) => (
            <ChoiceDialog {...context} title={tf("Move {symbol} to Group", { symbol })} choices={[
              ...others.map((group) => ({ id: group.name, label: group.name })),
              { id: NEW_GROUP_CHOICE, label: t("New Group…") },
            ]} />
          ),
        });
      }
      if (choice == null) return;
      const name = choice === NEW_GROUP_CHOICE
        ? await askName(t("New Group"), tf("{symbol} moves to it in {watchlist}.", { symbol, watchlist: list.name }), t("Move"))
        : choice;
      if (name != null) moveTo(symbol, name);
    } finally {
      busyRef.current = false;
    }
  }, [askName, currentList, dialog, moveTo]);

  const startMove = useCallback((symbol: string) => {
    promptMove(symbol).catch((error: unknown) => {
      fail(error);
      logFailure("portfolio-list.groups", "Move to group failed")(error);
    });
  }, [fail, promptMove]);

  const rowMenuItems = useMemo(() => listId ? (ticker: TickerRecord): ContextMenuItem[] => {
    const symbol = ticker.metadata.ticker;
    const inGroup = watchlistGroupOf(currentList(), symbol) != null;
    return [
      { id: "watchlist:move-to-group", label: t("Move to Group…"), accelerator: MOVE_TO_GROUP_KEY, onSelect: () => startMove(symbol) },
      ...inGroup ? [{ id: "watchlist:remove-from-group", label: t("Remove from Group"), onSelect: () => moveTo(symbol, null) }] : [],
    ];
    // Built again when the list's groups change, so the cursor row's menu offers Remove from Group once it is in one.
  } : undefined, [currentList, listId, moveTo, startMove, watchlist?.groups]);

  const cursorSymbol = cursorTicker?.metadata.ticker ?? null;
  usePaneFooter("portfolio-list-groups", () => enabled && listId && cursorSymbol ? {
    keys: [{ id: "move-to-group", key: MOVE_TO_GROUP_KEY, label: "", title: t("Move to Group"), onPress: () => startMove(cursorSymbol) }],
  } : null, [cursorSymbol, enabled, listId, startMove]);

  const renameGroup = useCallback(async (group: string) => {
    const list = currentList();
    if (!list) return;
    const name = await askName(t("Rename Group"), null, t("Rename"), group);
    if (name == null) return;
    try {
      save(renameWatchlistGroup(stateRef.current.config, list.id, group, name));
    } catch (error) {
      fail(error);
    }
  }, [askName, currentList, fail, save, stateRef]);

  const deleteGroup = useCallback(async (group: string) => {
    const list = currentList();
    const symbols = watchlistGroups(list).find((entry) => entry.name === group)?.symbols ?? [];
    if (!list || symbols.length === 0) return;
    const confirmed = await confirmDialog(dialog, {
      title: tf("Delete the group {group}?", { group }),
      body: [t("Its tickers stay in the list, in no group.")],
      confirmLabel: t("Delete"),
    });
    if (!confirmed) return;
    try {
      const result = setWatchlistGroup(stateRef.current.config, list.id, symbols, null);
      if (result.moved.length > 0) save(result.config);
    } catch (error) {
      fail(error);
    }
  }, [currentList, dialog, fail, save, stateRef]);

  usePaneMenuItems("portfolio-list-group-header", () => enabled && listId && cursorGroup ? [
    { id: "rename-group", label: t("Rename Group…"), onSelect: () => { renameGroup(cursorGroup).catch(logFailure("portfolio-list.groups", "Rename group failed")); } },
    { id: "delete-group", label: t("Delete Group…"), onSelect: () => { deleteGroup(cursorGroup).catch(logFailure("portfolio-list.groups", "Delete group failed")); } },
  ] : null, [cursorGroup, deleteGroup, enabled, listId, renameGroup]);

  return rowMenuItems;
}
