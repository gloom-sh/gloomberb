import { useCallback, useMemo, useState } from "react";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useFxRatesMap } from "../../../market-data/hooks";
import { resolveEntryData } from "../../../market-data/selectors";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { useAssetData } from "../../runtime";
import { summarizeFxRates, fxStatusLabel } from "../../../utils/fx-status";
import type { PluginModule } from "../plugin-module";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { isStreamCarryingQuote } from "../shared/use-quote-board";
import { fxLegQuoteKey, fxLegTargets, fxLegs, liveFxLegEntry } from "./live-legs";
import { MAJOR_CURRENCIES, formatRate, resolveCurrencies, type MajorCurrency } from "./pairs";
import { createFxExportMetadata } from "./export";

const FX_MATRIX_PANE_ID = "fx-matrix";
/** Stable identity: a fresh literal here would reload the board every render. */
const NO_SAVED_CURRENCIES: string[] = [];
const BASE_COLUMN_WIDTH = 5;
const RATE_COLUMN_WIDTH = 10;
/** Snapshot rates reload at this pace while the feed is not carrying every leg. */
const FX_FALLBACK_REFRESH_MS = 60_000;

function FxMatrixPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
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
  const status = summarizeFxRates(currencies, rates, (currency) => rateEntries.get(currency));
  const statusText = fxStatusLabel(status);
  const snapshotFetchedAt = summarizeFxRates(currencies, snapshotRates, (currency) => (
    getSharedMarketDataCoordinator()?.getFxEntry(currency)
  )).latestFetchedAt;
  // Any newer pair quote may draw a rate, but only a leg the feed keeps
  // current relaxes the snapshot reload: a quote another pane loaded, or one
  // the stream stopped sending, would otherwise freeze the matrix. With
  // streaming off, the legs' own quote poll is the feed.
  const allLegsLive = legs.every((leg) => {
    const entry = legEntries.get(fxLegQuoteKey(leg));
    if (!liveStreaming) return liveEntries.has(leg.currency) && (entry?.fetchedAt ?? 0) >= subscriptionStartedAt;
    return isStreamCarryingQuote(entry, subscriptionStartedAt, freshnessNow);
  });

  const refresh = useCallback(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    for (const currency of currencies) {
      if (currency === "USD") continue;
      void coordinator.loadFxRate(currency, { forceRefresh: true }).catch(() => {});
    }
  }, [currencies]);

  useAutoRefresh(snapshotFetchedAt || null, refresh, { intervalMs: allLegsLive ? null : FX_FALLBACK_REFRESH_MS });

  const columns = useMemo<DataTableColumn[]>(() => [
    { id: "base", label: "", width: BASE_COLUMN_WIDTH, align: "left" },
    ...currencies.map((currency) => ({
      id: currency,
      label: currency,
      width: RATE_COLUMN_WIDTH,
      align: "right" as const,
    })),
  ], [currencies]);

  const renderCell = useCallback((
    row: MajorCurrency,
    column: DataTableColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    if (column.id === "base") {
      return {
        text: row,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    }

    const quoteCurrency = column.id as MajorCurrency;
    const dimmed = selectedColor ?? colors.textDim;
    if (row === quoteCurrency) return { text: formatRate(1, quoteCurrency), color: dimmed };

    const base = rates.get(row);
    const quote = rates.get(quoteCurrency);
    if (base == null || quote == null || !Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
      // A missing leg must never fall back to parity: 1.0000 on EUR/JPY reads
      // as a real rate.
      const pending = status.loading > 0;
      return { text: pending ? "…" : "—", color: dimmed };
    }
    return { text: formatRate(base / quote, quoteCurrency), color: selectedColor ?? colors.text };
  }, [rates, status.loading]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!isPlainKey(event, "r")) return false;
    event.preventDefault?.();
    refresh();
    return true;
  }, [refresh]);

  const updatedAgo = useUpdatedAgo(status.latestFetchedAt || null);

  usePaneFooter(FX_MATRIX_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (status.loading > 0) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (statusText) info.push({ id: "rates", parts: [{ text: statusText, tone: status.stale || status.unknownTime || status.unavailable ? "warning" : "muted" }] });
    if (updatedAgo) info.push({ id: "updated", parts: [{ text: `fetched ${updatedAgo}`, tone: "muted" }] });
    return { info };
  }, [status.loading, statusText, updatedAgo]);

  return (
    <DataTableView<MajorCurrency>
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
      items={dataProvider ? currencies : []}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(row) => row}
      renderCell={renderCell}
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
      settings: (context) => ({
        title: "FX Cross Rates Settings",
        values: {
          currencies: resolveCurrencies(context.settings.currencies as string[] | undefined),
        },
        fields: [{
          key: "currencies",
          label: "Currencies",
          type: "ordered-multi-select",
          options: MAJOR_CURRENCIES.map((currency) => ({ value: currency, label: currency })),
        }],
      }),
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
    },
  ],
};
