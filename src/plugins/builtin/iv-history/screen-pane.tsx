import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, PaneStatusBody, usePaneFooter, usePaneNoticeFooter, type DataTableColumn, type DataTableKeyEvent } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneCollection, usePaneSettingValue, usePluginAppActions, useTickers } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadIvScreen, loadRealizedVolatilities } from "./client";
import { formatPoints, formatRank, formatVol, shortDate, verdictLabel } from "./format";
import { projectRichCheap, type RichCheapRow, sharedReading, VCA_LIMIT, VCA_PRESETS, type VcaPreset } from "./model";
import { vcaUniverse } from "./universe";

type SortId = keyof RichCheapRow;
const HV_WINDOW = 20;
const COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "Symbol", width: 8, align: "left" },
  { id: "iv30", label: "IV30", width: 7, align: "right" },
  { id: "date", label: "As of", width: 11, align: "right" },
  { id: "rank", label: "IVR", width: 5, align: "right" },
  { id: "percentile", label: "IVP", width: 5, align: "right" },
  { id: "verdict", label: "Rich/Cheap", width: 11, align: "left" },
  { id: "termSlope", label: "30-90", width: 7, align: "right" },
  { id: "skew", label: "25D skew", width: 9, align: "right" },
  { id: "hv", label: `HV${HV_WINDOW}`, width: 7, align: "right" },
  { id: "ivHv", label: "IV/HV", width: 6, align: "right" },
];

export function IvScreenPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const [scope] = usePaneSettingValue("scope", "etfs");
  const [symbolsText] = usePaneSettingValue("symbols", "");
  const { collectionId } = usePaneCollection();
  const tickers = useTickers();
  const { createPaneFromTemplate } = usePluginAppActions();
  const universe = useMemo(() => vcaUniverse(scope, symbolsText, collectionId, Object.values(tickers)), [scope, symbolsText, collectionId, tickers]);
  const key = universe.instruments.map((instrument) => instrument.symbol).join(",");
  const controller = useRef<AbortController | null>(null);
  const [hv, setHv] = useState<Map<string, number | null>>(new Map());
  const loader = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const payload = await loadIvScreen(universe.instruments.map((instrument) => instrument.symbol), { signal: current.signal });
    setHv(new Map());
    void loadRealizedVolatilities(universe.instruments, HV_WINDOW, { signal: current.signal,
      onValue: (symbol, value) => { if (!current.signal.aborted) setHv((previous) => new Map(previous).set(symbol, value)); } });
    return payload;
  }, [key]);
  const resource = useAsyncResource(universe.instruments.length ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const [sort, setSort] = useState<{ id: SortId; direction: "asc" | "desc" }>({ id: "percentile", direction: "desc" });
  const rows = useMemo(() => {
    const projected = projectRichCheap(resource.data?.rows ?? [], hv);
    return projected.sort((left, right) => {
      const a = left[sort.id], b = right[sort.id];
      if (a == null || b == null) return a == null ? b == null ? 0 : 1 : -1;
      const order = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      return sort.direction === "asc" ? order : -order;
    });
  }, [resource.data, hv, sort]);
  const shared = useMemo(() => sharedReading(rows), [rows]);
  // A shared reading date moves to the footer, and a column no row fills is left out.
  const columns = useMemo(() => COLUMNS.filter((column) => !(column.id === "date" && shared)
    && !(column.id === "skew" && rows.every((row) => row.skew == null))), [rows, shared]);
  const [selected, setSelected] = useState<string | null>(null);
  const queued = rows.filter((row) => row.status === "queued").length;
  const notices = [universe.error, resource.error,
    ...(queued ? [`${queued} symbol${queued === 1 ? "" : "s"} queued for implied volatility history; they fill in after backfill.`] : [])]
    .filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "iv-screen-notices", notices, focused });
  const openHistory = (row: RichCheapRow) => createPaneFromTemplate("iv-history-pane", { symbol: row.symbol });
  usePaneFooter("iv-screen", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    { id: "count", parts: [{ text: `${rows.filter((row) => row.iv30 != null).length} of ${rows.length} covered`, tone: "muted" as const }] },
    ...(shared ? [{ id: "date", parts: [{ text: readingLabel(shared.date, shared.method), tone: "muted" as const }] }]
      : resource.data?.asOf ? [{ id: "date", parts: [{ text: resource.data.asOf, tone: "muted" as const }] }] : []),
  ], hints: [{ id: "open", key: "enter", label: "IV history" }] }), [resource.loading, rows, shared, resource.data?.asOf]);
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.alt || event.meta || event.name !== "r") return false;
    void resource.reload();
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  const cell = (row: RichCheapRow, id: string): { text: string; color?: string } => {
    switch (id) {
      case "symbol": return { text: row.symbol, color: colors.textBright };
      case "iv30": return { text: formatVol(row.iv30), color: colors.warning };
      case "date": return { text: row.date ? readingLabel(row.date, row.method) : row.status === "queued" ? "queued" : "--",
        color: colors.textDim };
      case "rank": return { text: formatRank(row.rank) };
      case "percentile": return { text: formatRank(row.percentile) };
      case "verdict": return { text: verdictLabel(row.verdict), color: row.verdict === "rich" ? colors.negative : row.verdict === "cheap" ? colors.positive : colors.textDim };
      case "termSlope": return { text: formatPoints(row.termSlope), color: row.termSlope != null && row.termSlope > 0 ? colors.negative : colors.text };
      case "skew": return { text: formatPoints(row.skew) };
      case "hv": return { text: hv.has(row.symbol) ? formatVol(row.hv) : "...", color: colors.positive };
      case "ivHv": return { text: row.ivHv == null ? "--" : row.ivHv.toFixed(2) };
      default: return { text: "" };
    }
  };
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <PaneStatusBody subject="volatility rich/cheap" loading={resource.loading && !resource.data} error={universe.error && !universe.instruments.length ? universe.error : !resource.data ? resource.error : null}>
      <DataTableView<RichCheapRow> focused={focused} columns={columns} items={rows} rootWidth={width} rootHeight={height}
        getItemKey={(row) => row.symbol} sortColumnId={sort.id} sortDirection={sort.direction} emptyStateTitle="No symbols to screen."
        onHeaderClick={(id) => setSort({ id: id as SortId, direction: sort.id === id && sort.direction === "desc" ? "asc" : "desc" })}
        selection={{ kind: "id", selectedId: selected ?? rows[0]?.symbol ?? "", getId: (row) => row.symbol, onChange: (id) => setSelected(id) }}
        onActivate={openHistory} onRootKeyDown={handleKey}
        getExportMetadata={() => [["universe", universe.label], ["as of", resource.data?.asOf], ["IV", "30-day ATM, annualized"],
          ["rank window", "prior 52 weeks of trade-close readings"], ["HV", `${HV_WINDOW}-session close-to-close`]]}
        renderCell={(row, column) => cell(row, column.id)} />
    </PaneStatusBody>
  </Box>;
}

function readingLabel(date: string, method: RichCheapRow["method"]): string {
  return `${shortDate(date)} ${method === "quote-mid" ? "live" : "close"}`;
}

export const VCA_SCOPE_OPTIONS = [
  { value: "etfs", label: "Index and sector ETFs" },
  { value: "megacaps", label: "US mega caps" },
  { value: "collection", label: "Linked watchlist or portfolio" },
  { value: "custom", label: "Custom symbols" },
] as const satisfies ReadonlyArray<{ value: VcaPreset | "collection" | "custom"; label: string }>;
export { VCA_LIMIT, VCA_PRESETS };
