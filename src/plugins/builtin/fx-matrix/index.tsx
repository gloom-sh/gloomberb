import { logFailure } from "../../../utils/log-failure";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { createDataTableCsv } from "../../../components/data-table/export";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { ageFooterSegment, savedCopyFooterSegment } from "../../../components/layout/pane/footer";
import { CountryFlag } from "../../../components/ui/country-flag";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useFxRatesMap } from "../../../market-data/hooks";
import { resolveEntryData } from "../../../market-data/selectors";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { TextAttributes, useUiCapabilities } from "../../../ui";
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

const FX_MATRIX_PANE_ID = "fx-matrix";
/** Stable identity: a fresh literal here would reload the board every render. */
const NO_SAVED_CURRENCIES: string[] = [];
const BASE_COLUMN_WIDTH = 5;
/** Room for a flag, a space and the code once the desktop draws the flag. */
const FLAGGED_BASE_COLUMN_WIDTH = 6;
const CURRENCY_FLAGS = new Map<string, ReactNode>(
  FX_CURRENCIES.map((currency) => [currency, <CountryFlag region={CURRENCY_FLAG_REGIONS[currency]} />]),
);
const RATE_COLUMN_WIDTH = 10;
/** Snapshot rates reload at this pace while the feed is not carrying every leg. */
const FX_FALLBACK_REFRESH_MS = 60_000;

/**
 * The board's columns for a pane `width` cells wide: whole currency columns
 * give way from the right until the rest fit (`dropColumnsToFit`), the first
 * currency always kept. A board with more rows than `height` holds keeps a
 * cell for its scrollbar.
 */
function fxMatrixColumnsToFit<C extends DataTableColumn>(
  columns: readonly C[], currencies: readonly string[], width: number, height: number,
): C[] {
  const scrollbar = currencies.length + 1 > height ? 1 : 0;
  return dropColumnsToFit(columns, Math.floor(width) - scrollbar, currencies.slice(1).reverse());
}

/** "1 column hidden" in the footer, the codes in its title, for a pane too narrow for every currency. */
export function fxHiddenColumnsSegment(hidden: readonly string[]): PaneFooterSegment {
  const count = hidden.length;
  return {
    id: "hidden-columns",
    // A capture keeps it, as a picture cannot scroll to the columns it left out.
    capture: true,
    title: `${hidden.join(", ")} ${count === 1 ? "is" : "are"} not shown as ${count === 1 ? "a column" : "columns"}: widen the pane`,
    parts: [{ text: `${count} ${count === 1 ? "column" : "columns"} hidden`, tone: "muted" }],
  };
}

function FxMatrixPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const flagged = useUiCapabilities().nativePaneChrome === true;
  const [savedCurrencies] = usePaneSettingValue<string[]>("currencies", NO_SAVED_CURRENCIES);
  const currencies = useMemo(() => resolveCurrencies(savedCurrencies), [savedCurrencies]);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);

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

  const allColumns = useMemo<DataTableColumn[]>(() => [
    { id: "base", label: "", width: flagged ? FLAGGED_BASE_COLUMN_WIDTH : BASE_COLUMN_WIDTH, align: "left" },
    ...currencies.map((currency) => ({
      id: currency,
      label: currency,
      width: RATE_COLUMN_WIDTH,
      align: "right" as const,
      headerLeading: flagged ? CURRENCY_FLAGS.get(currency) : undefined,
    })),
  ], [currencies, flagged]);
  // A pane too narrow for every currency drops whole columns from the right, never cutting a rate at its edge, and
  // the footer says how many (a capture keeps it): each one's rates still read along its row. The first stays.
  const columns = useMemo(() => fxMatrixColumnsToFit(allColumns, currencies, width, height), [allColumns, currencies, height, width]);
  const hiddenCurrencies = currencies.length - (columns.length - 1);

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

    const quoteCurrency = column.id as FxCurrency;
    if (row === quoteCurrency) return { text: formatRate(1), color: colors.textDim };

    const base = rates.get(row);
    const quote = rates.get(quoteCurrency);
    if (base == null || quote == null || !Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
      // A missing leg must never fall back to parity: 1.0000 on EUR/JPY reads
      // as a real rate.
      const pending = status.loading > 0;
      return { text: pending ? "…" : "—", color: colors.textDim };
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
    return { text: formatRate(base / quote, reference), color: colors.text, backgroundColor };
  }, [directionReferences, flagged, rates, referenceRates, status.loading]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, refresh), [refresh]);

  const updatedAgo = useUpdatedAgo(status.latestFetchedAt || null);

  usePaneFooter(FX_MATRIX_PANE_ID, () => {
    const info: PaneFooterSegment[] = hiddenCurrencies > 0 ? [fxHiddenColumnsSegment(currencies.slice(columns.length - 1))] : [];
    if (status.loading > 0) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (statusText) info.push({ id: "rates", parts: [{ text: statusText, tone: status.stale || status.unknownTime || status.unavailable ? "warning" : "muted" }] });
    if (savedAt != null) info.push(savedCopyFooterSegment("updated", savedAt));
    else if (updatedAgo) info.push(ageFooterSegment(updatedAgo, { verb: "fetched" }));
    return { info };
  }, [columns.length, currencies, hiddenCurrencies, savedAt, status.loading, statusText, updatedAgo]);

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
      columns={columns}
      freezeFirstColumn
      getExportMetadata={() => createFxExportMetadata(currencies, rates,
        (currency) => rateEntries.get(currency))}
      // An export carries every currency, the columns a narrow pane leaves out too.
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

export const fxMatrixModule: PluginModule = {
  panes: [
    {
      id: FX_MATRIX_PANE_ID,
      name: "FX Cross Rates",
      icon: "F",
      component: FxMatrixPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 105, height: 14 },
      tableExport: true,
      settings: fxMatrixSettings,
    },
  ],

  paneTemplates: [
    {
      id: "fx-matrix-pane",
      paneId: FX_MATRIX_PANE_ID,
      label: "FX Cross Rates",
      description: "Currency cross-rate matrix for major FX pairs.",
      keywords: ["fx", "forex", "currency", "exchange", "rates", "cross", "matrix"],
      shortcut: { prefix: "FXC" },
      headless: fxMatrixHeadless,
    },
  ],
};
