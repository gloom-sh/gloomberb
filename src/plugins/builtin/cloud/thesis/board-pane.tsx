import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiClient, type CloudThesis } from "../../../../api-client";
import {
  DataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { useAppSelector, usePaneStateValue } from "../../../../state/app/context";
import { colors } from "../../../../theme/colors";
import type { PaneProps } from "../../../../types/plugin";
import { Box, TextAttributes, type InputRenderable } from "../../../../ui";
import { useDialog } from "../../../../ui/dialog";
import { formatCompactCurrency } from "../../../../utils/format";
import { isPlainKey } from "../../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../../utils/search-focus-navigation";
import { usePluginAppActions } from "../../../runtime";
import { SignInWall } from "../auth-actions";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { usePlanAccess } from "../../shared/plan-access";
import { teamStore } from "../team/store";
import { ThesisDetail } from "./detail";
import { useBookExposure } from "./exposure";
import * as flows from "./flows";
import {
  attentionReason,
  boardGroup,
  bookAtRisk,
  convictionRows,
  daysSince,
  daysUntil,
  describeAttention,
  describeDays,
  groupLabel,
  healthLabel,
  nextCatalyst,
  parseSymbolList,
  sortForBoard,
  thesesCovering,
  thesesInScope,
  thesisExposure,
  thesisNames,
  untrackedRows,
  type BoardGroup,
  type UntrackedRow,
} from "./model";
import { promptChoice, promptText } from "./prompts";
import { consumeRequestedThesis, subscribeRequestedThesis, type ThesisPaneRequest } from "./pane-request";
import { thesisStore } from "./store";

export const THESIS_PANE_ID = "thesis-board";
/**
 * The scope select's value for the whole book, whose collection id is null.
 * Not a plain word, so a portfolio or watchlist id named "all" cannot collide.
 */
const ALL_SCOPE = "__all__";

type BoardItem =
  | { kind: "header"; id: string; group: BoardGroup | "untracked" }
  | { kind: "thesis"; id: string; group: BoardGroup; thesis: CloudThesis; names: string }
  | { kind: "untracked"; id: string; group: "untracked"; row: UntrackedRow };

/** Rows grouped under one header item per group; the table draws headers in place of a row. */
function withHeaders(items: readonly BoardItem[]): BoardItem[] {
  const out: BoardItem[] = [];
  let group: BoardItem["group"] | null = null;
  for (const item of items) {
    if (item.group !== group) {
      group = item.group;
      out.push({ kind: "header", id: `header:${group}`, group });
    }
    out.push(item);
  }
  return out;
}

type BoardColumnId = "title" | "name" | "health" | "conviction" | "signals" | "weight" | "reviewed" | "catalyst" | "owner";
type WeightColumnId = "title" | "conviction" | "weight" | "value" | "gap";
type BoardColumn = DataTableColumn & { id: BoardColumnId | WeightColumnId };

function boardColumns(width: number, showOwner: boolean): BoardColumn[] {
  const narrow = width < 90;
  return [
    { id: "title", label: "Thesis", width: narrow ? 14 : 22, align: "left" },
    ...(narrow ? [] : [{ id: "name" as const, label: "Name", width: 24, align: "left" as const, flexGrow: 1 }]),
    { id: "health", label: "Health", width: 10, align: "left" },
    { id: "conviction", label: "Conv", width: 4, align: "right" },
    { id: "signals", label: "Open", width: 4, align: "right" },
    { id: "weight", label: "Weight", width: 7, align: "right" },
    ...(narrow ? [] : [{ id: "reviewed" as const, label: "Reviewed", width: 9, align: "right" as const }]),
    { id: "catalyst", label: "Next catalyst", width: narrow ? 14 : 22, align: "left" },
    ...(showOwner && !narrow ? [{ id: "owner" as const, label: "Owner", width: 10, align: "left" as const }] : []),
  ];
}

function weightColumns(): BoardColumn[] {
  return [
    { id: "title", label: "Thesis", width: 26, align: "left", flexGrow: 1 },
    { id: "conviction", label: "Conv", width: 4, align: "right" },
    { id: "weight", label: "Weight", width: 7, align: "right" },
    { id: "value", label: "Value", width: 12, align: "right" },
    { id: "gap", label: "Gap", width: 14, align: "left" },
  ];
}

function relative(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return "never";
  return days === 0 ? "today" : `${days}d`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

export function ThesisBoardPane({ focused, width, height }: PaneProps) {
  const dialog = useDialog();
  const { notify } = usePluginAppActions();
  const plan = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const snapshot = useSyncExternalStore((onChange) => thesisStore.subscribe(onChange), () => thesisStore.getSnapshot());
  const teams = useSyncExternalStore((onChange) => teamStore.subscribe(onChange), () => teamStore.getSnapshot()).teams;
  const signedIn = useSyncExternalStore((onChange) => apiClient.subscribeCurrentUser(onChange), () => apiClient.isVerified());
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const [scopeId, setScopeId] = usePaneStateValue<string | null>("scope", null);
  const exposure = useBookExposure(scopeId);
  const [openId, setOpenId] = usePaneStateValue<string | null>("openId", null);
  // Kept beside the open thesis so a reload or a shared layout keeps the row.
  const [selectedId, setSelectedId] = usePaneStateValue<string | null>("selectedId", null);
  const [mode, setMode] = usePaneStateValue<"board" | "weights">("mode", "board");
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const ctx = useMemo<flows.FlowContext>(() => ({ dialog, notify, hasProAccess: plan.hasProAccess, openUpgrade }), [dialog, notify, openUpgrade, plan.hasProAccess]);

  // A portfolio scope shows the theses holding something in it and that
  // portfolio's weights; a watchlist scope shows what is listed there.
  const scopeSymbols = useMemo(
    () => (exposure.scope.kind === "all" ? null : new Set(exposure.tickers.map((ticker) => ticker.metadata.ticker.toUpperCase()))),
    [exposure.scope.kind, exposure.tickers],
  );
  const theses = useMemo(() => thesesInScope(snapshot.theses, scopeSymbols), [scopeSymbols, snapshot.theses]);
  const exposures = useMemo(
    () => theses.map((thesis) => thesisExposure(thesis, exposure.bySymbol, exposure.bookValue)),
    [exposure.bookValue, exposure.bySymbol, theses],
  );
  const exposureById = useMemo(() => new Map(exposures.map((entry) => [entry.thesis.id, entry])), [exposures]);
  const atRisk = useMemo(() => bookAtRisk(exposures), [exposures]);
  const untracked = useMemo(
    () => untrackedRows(exposure.tickers, snapshot.theses, exposure.bySymbol, exposure.bookValue, exposure.nameOf),
    [exposure.bookValue, exposure.bySymbol, exposure.nameOf, exposure.tickers, snapshot.theses],
  );

  const query = searchQuery.trim().toLowerCase();
  const boardItems = useMemo<BoardItem[]>(() => {
    const matches = (...fields: Array<string | null | undefined>) =>
      !query || fields.some((field) => field?.toLowerCase().includes(query));
    return withHeaders([
      ...sortForBoard(theses)
        .map((thesis): BoardItem => ({ kind: "thesis", id: thesis.id, group: boardGroup(thesis), thesis, names: thesisNames(thesis, exposure.nameOf) }))
        .filter((item) => item.kind === "thesis" && matches(item.thesis.title, item.names, ...item.thesis.document.instruments.map((entry) => entry.symbol))),
      ...untracked
        .filter((row) => matches(row.symbol, row.name))
        .map((row): BoardItem => ({ kind: "untracked", id: `untracked:${row.symbol}`, group: "untracked", row })),
    ]);
  }, [exposure.nameOf, query, theses, untracked]);
  const weightItems = useMemo(() => convictionRows(exposures).filter((row) => (
    !query || [row.thesis.title, thesisNames(row.thesis, exposure.nameOf), ...row.thesis.document.instruments.map((entry) => entry.symbol)]
      .some((field) => field?.toLowerCase().includes(query))
  )), [exposure.nameOf, exposures, query]);

  const openThesis = openId ? thesisStore.get(openId) : null;
  useEffect(() => {
    if (openId && !openThesis && snapshot.loaded) setOpenId(null);
  }, [openId, openThesis, setOpenId, snapshot.loaded]);

  const run = useCallback(async (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const startFor = useCallback((preset?: string) => run(async () => {
    const typed = preset ?? (await promptText(dialog, {
      label: "Thesis on which tickers?",
      body: ["One ticker, or several separated by spaces or commas for a basket or a pair."],
      placeholder: "NVDA, or NVDA AMD ASML",
    }));
    if (!typed) return;
    const symbols = parseSymbolList(typed);
    if (symbols.length === 0) return;
    let scope: { scope: "user" } | { scope: "team"; teamId: string } = { scope: "user" };
    if (teams.length > 0) {
      const owner = await promptChoice(dialog, "Whose thesis?", [
        { id: "user", label: "Mine" },
        ...teams.map((team) => ({ id: team.id, label: team.name, description: "Shared with the team; teammates can challenge it." })),
      ], teamStore.getDefaultTeamId() ?? "user");
      if (!owner) return;
      if (owner !== "user") scope = { scope: "team", teamId: owner };
    }
    const instruments = symbols.map((symbol) => {
      const ticker = tickersBySymbol.get(symbol);
      return { symbol, ...(ticker?.metadata.exchange ? { exchange: ticker.metadata.exchange } : {}) };
    });
    const held = symbols.some((symbol) => tickersBySymbol.get(symbol)?.metadata.positions.some((position) => position.shares !== 0));
    const thesis = await flows.startThesis(ctx, { instruments, scope, held });
    if (thesis) setOpenId(thesis.id);
  }), [ctx, dialog, run, setOpenId, teams, tickersBySymbol]);

  const activate = useCallback((item: BoardItem) => {
    if (item.kind === "thesis") setOpenId(item.thesis.id);
    else if (item.kind === "untracked") void startFor(item.row.symbol);
  }, [setOpenId, startFor]);

  // The THESIS command and notifications ask for a specific thesis or symbol.
  const applyRequest = useCallback((request: ThesisPaneRequest) => {
    if (request.thesisId) {
      setOpenId(request.thesisId);
      return;
    }
    if (request.symbol) {
      const symbols = parseSymbolList(request.symbol);
      const covering = symbols.length === 1 ? thesesCovering(thesisStore.getSnapshot().theses, symbols[0]!) : [];
      if (covering[0]) setOpenId(covering[0].id);
      else if (request.start) void startFor(symbols.join(" "));
      else setSelectedId(`untracked:${symbols[0] ?? ""}`);
    }
  }, [setOpenId, startFor]);
  useEffect(() => {
    const pending = consumeRequestedThesis();
    if (pending) applyRequest(pending);
    return subscribeRequestedThesis(applyRequest);
  }, [applyRequest]);

  const cycleScope = useCallback((delta: number) => {
    const index = exposure.scopes.findIndex((entry) => entry.collectionId === exposure.scope.collectionId);
    const next = exposure.scopes[(index + delta + exposure.scopes.length) % exposure.scopes.length];
    if (next) setScopeId(next.collectionId);
  }, [exposure.scope.collectionId, exposure.scopes, setScopeId]);

  // The search bar belongs to the board; weights mode has none to focus.
  const searchable = mode === "board" && !openId;
  useEffect(() => {
    if (searchFocused && !searchable) blurSearch();
  }, [blurSearch, searchFocused, searchable]);

  useShortcut((event) => {
    if (!focused || openId || busy || searchFocused) return;
    if (isPlainKey(event, "n")) void startFor();
    else if (isPlainKey(event, "w")) setMode(mode === "board" ? "weights" : "board");
    else if (isPlainKey(event, "p")) cycleScope(1);
    else if (searchable && isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return;
    } else if (isPlainKey(event, "r")) void thesisStore.refresh();
    else return;
    event.stopPropagation?.();
    event.preventDefault?.();
  });

  const columns = useMemo(
    () => (mode === "weights" ? weightColumns() : boardColumns(width, teams.length > 0)),
    [mode, teams.length, width],
  );

  const renderBoardCell = useCallback((item: BoardItem, column: BoardColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    if (item.kind === "header") return { text: "" };
    if (item.kind === "untracked") {
      if (column.id === "title") return { text: item.row.symbol, color: selectedColor ?? colors.text, attributes: TextAttributes.BOLD };
      if (column.id === "name") return { text: item.row.name ?? "", color: selectedColor ?? colors.textDim };
      if (column.id === "health") return { text: item.row.held ? "no thesis" : "watching", color: selectedColor ?? colors.textDim };
      if (column.id === "weight") return { text: item.row.weight > 0 ? pct(item.row.weight) : "", color: selectedColor ?? colors.textDim };
      return { text: "" };
    }
    const { thesis } = item;
    const reason = attentionReason(thesis);
    switch (column.id) {
      case "title":
        return { text: thesis.title, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "name":
        return { text: item.names, color: selectedColor ?? colors.textDim };
      case "health": {
        const color = thesis.health === "broken" ? colors.negative : thesis.health === "weakening" ? colors.warning : thesis.health === "intact" ? colors.positive : colors.textDim;
        return { text: thesis.status === "closed" ? (thesis.outcome?.verdict ?? "closed") : healthLabel(thesis.health).toLowerCase(), color: selectedColor ?? color };
      }
      case "conviction":
        return { text: String(thesis.conviction), color: selectedColor ?? colors.text };
      case "signals":
        return { text: thesis.openSignals ? String(thesis.openSignals) : "", color: selectedColor ?? colors.warning, attributes: thesis.openSignals ? TextAttributes.BOLD : undefined };
      case "weight": {
        const entry = exposureById.get(thesis.id);
        const text = !entry || thesis.status === "watching" || (entry.missingQuotes && entry.value === 0)
          ? ""
          : entry.weight > 0 ? `${pct(entry.weight)}${entry.hasOptions ? "*" : ""}` : "0%";
        return { text, color: selectedColor ?? colors.text };
      }
      case "reviewed":
        return { text: relative(thesis.reviewedAt), color: selectedColor ?? (reason === "review" ? colors.warning : colors.textDim) };
      case "catalyst": {
        const next = nextCatalyst(thesis.document);
        const days = next?.date ? daysUntil(next.date) : null;
        const text = reason && reason !== "review" && thesis.status !== "closed"
          ? describeAttention(reason, thesis)
          : next ? `${next.text} ${days !== null ? describeDays(days) : ""}`.trim() : "";
        const color = reason === "signals" || reason === "broken" ? colors.negative : reason === "weakening" || reason === "catalyst" ? colors.warning : days !== null && days <= 14 ? colors.warning : colors.textDim;
        return { text, color: selectedColor ?? color };
      }
      case "owner": {
        const team = thesis.owner.kind === "team" ? teamStore.getTeam(thesis.owner.id) : null;
        return { text: team ? team.shortName ?? team.name : "", color: selectedColor ?? colors.textDim };
      }
      default:
        return { text: "" };
    }
  }, [exposureById]);

  const renderWeightCell = useCallback((row: ReturnType<typeof convictionRows>[number], column: BoardColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "title":
        return { text: row.thesis.title, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "conviction":
        return { text: String(row.conviction), color: selectedColor ?? colors.text };
      case "weight":
        return { text: `${pct(row.weight)}${row.hasOptions ? "*" : ""}`, color: selectedColor ?? colors.text };
      case "value":
        return { text: formatCompactCurrency(row.value, exposure.baseCurrency), color: selectedColor ?? colors.textDim };
      case "gap": {
        const text = row.gap > 0 ? "under-sized" : row.gap < 0 ? "grew big" : "in line";
        const color = row.gap > 0 ? colors.warning : row.gap < 0 ? colors.negative : colors.textDim;
        return { text: row.gap === 0 ? text : `${text} (${row.gap > 0 ? "+" : ""}${row.gap})`, color: selectedColor ?? color };
      }
      default:
        return { text: "" };
    }
  }, [exposure.baseCurrency]);

  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    const segments: PaneFooterSegment[] = [];
    if (snapshot.loading) segments.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (snapshot.offline) segments.push({ id: "offline", parts: [{ text: "offline copy", tone: "warning" }] });
    if (snapshot.error && !snapshot.offline) segments.push({ id: "error", parts: [{ text: snapshot.error, tone: "warning" }] });
    if (exposure.bookValue > 0 && snapshot.theses.length > 0) {
      segments.push({
        id: "risk",
        parts: [
          { text: "at risk", tone: "label" },
          { text: pct(atRisk), tone: atRisk >= 0.25 ? "negative" : atRisk > 0 ? "warning" : "muted" },
        ],
        title: "Share of the book on weakening or broken theses",
      });
    }
    if (exposures.some((entry) => entry.hasOptions)) {
      segments.push({ id: "options", parts: [{ text: "* includes option premium", tone: "muted" }] });
    }
    return segments;
  }, [atRisk, exposure.bookValue, exposures, snapshot.error, snapshot.loading, snapshot.offline, snapshot.theses.length]);

  // Scope and view are in the query bar; p and w stay as their shortcuts.
  const selectedUntracked = mode === "board"
    ? boardItems.find((item): item is Extract<BoardItem, { kind: "untracked" }> => item.kind === "untracked" && item.id === selectedId)
    : undefined;
  const hints = useMemo<PaneHint[]>(() => [
    ...(mode === "board" ? [{ id: "search", key: "/", label: "search", onPress: focusSearch }] : []),
    { id: "new", key: "n", label: "ew", onPress: () => void startFor() },
    ...(selectedUntracked
      ? [{ id: "start", key: "Enter", label: " start thesis", onPress: () => void startFor(selectedUntracked.row.symbol) }]
      : []),
  ], [focusSearch, selectedUntracked, startFor]);

  usePaneFooter("thesis-board", () => (openId || !signedIn ? null : { info: footerInfo, hints }), [footerInfo, hints, openId, signedIn]);

  const handleDetailKeyDown = useCallback((_event: DataTableKeyEvent) => false, []);

  if (!signedIn) {
    return <SignInWall action="keep investment theses" hint="Theses are stored in Gloom Cloud so they follow you and your team." />;
  }
  if (!snapshot.loaded && snapshot.theses.length === 0) {
    return <PaneStatusBody loading={snapshot.loading} error={snapshot.error} subject="Theses" />;
  }

  const detail = openThesis ? (
    <ThesisDetail
      thesis={openThesis}
      width={width}
      height={height - 1}
      focused={focused}
      footerId="thesis-board-detail"
      onDeleted={() => setOpenId(null)}
    />
  ) : <Box flexGrow={1} />;

  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "ticker or company",
        focused: focused && !openThesis,
        active: searchFocused,
        onActiveChange: (active) => (active ? focusSearch() : blurSearch()),
        focusToken: searchFocusToken,
        inputRef: searchInputRef,
        debounceMs: 80,
        onNavigateDown: blurSearch,
      }}
      filters={[{
        id: "scope",
        label: "Portfolio",
        value: exposure.scope.collectionId ?? ALL_SCOPE,
        defaultValue: ALL_SCOPE,
        options: exposure.scopes.map((entry) => ({ value: entry.collectionId ?? ALL_SCOPE, label: entry.label })),
        onChange: (value: string) => setScopeId(value === ALL_SCOPE ? null : value),
      }]}
      view={{
        value: mode,
        options: [
          { value: "board", label: "Board" },
          { value: "weights", label: "Weights" },
        ],
        onChange: (value: "board" | "weights") => setMode(value),
      }}
    />
  );

  if (mode === "weights") {
    return (
      <DataTableStackView<ReturnType<typeof convictionRows>[number], BoardColumn>
        focused={focused}
        detailOpen={!!openThesis}
        onBack={() => setOpenId(null)}
        detailContent={detail}
        detailTitle={openThesis?.title}
        onDetailKeyDown={handleDetailKeyDown}
        selection={{ kind: "id", selectedId, getId: (row) => row.thesis.id, onChange: (id) => setSelectedId(id) }}
        onActivate={(row) => setOpenId(row.thesis.id)}
        rootWidth={width}
        rootHeight={height}
        rootBefore={queryBar}
        columns={columns}
        items={weightItems}
        sortColumnId={null}
        sortDirection="desc"
        getItemKey={(row) => row.thesis.id}
        renderCell={renderWeightCell}
        emptyStateTitle={query ? "Nothing matches." : "No active thesis with a position."}
        emptyStateHint={query ? undefined : "Conviction is compared with weight once a thesis holds something."}
        showHorizontalScrollbar={false}
      />
    );
  }

  return (
    <DataTableStackView<BoardItem, BoardColumn>
      focused={focused}
      detailOpen={!!openThesis}
      onBack={() => setOpenId(null)}
      detailContent={detail}
      detailTitle={openThesis?.title}
      onDetailKeyDown={handleDetailKeyDown}
      selection={{ kind: "id", selectedId, getId: (item) => item.id, onChange: (id) => setSelectedId(id) }}
      onActivate={activate}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={boardItems}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={(item) => item.id}
      renderCell={renderBoardCell}
      isNavigable={(item) => item.kind !== "header"}
      renderSectionHeader={(item) => (item.kind === "header"
        ? { text: item.group === "untracked" ? "Positions without a thesis" : groupLabel(item.group), color: colors.textDim, attributes: TextAttributes.BOLD }
        : null)}
      emptyStateTitle={query ? "Nothing matches." : "No theses yet."}
      emptyStateHint={query ? undefined : "Start one here or from a ticker's Thesis tab."}
      showHorizontalScrollbar={false}
    />
  );
}
