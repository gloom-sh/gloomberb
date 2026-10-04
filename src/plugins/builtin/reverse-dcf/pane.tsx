import { useCallback, useEffect, useMemo, useRef } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { formatCompactCurrency } from "../../../utils/format";
import { loadReverseDcfInputs } from "./client";
import { DISCOUNT_RATES, FORECAST_YEARS, projectReverseDcf, TERMINAL_GROWTH, TERMINAL_GROWTHS, type ImpliedGrowth, type ReverseDcfModel } from "./model";

export const DISCOUNT_OPTIONS = DISCOUNT_RATES.map((rate) => ({ value: String(Math.round(rate * 100)), label: `${Math.round(rate * 100)}%` }));

function pct(value: number | null | undefined, signed = true): string {
  if (value == null) return "--";
  const fixed = (value * 100).toFixed(1);
  return /[1-9]/.test(fixed) ? `${signed && value > 0 ? "+" : ""}${fixed}%` : "0.0%";
}

function impliedText(value: ImpliedGrowth | null): string {
  if (!value) return "--";
  if (value.kind === "below") return "< -50%";
  if (value.kind === "above") return "> +100%";
  return pct(value.value);
}

type Row = ReverseDcfModel["sensitivity"][number];

const COLUMNS: DataTableColumn[] = [
  { id: "discount", label: "Discount", width: 10, align: "left" },
  ...TERMINAL_GROWTHS.map((terminal, index) => ({ id: `t${index}`, label: `Terminal ${pct(terminal, false)}`, width: 14, align: "right" as const })),
];

function renderCell(row: Row, column: DataTableColumn): DataTableCell {
  if (column.id === "discount") return { text: pct(row.discountRate, false) };
  const value = row.implied[Number(column.id.slice(1))] ?? null;
  return { text: impliedText(value), value: value?.kind === "rate" ? value.value * 100 : null };
}

export function ReverseDcfPane({ width, height, focused }: PaneProps) {
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const [discount, setDiscount] = usePaneSettingValue("discountRate", "9");
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const snapshot = await loadReverseDcfInputs({ instrument: instrument!, forceRefresh: force, signal: controller.current.signal });
    if (!snapshot.financials && snapshot.error) throw new Error(snapshot.error);
    return snapshot;
  }, [instrumentKey]);
  const inputs = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(inputs.updatedAt, inputs.load);
  usePaneRefreshKey(() => { void inputs.reload(); }, { focused });

  const discountRate = (Number(discount) || 9) / 100;
  const model = useMemo(() => inputs.data ? projectReverseDcf(inputs.data.financials, { symbol: symbol ?? "", discountRate }) : null,
    [inputs.data, discountRate, symbol]);

  usePaneNoticeFooter({ registrationId: "reverse-dcf-notices", focused,
    notices: [...new Set([identityError, inputs.error, inputs.data?.error].filter((value): value is string => !!value))] });
  usePaneFooter("reverse-dcf", () => ({ info: [
    ...(inputs.loading ? [{ id: "loading", parts: [{ text: "loading fundamentals", tone: "muted" as const }] }] : []),
    ...(inputs.data?.stale ? [{ id: "stale", parts: [{ text: "stale fundamentals", tone: "warning" as const }] }] : []),
    ...(model?.currency ? [{ id: "units", parts: [{ text: `TTM, ${model.currency}`, tone: "muted" as const }] }] : []),
  ] }), [inputs.loading, inputs.data?.stale, model?.currency]);

  const stats = useMemo((): StatItem[] => {
    if (!model || model.error) return [];
    const currency = model.currency ?? undefined;
    const implied = model.implied?.kind === "rate" ? model.implied.value : null;
    const past = model.pastGrowth;
    return [
      { id: "implied", label: "Priced-in growth", value: impliedText(model.implied),
        tone: implied == null || !past ? undefined : implied > past.rate ? "negative" : "positive",
        detail: `a year for ${FORECAST_YEARS}y, then ${pct(TERMINAL_GROWTH, false)}` },
      { id: "past", label: "Past FCF growth", value: past ? pct(past.rate) : "--", detail: past ? `per year over ${past.years}y` : undefined },
      { id: "yield", label: "FCF yield", value: pct(model.fcfYield, false) },
      { id: "fcf", label: "FCF", value: formatCompactCurrency(model.freeCashFlow ?? undefined, currency) },
      { id: "ev", label: "EV", value: formatCompactCurrency(model.enterpriseValue ?? undefined, currency) },
    ];
  }, [model]);

  const selectedId = String(discountRate);
  const contentHeight = Math.max(4, height - 1 - statGridRows(stats, width));

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[{ id: "discount", label: "Discount", value: String(discount), options: DISCOUNT_OPTIONS, onChange: setDiscount }]} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="reverse DCF" loading={inputs.loading && !model}
      error={!model ? inputs.error ?? identityError ?? null : model.error} empty={false}>
      {model && !model.error ? <>
        <StatGrid items={stats} width={width} />
        <DataTableView<Row> focused={focused} columns={COLUMNS} items={model.sensitivity} rootWidth={width} rootHeight={contentHeight}
          getItemKey={(row) => String(row.discountRate)} emptyStateTitle="No implied growth." sortColumnId={null} sortDirection="desc"
          selection={{ kind: "id", selectedId, getId: (row) => String(row.discountRate),
            onChange: (id) => { if (id) setDiscount(String(Math.round(Number(id) * 100))); } }}
          getExportMetadata={() => [["symbol", model.symbol], ["currency", model.currency ?? ""], ["units", "implied annual FCF growth over 10 years, percent"]]}
          renderCell={renderCell} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
