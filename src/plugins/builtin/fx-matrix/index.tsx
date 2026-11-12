import { logFailure } from "../../../utils/log-failure";
import { t, tf } from "../../../i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableView,
  QueryBar,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { getTableWidth } from "../../../components/ui/table-layout";
import { createDataTableCsv } from "../../../components/data-table/export";
import { ageFooterSegment, savedCopyFooterSegment } from "../../../components/layout/pane/footer";
import { CountryFlag } from "../../../components/ui/country-flag";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useFxRatesMap } from "../../../market-data/hooks";
import { resolveEntryData } from "../../../market-data/selectors";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { usePaneSettingValue, useUpdatePaneSettings } from "../../../state/app/context";
import { colors, shownPriceColor } from "../../../theme/colors";
import { formatPercentRaw, MISSING_VALUE } from "../../../utils/format";
import type {
  CommandBarResultDef, CommandBarSearchProvider, GloomPluginContext, PaneProps, PaneTemplateContext, PaneTemplateCreateOptions,
  PaneTemplateInstanceConfig,
} from "../../../types/plugin";
import { TextAttributes, useUiCapabilities, type InputRenderable } from "../../../ui";
import { isPaneInLayout } from "../../../layout/pane-manager";
import { useAssetData } from "../../runtime";
import { summarizeFxRates, fxStatusLabel } from "../../../utils/fx-status";
import type { PluginModule } from "../plugin-module";
import { fxRateObservations } from "../shared/fx-rate-freshness";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { fxBoardMoveDay, fxLegMoveReference, fxLegQuoteKey, fxLegReferenceRate, fxLegSavedAt, fxLegTargets, fxLegs, fxLegsBehind, liveFxLegEntry } from "./live-legs";
import { CURRENCY_FLAG_REGIONS, FX_CURRENCIES, formatRate, resolveCurrencies, type FxCurrency } from "./pairs";
import { crossMovePercent, directionTint, nextTintLevel } from "./direction";
import { fxMatrixSettings } from "./settings";
import { createFxExportMetadata } from "./export";
import { fxMatrixHeadless } from "./headless";
import {
  formatAmountFigure, formatFxBoardAmount, parseFxBoardAmount, parseFxBoardAmountEdit, readFxBoardAmount, storedFxBoardAmount, withAmountCurrencies,
  type FxBoardAmount,
} from "./amount";

const FX_MATRIX_PANE_ID = "fx-matrix";
const FX_MATRIX_TEMPLATE_ID = "fx-matrix-pane";
/** Stable identity: a fresh literal here would reload the board every render. */
const NO_SAVED_CURRENCIES: string[] = [];
const BASE_COLUMN_WIDTH = 5;
/** Room for a flag, a space and the code once the desktop draws the flag. */
const FLAGGED_BASE_COLUMN_WIDTH = 6;
const CURRENCY_FLAGS = new Map<string, ReactNode>(
  FX_CURRENCIES.map((currency) => [currency, <CountryFlag region={CURRENCY_FLAG_REGIONS[currency]} />]),
);
const RATE_COLUMN_WIDTH = 10;
/** Room for `-12.34%`; the header takes what it needs. */
const MOVE_COLUMN_WIDTH = 9;
/** The currencies the day's move must fit beside: the eight majors the board opens with. */
const MOVE_FITS_BESIDE = 8;
/** Snapshot rates reload at this pace while the feed is not carrying every leg. */
const FX_FALLBACK_REFRESH_MS = 60_000;

/** Room for `e.g. 2,500,000 EUR`, and for `2,500,000 EUR` and the cursor after it. */
const AMOUNT_FIELD_WIDTH = 18;

/**
 * The amount field: it shows the amount grouped (`5,000 EUR`), and is edited
 * as the board saves it (`5000 EUR`), which reads back as itself where `5,000`
 * would ask which was meant. Typing edits a draft, Enter applies it to the
 * board, and leaving it without Enter puts back the amount the board shows.
 */
function useAmountField(shown: string, edited: string) {
  const [draft, setDraft] = useState(shown);
  const [active, setActiveState] = useState(false);
  const inputRef = useRef<InputRenderable>(null);
  useEffect(() => { if (!active) setDraft(shown); }, [active, shown]);
  const setActive = useCallback((next: boolean) => {
    setActiveState(next);
    if (next) setDraft(edited);
  }, [edited]);
  return { draft, setDraft, active, setActive, inputRef };
}

function FxMatrixPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const flagged = useUiCapabilities().nativePaneChrome === true;
  const [savedCurrencies] = usePaneSettingValue<string[]>("currencies", NO_SAVED_CURRENCIES);
  const currencies = useMemo(() => resolveCurrencies(savedCurrencies), [savedCurrencies]);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);
  // An amount (2,500,000 EUR) is shown in every currency the board lists, at the board's rates.
  const [savedAmount] = usePaneSettingValue<string>("amount", "");
  const updateSettings = useUpdatePaneSettings();
  const typedAmount = useMemo(() => readFxBoardAmount(savedAmount), [savedAmount]);
  const amount: FxBoardAmount | null = typedAmount && !("error" in typedAmount) ? typedAmount : null;
  const amountField = useAmountField(
    amount ? formatFxBoardAmount(amount) : String(savedAmount ?? ""),
    amount ? storedFxBoardAmount(amount) : String(savedAmount ?? ""),
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const applyAmount = useCallback((text: string) => {
    const request = parseFxBoardAmountEdit(text, savedAmount);
    if (request && "error" in request) {
      setAmountError(request.error);
      return;
    }
    setAmountError(null);
    amountField.setActive(false);
    // A currency the board does not list yet joins it, as `fx 100 ZAR/NGN` opens it on ZAR and NGN.
    updateSettings(request
      ? { amount: storedFxBoardAmount(request), currencies: withAmountCurrencies(currencies, request) }
      : { amount: undefined });
  }, [amountField.setActive, currencies, savedAmount, updateSettings]);

  const snapshotRates = useFxRatesMap(currencies);
  // Each non-USD currency streams its USD pair; the 28 crosses derive from
  // those legs. The snapshot rates paint first and cover any leg not streaming.
  const liveStreaming = useLiveStreamingSetting();
  const legs = useMemo(() => fxLegs(currencies), [currencies]);
  const legTargets = useMemo(() => fxLegTargets(legs, selectedCurrency), [legs, selectedCurrency]);
  const {
    entries: legEntries,
    freshnessNow,
    subscriptionStartedAt,
  } = useLiveQuoteEntries(legTargets, { freshnessScopeKey: "fx-matrix", liveStreaming });
  // The day's move reads each pair quote's previous close: the pane reads the quotes once, as `fn FXC` does, so the
  // move is there before a stream sends them, and where none does (signed out, or a capture).
  const legKey = legs.map((leg) => leg.symbol).join(",");
  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || legs.length === 0) return;
    void coordinator.loadQuotesBatch(legs.map((leg) => ({ symbol: leg.symbol, exchange: "" })))
      .catch(logFailure("fx-matrix", "Load FX pair quotes failed"));
  }, [legKey]);
  const liveEntries = useMemo(() => {
    const coordinator = getSharedMarketDataCoordinator();
    return new Map(legs.flatMap((leg) => {
      const entry = liveFxLegEntry(leg, legEntries.get(fxLegQuoteKey(leg)), coordinator?.getFxEntry(leg.currency));
      return entry ? [[leg.currency, entry] as const] : [];
    }));
  }, [legEntries, legs, snapshotRates]);
  const rates = useMemo(() => {
    if (liveEntries.size === 0) return snapshotRates;
    const merged = new Map(snapshotRates);
    for (const [currency, entry] of liveEntries) merged.set(currency, entry.data!);
    return merged;
  }, [liveEntries, snapshotRates]);
  // A cell's decimals are counted at a rate that holds still, the pair's
  // previous close or else the first rate this pane drew, never at the tick.
  // The snapshot rates are no reference: they follow the stream too.
  const firstRates = useRef(new Map<string, number>());
  const referenceRates = useMemo(() => {
    const references = new Map<string, number>([["USD", 1]]);
    for (const leg of legs) {
      const rate = rates.get(leg.currency);
      if (!firstRates.current.has(leg.currency) && rate != null && Number.isFinite(rate) && rate > 0) {
        firstRates.current.set(leg.currency, rate);
      }
      const reference = fxLegReferenceRate(leg, legEntries.get(fxLegQuoteKey(leg))) ?? firstRates.current.get(leg.currency);
      if (reference != null) references.set(leg.currency, reference);
    }
    return references;
  }, [legEntries, legs, rates]);
  // A cell's direction is its cross against the pairs' previous daily closes,
  // USD (the base) as 1: each leg's pair quote's close, whether the rate drawn
  // is that quote's or a snapshot rate of the same FX trading day
  // (fxLegMoveReference). The first rate this pane drew is no daily reference,
  // and a stale quote has no close to read against.
  const directionReferences = useMemo(() => {
    const coordinator = getSharedMarketDataCoordinator();
    const references = new Map<string, number>([["USD", 1]]);
    // One close for the board, read off the clock (fxBoardMoveDay): a leg on another day has no move.
    const boardDay = fxBoardMoveDay(legs.map((leg) => legEntries.get(fxLegQuoteKey(leg))), Date.now());
    for (const leg of legs) {
      const drawn = liveEntries.get(leg.currency) ?? coordinator?.getFxEntry(leg.currency);
      const reference = fxLegMoveReference(leg, legEntries.get(fxLegQuoteKey(leg)), drawn, boardDay);
      if (reference) references.set(leg.currency, reference.rate);
    }
    return references;
  }, [legEntries, legs, liveEntries, snapshotRates]);
  // The step each cell showed last, which a tick near a boundary keeps.
  const tintLevels = useRef(new Map<string, number>());
  // Export the provenance of this render's rates, even if a provider response
  // arrives before React commits the next render and the user exports now.
  const rateEntries = new Map(currencies.map((currency) => {
    const live = liveEntries.get(currency);
    if (live) return [currency as string, live] as const;
    const entry = getSharedMarketDataCoordinator()?.getFxEntry(currency);
    return [currency as string, entry && resolveEntryData(entry) === (rates.get(currency) ?? null)
      ? { ...entry, error: entry.error ? { ...entry.error } : null }
      : undefined] as const;
  }));
  // A report or capture of the board is dated by the rates it draws: when each
  // was observed, whether it is delayed or stale, and where the FX market
  // stands. The pane draws none of this; its footer keeps its own status.
  useRemoteUiNode({
    role: "report-freshness",
    label: "Rate freshness",
    getMetadata: () => {
      const legQuotes = new Map(legs.map((leg) => [leg.currency, resolveEntryData(legEntries.get(fxLegQuoteKey(leg)))] as const));
      return {
        observations: fxRateObservations(currencies, rates, (currency) => ({
          entry: rateEntries.get(currency),
          // Only a rate that is the pair quote's own says what that quote says.
          legQuote: liveEntries.has(currency) ? legQuotes.get(currency) : null,
        })),
      };
    },
  });
  const status = summarizeFxRates(currencies, rates, (currency) => rateEntries.get(currency));
  const statusText = fxStatusLabel(status);
  // Offline, the rates drawn are the copies saved when they last refreshed: the footer says when, as other panes do.
  const savedAt = legs.reduce<number | null>((oldest, leg) => {
    const at = fxLegSavedAt(
      liveEntries.has(leg.currency) ? resolveEntryData(legEntries.get(fxLegQuoteKey(leg))) : null,
      rateEntries.get(leg.currency),
    );
    return at == null ? oldest : Math.min(oldest ?? at, at);
  }, null);
  const snapshotFetchedAt = summarizeFxRates(currencies, snapshotRates, (currency) => (
    getSharedMarketDataCoordinator()?.getFxEntry(currency)
  )).latestFetchedAt;
  // Any newer pair quote may draw a rate, but only a leg the feed keeps
  // current relaxes the snapshot reload: a quote another pane loaded, or one
  // the stream stopped sending, would otherwise freeze the matrix. With
  // streaming off, the legs' own quote poll is the feed.
  const legsBehind = fxLegsBehind(legs, legEntries, {
    liveStreaming,
    liveCurrencies: new Set(liveEntries.keys()),
    startedAt: subscriptionStartedAt,
    now: freshnessNow,
  });
  const allLegsLive = legsBehind.length === 0;

  const reload = useCallback((codes: readonly string[]) => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    for (const currency of codes) {
      if (currency === "USD") continue;
      void coordinator.loadFxRate(currency, { forceRefresh: true }).catch(logFailure("fx-matrix", "Refresh FX rate failed"));
    }
  }, []);
  const refresh = useCallback(() => reload(currencies), [currencies, reload]);

  // The reload that stands in for the feed asks only for the legs it is
  // behind on: a thin pair that rarely ticks must not make every selected
  // currency reload each minute.
  useAutoRefresh(snapshotFetchedAt || null, () => reload(allLegsLive ? currencies : legsBehind), {
    intervalMs: allLegsLive ? null : FX_FALLBACK_REFRESH_MS,
  });

  // The amount in each row's currency, at the cross the row reads against the amount's currency.
  const convertedAmount = useCallback((row: string): number | null => {
    if (!amount) return null;
    if (row === amount.currency) return amount.amount;
    const from = rates.get(amount.currency);
    const to = rates.get(row);
    if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
    return amount.amount * (from / to);
  }, [amount, rates]);
  // As wide as its widest figure, so a pane scrolls to the rates beside it instead of cutting one. The field
  // above says what amount it is.
  const amountWidth = amount ? Math.max(RATE_COLUMN_WIDTH, ...currencies.map((currency) => {
    const value = convertedAmount(currency);
    return value == null ? 1 : formatAmountFigure(value, currency).length;
  })) : 0;
  // Each currency's value in dollars, its move on the day: the row currency against the dollar, so JPY -0.51% is the
  // yen 0.51% weaker (USD/JPY up), read from its dollar pair against that pair's previous daily close (the references
  // the cells' tints read). The dollar is the reference, so it has none.
  const moveVsUsd = useCallback((row: string): number | null => {
    if (row === "USD") return null;
    const rate = rates.get(row);
    const reference = directionReferences.get(row);
    return rate == null || reference == null || !Number.isFinite(rate) || rate <= 0 ? null : crossMovePercent(rate, reference, 1, 1);
  }, [directionReferences, rates]);
  // The move is shown where it fits beside the first eight currencies; a pane with no room for both (a board saved
  // at its old width) shows the currencies as it did, and one too narrow for them scrolls to the rest.
  const allColumns = useMemo<DataTableColumn[]>(() => {
    const columns: DataTableColumn[] = [
      { id: "base", label: "", width: flagged ? FLAGGED_BASE_COLUMN_WIDTH : BASE_COLUMN_WIDTH, align: "left" },
      ...amount ? [{ id: "amount", label: "Amount", width: amountWidth, align: "right" as const }] : [],
      { id: "move", label: "1D in USD", width: MOVE_COLUMN_WIDTH, align: "right",
        title: "Each currency's value in US dollars, its move since its dollar pair's previous daily close: JPY -0.51% is the yen 0.51% weaker against the dollar" },
      ...currencies.map((currency) => ({
        id: currency,
        label: currency,
        width: RATE_COLUMN_WIDTH,
        align: "right" as const,
        headerLeading: flagged ? CURRENCY_FLAGS.get(currency) : undefined,
      })),
    ];
    const throughEighth = columns.slice(0, columns.length - Math.max(0, currencies.length - MOVE_FITS_BESIDE));
    return getTableWidth(throughEighth) <= width - 1 ? columns : columns.filter((column) => column.id !== "move");
  }, [amount != null, amountWidth, currencies, flagged, width]);

  const renderCell = useCallback((
    row: FxCurrency,
    column: DataTableColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    if (column.id === "base") {
      return {
        text: row,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
        leading: flagged ? CURRENCY_FLAGS.get(row) : undefined,
      };
    }

    if (column.id === "move") {
      const move = moveVsUsd(row);
      if (move == null) return { text: row !== "USD" && status.loading > 0 ? "…" : MISSING_VALUE, color: colors.textDim };
      return { text: formatPercentRaw(move), value: move, color: shownPriceColor(move, 2) };
    }

    if (column.id === "amount") {
      const value = convertedAmount(row);
      if (value == null) return { text: status.loading > 0 ? "…" : MISSING_VALUE, color: colors.textDim };
      return { text: formatAmountFigure(value, row), value, color: row === amount?.currency ? colors.textDim : colors.text };
    }

    const quoteCurrency = column.id as FxCurrency;
    if (row === quoteCurrency) return { text: formatRate(1, quoteCurrency), color: colors.textDim };

    const base = rates.get(row);
    const quote = rates.get(quoteCurrency);
    if (base == null || quote == null || !Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
      // A missing leg must never fall back to parity: 1.0000 on EUR/JPY reads
      // as a real rate.
      const pending = status.loading > 0;
      return { text: pending ? "…" : MISSING_VALUE, color: colors.textDim };
    }
    const reference = (referenceRates.get(row) ?? base) / (referenceRates.get(quoteCurrency) ?? quote);
    const rowReference = directionReferences.get(row);
    const columnReference = directionReferences.get(quoteCurrency);
    const level = nextTintLevel(
      tintLevels.current,
      `${row}/${quoteCurrency}`,
      rowReference != null && columnReference != null
        ? crossMovePercent(base, rowReference, quote, columnReference)
        : null,
    );
    // The cursor row keeps its selection colours; the tint leans on them.
    const backgroundColor = rowState.selected
      ? directionTint(level, { background: colors.selected, text: colors.selectedText })
      : directionTint(level, { background: colors.bg, text: colors.text });
    return { text: formatRate(base / quote, quoteCurrency, reference), color: colors.text, backgroundColor };
  }, [amount?.currency, convertedAmount, directionReferences, flagged, moveVsUsd, rates, referenceRates, status.loading]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, refresh), [refresh]);

  const updatedAgo = useUpdatedAgo(status.latestFetchedAt || null);

  usePaneFooter(FX_MATRIX_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    // An amount the board cannot read: the one typed, else the one saved.
    const unreadAmount = amountError ?? (typedAmount && "error" in typedAmount ? typedAmount.error : null);
    if (unreadAmount) info.push({ id: "amount", parts: [{ text: unreadAmount, tone: "warning" }] });
    if (status.loading > 0) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (statusText) info.push({ id: "rates", parts: [{ text: statusText, tone: status.stale || status.unknownTime || status.unavailable ? "warning" : "muted" }] });
    // Every cross is read through each currency's dollar pair, the amount column too; `fx` reads a pair's own quote.
    info.push({ id: "cross", parts: [{ text: "via USD", tone: "muted" }] });
    if (savedAt != null) info.push(savedCopyFooterSegment("updated", savedAt));
    else if (updatedAgo) info.push(ageFooterSegment(updatedAgo, { verb: "fetched" }));
    return { info };
  }, [amountError, savedAt, status.loading, statusText, typedAmount, updatedAgo]);

  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        // Read as an example, not a value, even where a narrow pane cuts it.
        id: "amount", kind: "text", label: "Amount", value: amountField.draft, placeholder: "e.g. 2,500,000 EUR",
        width: AMOUNT_FIELD_WIDTH, debounceMs: 0, focused, active: amountField.active, inputRef: amountField.inputRef,
        // An amount the board could not read stays in the footer, the field back on the board's, until the next edit.
        onActiveChange: amountField.setActive,
        // Typing edits the draft and Enter applies it; clearing the chip (outside the field) clears the amount.
        onChange: (value: string) => {
          amountField.setDraft(value);
          if (amountField.active) setAmountError(null);
          else if (!value.trim() && savedAmount) applyAmount("");
        },
        onSubmit: applyAmount,
      }]}
    />
  );

  return (
    <DataTableView<FxCurrency>
      focused={focused}
      selection={{
        kind: "id",
        selectedId: selectedCurrency ?? currencies[0] ?? null,
        getId: (row) => row,
        onChange: (id) => setSelectedCurrency(id),
      }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      // A new amount brings its column, the first after the codes, into view.
      resetScrollKey={amount ? storedFxBoardAmount(amount) : ""}
      // A pane too narrow for every currency scrolls to the rest, as other wide tables do; the row's code stays.
      columns={allColumns}
      // Each column is a row's currency in the same order: the matrix reads across and down alike.
      columnReorder={false}
      freezeFirstColumn
      getExportMetadata={() => createFxExportMetadata(currencies, rates,
        (currency) => rateEntries.get(currency))}
      exportCsv={() => createDataTableCsv({ columns: allColumns, items: dataProvider ? currencies : [], renderCell,
        getExportMetadata: () => createFxExportMetadata(currencies, rates, (currency) => rateEntries.get(currency)) })}
      items={dataProvider ? currencies : []}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(row) => row}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      onRootKeyDown={handleKeyDown}
      emptyStateTitle="No market data provider connected."
    />
  );
}

/** The board an amount opens on: the focused one, else the one in front, else none and a new one opens. */
function openFxBoard(context: PaneTemplateContext) {
  const boards = context.layout.instances.filter((instance) => (
    instance.paneId === FX_MATRIX_PANE_ID && isPaneInLayout(context.layout, instance.instanceId)
  ));
  const focused = boards.find((instance) => instance.instanceId === context.focusedPaneId);
  if (focused) return focused;
  // A floating pane without a stacking order sits at the default of 50; docked panes sit below every one.
  const zIndexOf = (instanceId: string) => {
    const entry = context.layout.floating.find((floating) => floating.instanceId === instanceId);
    return entry ? entry.zIndex ?? 50 : -1;
  };
  return [...boards].sort((left, right) => zIndexOf(right.instanceId) - zIndexOf(left.instanceId))[0] ?? null;
}

/**
 * `FXC 2,500,000 EUR`, `fx 2500000 EUR/USD`, `convert 100 eur to usd`: the
 * board open already takes the amount (one board, switched in place), with
 * the currencies it names added when it does not list them; with none open a
 * board opens on it. Without an amount the board opens as it is.
 */
function createFxBoardInstance(context: PaneTemplateContext, options?: PaneTemplateCreateOptions): PaneTemplateInstanceConfig {
  const request = parseFxBoardAmount(options?.arg ?? "");
  if (!request || "error" in request) return {};
  const open = openFxBoard(context);
  return {
    ...(open ? { instanceId: open.instanceId } : {}),
    settings: {
      amount: storedFxBoardAmount(request),
      currencies: withAmountCurrencies(resolveCurrencies(open?.settings?.currencies), request),
    },
  };
}

/** The words a conversion is asked with in the command bar: `fx 2500000 EUR/USD`, `convert 100 eur to usd`. */
const CONVERT_WORDS = /^(?:fx|convert|converter|conversion)\s+(.+)$/i;
/** The converter asked for by name, with no amount yet. */
const CONVERTER_WORDS = /^(?:convert|converter|currency converter)$/i;

/**
 * The command bar's conversions: `fx 2500000 EUR/USD`, `convert 100 eur to
 * usd` and `converter 2,500,000 EUR` open the board on the amount (FXC takes
 * it as its argument too), and `convert` or `converter` alone opens the
 * board to type one. Only a figure is an amount: `fx EUR`, `fx usd/jpy`,
 * `convert yen` and `fx forwards` are left to the bar's own search.
 */
export function fxConvertRows(query: string, open: (options: PaneTemplateCreateOptions) => void): CommandBarResultDef[] {
  if (CONVERTER_WORDS.test(query.trim())) {
    return [{
      id: "convert", label: t("Convert an amount"), detail: t("In every currency on FX Cross Rates"), right: "FXC",
      keywords: ["fx", "convert", "converter"], execute: () => open({}),
    }];
  }
  const arg = CONVERT_WORDS.exec(query.trim())?.[1];
  const request = arg && /\d/.test(arg) ? parseFxBoardAmount(arg) : null;
  if (!arg || !request || "error" in request) return [];
  const amount = formatFxBoardAmount(request);
  return [{
    id: `convert:${amount}`,
    label: request.to ? tf("Convert {amount} to {currency}", { amount, currency: request.to }) : tf("Convert {amount}", { amount }),
    detail: t("In every currency on FX Cross Rates"),
    right: "FXC",
    keywords: ["fx", "convert", "converter"],
    execute: () => open({ arg }),
  }];
}

function createFxConvertSearchProvider(ctx: Pick<GloomPluginContext, "createPaneFromTemplate">): CommandBarSearchProvider {
  const match = (query: string) => fxConvertRows(query, (options) => ctx.createPaneFromTemplate(FX_MATRIX_TEMPLATE_ID, options));
  return { id: "fx-convert", category: "Convert", minQueryLength: 0, match, provide: async (query) => match(query) };
}

export const fxMatrixModule: PluginModule = {
  setup(ctx) {
    ctx.registerCommandBarSearchProvider(createFxConvertSearchProvider(ctx));
  },

  panes: [
    {
      id: FX_MATRIX_PANE_ID,
      name: "FX Cross Rates",
      icon: "F",
      component: FxMatrixPane,
      defaultPosition: "right",
      defaultMode: "floating",
      // Room for the eight majors after the codes and the day's move in dollars; narrower, the move gives way.
      defaultFloatingSize: { width: 115, height: 14 },
      tableExport: true,
      settings: fxMatrixSettings,
    },
  ],

  paneTemplates: [
    {
      id: FX_MATRIX_TEMPLATE_ID,
      paneId: FX_MATRIX_PANE_ID,
      label: "FX Cross Rates",
      description: "Currency cross-rate matrix for major FX pairs, and an amount converted into each currency.",
      keywords: ["fx", "forex", "currency", "exchange", "rates", "cross", "matrix", "convert", "converter", "conversion", "calculator"],
      // `FXC 2,500,000 EUR` opens the board on the amount, as `fx 2500000 EUR/USD` converts it (fxConvertRows).
      shortcut: {
        prefix: "FXC",
        argKind: "text",
        argPlaceholder: "amount",
        argOptional: true,
        openWithoutArg: true,
        argError: (arg) => {
          const request = parseFxBoardAmount(arg);
          return request && "error" in request ? { message: `${arg.trim()} is no amount to convert`, detail: request.error.replace(/\.$/, "") } : null;
        },
      },
      createInstance: createFxBoardInstance,
      headless: fxMatrixHeadless,
    },
  ],
};
