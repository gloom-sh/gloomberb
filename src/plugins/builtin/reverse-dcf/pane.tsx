import { useCallback, useEffect, useMemo, useRef } from "react";
import { DataTableView, EmptyState, Notice, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter, usePaneNoticeFooter,
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
import { describeFcfMargin, DISCOUNT_RATES, FORECAST_YEARS, formatFcfMargin, pastGrowthBasis, projectReverseDcf, TERMINAL_GROWTH, TERMINAL_GROWTHS,
  ttmBaseGap, type ImpliedGrowth, type MissingInput, type ReverseDcfModel } from "./model";

export const DISCOUNT_OPTIONS = DISCOUNT_RATES.map((rate) => ({ value: String(Math.round(rate * 100)), label: `${Math.round(rate * 100)}%` }));
/** The margin setting that follows the company's own trailing margin, the pane's default. */
const COMPANY_MARGIN = "company";
/** The company's own margin first, then 5% to 60% in steps of 5, the range `--margin` takes. */
export const MARGIN_OPTIONS = [{ value: COMPANY_MARGIN, label: "Company's own" },
  ...Array.from({ length: 12 }, (_, index) => ({ value: String((index + 1) * 5), label: `${(index + 1) * 5}%` }))];

/** `MARGIN_OPTIONS` with the company's own margin named, as the query bar offers it: `55.2% (own)`. */
function marginOptions(model: ReverseDcfModel | null) {
  const { company, gap } = model?.fcfMarginBasis ?? { company: null, gap: null };
  const own = company != null ? `${formatFcfMargin(company)} (own)` : gap ? "Own unavailable" : "Own";
  return MARGIN_OPTIONS.map((option, index) => index === 0 ? { ...option, label: own } : option);
}

// A figure not computed reads as the other missing figures beside it do.
const MISSING = "\u2014";

function pct(value: number | null | undefined, signed = true): string {
  if (value == null) return MISSING;
  const fixed = (value * 100).toFixed(1);
  return /[1-9]/.test(fixed) ? `${signed && value > 0 ? "+" : ""}${fixed}%` : "0.0%";
}

function impliedText(value: ImpliedGrowth | null): string {
  if (!value) return MISSING;
  if (value.kind === "below") return "< -50%";
  if (value.kind === "above") return "> +100%";
  return pct(value.value);
}

type Row = ReverseDcfModel["sensitivity"][number];

const STATEMENT_TAB: Record<MissingInput["statement"], string> = { balance: "Balance Sheet", cashflow: "Cash Flow" };

/**
 * "Not computed: the enterprise value needs total debt on the Jun 30, 2026
 * balance sheet, and the free cash flow a trailing figure. FA: Balance Sheet,
 * Cash Flow.": what the data does not give, said plainly, and where to read
 * what the statements hold.
 */
function missingInputsText(missing: readonly MissingInput[]): string {
  const parts = missing.map((item) => `${item.input === "enterpriseValue" ? "the enterprise value" : "the free cash flow"} needs ${item.needs}`);
  const tabs = [...new Set(missing.map((item) => STATEMENT_TAB[item.statement]))].join(", ");
  return `Not computed: ${parts.join("; ")}. FA: ${tabs}.`;
}

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
  const [margin, setMargin] = usePaneSettingValue("margin", COMPANY_MARGIN);
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
  usePaneRefreshKey(() => { inputs.reload(); }, { focused });

  const discountRate = (Number(discount) || 9) / 100;
  const chosenMargin = Number(margin) > 0 ? Number(margin) / 100 : undefined;
  const model = useMemo(() => inputs.data ? projectReverseDcf(inputs.data.financials, { symbol: symbol ?? "", discountRate, fcfMargin: chosenMargin,
    exchangeResults: inputs.data.exchangeResults }) : null,
    [inputs.data, discountRate, chosenMargin, symbol]);

  usePaneNoticeFooter({ registrationId: "reverse-dcf-notices", focused,
    notices: [...new Set([identityError, inputs.error, inputs.data?.error, model?.enterpriseValueNote, model?.freeCashFlowBasis?.note]
      .filter((value): value is string => !!value))] });
  usePaneFooter("reverse-dcf", () => ({ info: [
    ...(inputs.loading ? [{ id: "loading", parts: [{ text: "loading fundamentals", tone: "muted" as const }] }] : []),
    ...(inputs.data?.stale ? [{ id: "stale", parts: [{ text: "stale fundamentals", tone: "warning" as const }] }] : []),
    ...(model?.currency ? [{ id: "units", parts: [{ text: `TTM, ${model.currency}`, tone: "muted" as const }] }] : []),
  ] }), [inputs.loading, inputs.data?.stale, model?.currency]);

  const stats = useMemo((): StatItem[] => {
    if (!model || model.error) return [];
    const missing = (input: MissingInput["input"]) => model.missing.some((item) => item.input === input) ? "missing" : undefined;
    const currency = model.currency ?? undefined;
    const implied = model.implied?.kind === "rate" ? model.implied.value : null;
    const past = model.pastGrowth;
    const gap = ttmBaseGap(model);
    return [
      { id: "implied", label: "Priced-in growth", value: impliedText(model.implied),
        tone: implied == null || !past ? undefined : implied > past.rate ? "negative" : "positive",
        detail: `a year for ${FORECAST_YEARS}y, then ${pct(TERMINAL_GROWTH, false)}` },
      { id: "revenue", label: `Revenue, yr ${FORECAST_YEARS}`, value: formatCompactCurrency(model.impliedRevenue ?? undefined, currency),
        detail: `at ${describeFcfMargin(model.fcfMargin, model.fcfMarginBasis)}` },
      { id: "past", label: "Past FCF growth", value: past ? pct(past.rate) : MISSING, detail: past ? pastGrowthBasis(past) : undefined },
      { id: "yield", label: "FCF yield", value: pct(model.fcfYield, false) },
      // A trailing figure far above the fiscal year the past growth ends at says so beside itself.
      { id: "fcf", label: "FCF", value: formatCompactCurrency(model.freeCashFlow ?? undefined, currency),
        detail: gap ? `TTM base, ${gap.multiple} ${gap.year}'s ${gap.fcf}` : model.freeCashFlowBasis?.label ?? missing("freeCashFlow") },
      // Market cap + debt - cash where the provider's is more than 5% from it, or in place of one withdrawn; its inputs are in the notice.
      { id: "ev", label: "EV", value: formatCompactCurrency(model.enterpriseValue ?? undefined, currency),
        detail: model.enterpriseValueSheet ? `${model.enterpriseValueSheet} balance sheet` : model.enterpriseValueNote ? "computed" : missing("enterpriseValue") },
    ];
  }, [model]);

  const selectedId = String(discountRate);
  // A figure wraps only into rows the table's least leaves, so the pane never spills.
  const statMaxLines = height - 1 - 4;
  const contentHeight = Math.max(4, height - 1 - statGridRows(stats, width, undefined, { maxLines: statMaxLines }));

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[
      { id: "discount", label: "Discount", value: String(discount), options: DISCOUNT_OPTIONS, onChange: setDiscount },
      { id: "margin", label: "FCF margin", value: String(margin), options: marginOptions(model), onChange: setMargin },
    ]} />
    {!symbol ? <EmptyState title="Select a ticker." /> : <PaneStatusBody subject="reverse DCF" loading={inputs.loading && !model}
      error={!model ? inputs.error ?? identityError ?? null : model.error} empty={false}>
      {model && !model.error && model.missing.length ? <>
        <StatGrid items={stats} width={width} maxLines={statMaxLines} />
        <Box paddingX={1}><Notice variant="callout" tone="muted">{missingInputsText(model.missing)}</Notice></Box>
      </> : model && !model.error ? <>
        <StatGrid items={stats} width={width} maxLines={statMaxLines} />
        {/* Terminal growth rates in order: a sensitivity grid's axis. */}
        <DataTableView<Row> focused={focused} columns={COLUMNS} columnReorder={false} items={model.sensitivity} rootWidth={width} rootHeight={contentHeight}
          getItemKey={(row) => String(row.discountRate)} emptyStateTitle="No implied growth." sortColumnId={null} sortDirection="desc"
          selection={{ kind: "id", selectedId, getId: (row) => String(row.discountRate),
            onChange: (id) => { if (id) setDiscount(String(Math.round(Number(id) * 100))); } }}
          getExportMetadata={() => [["symbol", model.symbol], ["currency", model.currency ?? ""], ["units", "implied annual FCF growth over 10 years, percent"]]}
          renderCell={renderCell} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
