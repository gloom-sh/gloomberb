import { useCallback, useEffect, useRef, useState } from "react";
import { Box } from "../../../ui";
import {
  DataTableView,
  QueryBar,
  StatGrid,
  statGridRows,
  usePaneFooter,
  usePaneNoticeFooter,
  useQueryBarSearch,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import { FILL_REST } from "../../../components/ui/fill";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../public/react";
import { isAccessDenied } from "../../../api-client/errors";
import type { ScreenDefinition } from "../../../api-client/equity-screener";
import { useThemeColors } from "../../../theme/theme-context";
import { fetchScreenCheck } from "./client";
import { checkRows, screenCheckSummary } from "./screen-check";

interface ScreenTickerCheckProps {
  definition: ScreenDefinition;
  snapshotId?: string;
  width: number;
  height: number;
  focused: boolean;
  fetcher?: typeof fetchScreenCheck;
}

/** A check keeps the screen's snapshot; streaming prices never change its decisions. */
export function ScreenTickerCheck({
  definition,
  snapshotId,
  width,
  height,
  focused,
  fetcher = fetchScreenCheck,
}: ScreenTickerCheckProps) {
  const colors = useThemeColors();
  const [draft, setDraft] = useState("");
  const [ticker, setTicker] = useState<string | null>(null);
  const search = useQueryBarSearch();
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    return fetcher(definition, ticker!, snapshotId, request.signal);
  }, [definition, fetcher, snapshotId, ticker]);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useEffect(() => { search.focus(); }, [search.focus]);
  const resource = useAsyncResource(ticker ? loader : null, { clearOnError: isAccessDenied });
  const { data, loading, error } = resource;
  const submit = (value: string) => {
    const next = value.trim();
    if (!next) return;
    search.blur();
    if (next === ticker) void resource.reload();
    else setTicker(next);
  };
  usePaneRefreshKey(() => { void resource.reload(); }, { focused, enabled: !!ticker && !search.active });
  usePaneFooter("equity-screener:check", () => ({
    info: [
      ...(loading ? [{ id: "loading", parts: [{ text: "checking ticker", tone: "muted" as const }] }] : []),
      ...(data ? [{
        id: "snapshot",
        parts: [{ text: `snapshot ${data.snapshot.assembledAt.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" as const }],
      }] : []),
    ],
    hints: [{
      id: "check",
      key: "c",
      label: "heck ticker",
      onPress: () => submit(draft),
      disabled: !draft.trim() || loading,
    }],
  }), [draft, ticker, loading, data, submit]);
  usePaneNoticeFooter({
    registrationId: "equity-screener:check-notices",
    focused,
    notices: [...(data?.warnings ?? []), ...(error ? [error] : [])],
  });
  const rows = data ? checkRows(data) : [];
  const columns: DataTableColumn[] = [
    { id: "criterion", label: "Criterion", width: Math.max(26, ...rows.map((row) => row.criterion.length)), flexGrow: 1, align: "left" },
    { id: "value", label: "Value", width: Math.max(12, ...rows.map((row) => row.value.length)), align: "right" },
    { id: "result", label: "Result", width: Math.max(6, ...rows.map((row) => row.result.length)), align: "left" },
    { id: "asOf", label: "As of", width: Math.max(10, ...rows.map((row) => row.asOf.length)), align: "left" },
    ...(rows.some((row) => row.state !== "available" && row.state !== "missing")
      ? [{ id: "state", label: "Data", width: 12, align: "left" as const }]
      : []),
    ...(rows.some((row) => row.reason)
      ? [{ id: "reason", label: "Reason", width: 30, align: "left" as const }]
      : []),
  ];
  const stats: StatItem[] = data ? [
    { label: "Listing", value: data.row ? `${data.row.symbol}:${data.row.exchange}` : data.symbol, detail: data.row?.name ?? undefined },
    { label: "Result", value: screenCheckSummary(data), tone: data.matches === null ? "muted" : data.matches ? "positive" : "negative" },
  ] : [];
  return (
    <Box width={width} flexDirection="column" {...FILL_REST}>
      <QueryBar
        width={width}
        filters={[{
          kind: "text",
          id: "ticker",
          label: "Ticker",
          value: draft,
          onChange: setDraft,
          placeholder: "NVDA or NVDA:NASDAQ",
          focused,
          ...search.searchProps,
          debounceMs: 0,
          width: 24,
          onSubmit: submit,
        }]}
      />
      {data ? <StatGrid width={width} items={stats} /> : null}
      <DataTableView
        columns={columns}
        items={rows}
        getItemKey={(row) => row.id}
        selection={{ kind: "none" }}
        focused={focused && !search.active}
        rootWidth={width}
        rootHeight={Math.max(1, height - 1 - statGridRows(stats, width))}
        status={{
          loading: loading && !data,
          error: !data ? error : null,
          empty: !ticker,
          subject: "ticker check",
          emptyTitle: "Enter a ticker to check this screen.",
        }}
        renderCell={(row, column) => ({
          text: column.id === "reason" ? row.reason ?? "--" : row[column.id as "criterion" | "value" | "result" | "asOf" | "state"],
          color: column.id === "result"
            ? row.passes === null ? colors.textMuted : row.passes ? colors.positive : colors.negative
            : column.id === "reason" || column.id === "state" || column.id === "asOf" ? colors.textMuted : colors.text,
        })}
        sortColumnId={null}
        sortDirection="asc"
        emptyStateTitle="No criteria in this screen."
      />
    </Box>
  );
}
