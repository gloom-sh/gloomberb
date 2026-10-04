import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../../../api-client";
import { getWallSummary } from "../../../api-client/wall-summary";
import { usePlanAccess } from "../../../api-client/plan-access";
import { exposeWallTeaser, recordWallViewed } from "../../../api-client/research-activity";
import { Badge, DataTableView, KeyValueRow, SectionHeading } from "../../../components";
import { getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { usePaneVisible } from "../../../state/app/activity";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { wrapTextLines } from "../../../utils/text-wrap";
import { listingIdentity } from "./ticker-request";
import { WALL_TEASERS } from "./wall-teaser-catalog";
import { trackWallView } from "./wall-view-lifecycle";

export interface WallTeaserProps {
  placement: string;
  width: number;
  height: number;
  title?: string;
  message?: string;
  symbol?: string | null;
  exchange?: string;
  children: ReactNode;
}

const SUMMARY_LABELS: Record<string, string> = {
  risk_count: "Risk factors",
  filed_at: "Filed",
  proxy_count: "Proxy statements",
  call_count: "Calls available",
  last_call_at: "Last call",
  filing_count_90d: "8-K filings in 90 days",
  last_filed_at: "Last filed",
  open_roles: "Open roles",
  as_of: "As of",
};

type Summary = { kind: "counts"; items: { label: string; value: number | string }[] };
type Teaser = { kind: "summary"; summary: Summary } | { kind: "sample" } | { kind: "none" };

/** No layout reservation or focus changes: the original wall remains usable while asking. */
export function WallTeaser({ children, placement, width, height, title = "", message = "", symbol, exchange }: WallTeaserProps) {
  useAppLanguage();
  const visible = usePaneVisible();
  const access = usePlanAccess();
  const userId = apiClient.getCurrentUser()?.id;
  const native = useUiCapabilities().nativePaneChrome === true;
  const colors = useThemeColors();
  const sample = WALL_TEASERS[placement];
  const listing = sample?.summaryHook ? listingIdentity(symbol, exchange) : null;
  const key = `${userId ?? "guest"}:${placement}:${listing?.symbol ?? ""}:${listing?.exchange ?? ""}`;
  const [resolved, setResolved] = useState<{ key: string; arm: string | null; teaser: Teaser } | null>(null);
  // The original wall uses two inset rows and two action rows. The preview
  // keeps its own bottom inset; a sample needs a badge, gap and table header.
  const copyRows = wrapTextLines(t(title), Math.max(1, width - 2)).length
    + (message ? wrapTextLines(t(message), Math.max(1, width - 2)).length : 0);
  const previewRows = Math.max(0, height - copyRows - 5);
  const sampleRows = Math.min(8, Math.max(0, previewRows - 3));
  const hookRows = sample?.summaryHook ? wrapTextLines(t(sample.summaryHook), Math.max(1, width - 2)).length : 0;
  const fits = width >= 34 && sampleRows >= 2;
  const trackedView = useRef<ReturnType<typeof trackWallView> | null>(null);

  useEffect(() => {
    if (!visible || access.hasProAccess) return;
    const view = trackWallView({
      identity: userId ?? "guest",
      placement,
      exposure: exposeWallTeaser(),
      currentIdentity: () => apiClient.getCurrentUser()?.id ?? "guest",
      record: recordWallViewed,
    });
    trackedView.current = view;
    return () => {
      if (trackedView.current === view) trackedView.current = null;
      view.release();
    };
  }, [visible, access.hasProAccess, userId, placement]);

  useEffect(() => {
    if (!visible || access.hasProAccess) return;
    let cancelled = false;
    void (async () => {
      const arm = await (trackedView.current?.exposure ?? exposeWallTeaser());
      if (cancelled) return;
      let teaser: Teaser = { kind: "none" };
      if (arm === "teaser" && fits && sample) {
        const summary = listing
          ? await getWallSummary(placement, listing.symbol, listing.exchange)
          : null;
        teaser = summary?.items.length ? { kind: "summary", summary } : { kind: "sample" };
      }
      if (cancelled) return;
      setResolved({ key, arm, teaser });
    })();
    return () => { cancelled = true; };
  }, [visible, access.hasProAccess, key, fits, placement, listing?.symbol, listing?.exchange, sample]);

  const current = resolved?.key === key ? resolved : null;
  const summaryFits = current?.teaser.kind !== "summary" || current.teaser.summary.items.length + hookRows <= previewRows;
  const teaser = fits && summaryFits && current?.arm === "teaser" ? current.teaser : { kind: "none" as const };
  useEffect(() => {
    if (!visible || !current || access.hasProAccess) return;
    trackedView.current?.report(current.arm === "teaser" ? teaser.kind : undefined);
  }, [visible, current, access.hasProAccess, placement, teaser.kind]);

  return <>
    {children}
    {teaser.kind !== "none" && <Box
      flexDirection="column" paddingX={1} paddingBottom={1} flexShrink={0}
      data-gloom-ui="wall-teaser" data-teaser-kind={teaser.kind}
    >
      {teaser.kind === "summary" ? <>
        {teaser.summary.items.map((item) => (
          <KeyValueRow key={item.label} label={t(SUMMARY_LABELS[item.label] ?? item.label)}
            value={String(item.value)} width={width - 2} labelWidth={Math.min(25, width - 14)} />
        ))}
        {sample?.summaryHook && <Text fg={colors.textMuted} dim wrapText>{t(sample.summaryHook)}</Text>}
      </> : <FrozenWallSample placement={placement} width={width - 2} rows={sampleRows} native={native} />}
    </Box>}
  </>;
}

const SAMPLE_TICKERS = ["AAPL", "MSFT", "NVDA", "AMZN", "TSLA", "META", "AMD", "GOOGL"];

/** Stable per cell, independent of viewport changes and renders. Never encodes data. */
function placeholderFraction(row: number, column: number): number {
  return (38 + ((row * 17 + column * 29) % 49)) / 100;
}

function Placeholder({ row, column, width, native }: { row: number; column: number; width: number; native: boolean }) {
  const colors = useThemeColors();
  const fraction = placeholderFraction(row, column);
  return native
    ? <Box style={{ background: colors.textMuted, opacity: 0.35, filter: "blur(3px)", width: `${fraction * 100}%`, height: "0.65em", marginTop: "0.2em", pointerEvents: "none", userSelect: "none" }} />
    : <Text fg={colors.textMuted} dim>{"░".repeat(Math.max(2, Math.floor(width * fraction)))}</Text>;
}

function FrozenWallSample({ placement, width, rows, native }: { placement: string; width: number; rows: number; native: boolean }) {
  const colors = useThemeColors();
  const sample = WALL_TEASERS[placement]!;
  const columns = sample.layout === "table" ? sample.columns.map((column, index) => ({
    ...column, id: String(index), label: t(column.label),
  })) : [];
  // Fit complete headers using the kit's own gap/header arithmetic. Preserve
  // the real column order while dropping the least important fields first.
  while (columns.length > 1 && getTableWidth(columns) > width) {
    const priority = Math.max(...columns.map((column) => column.priority));
    columns.splice(columns.findIndex((column) => column.priority === priority), 1);
  }
  const spare = Math.max(0, width - getTableWidth(columns));
  columns.forEach((column, index) => {
    column.width = tableColumnWidth(column) + Math.floor(spare / columns.length) + (index < spare % columns.length ? 1 : 0);
  });
  return <>
    <Box flexDirection="row" marginBottom={1}><Badge label={t("Sample")} /></Box>
    {sample.layout === "prose" ? <Box flexDirection="column">
      {sample.issuer && <SectionHeading title={sample.issuer} />}
      {Array.from({ length: rows }, (_, row) => <Box key={row} height={1}>
        <Placeholder row={row} column={0} width={width} native={native} />
      </Box>)}
    </Box> :
    <Box height={rows + 1} style={native ? { pointerEvents: "none", userSelect: "none" } : undefined}>
      <DataTableView
        columns={columns} items={SAMPLE_TICKERS.slice(0, rows)} rootWidth={width} rootHeight={rows + 1}
        focused={false} keyboardNavigation={false} selection={{ kind: "none" }} sortable={false}
        sortColumnId={null} sortDirection="asc" getItemKey={(_row, index) => String(index)}
        isNavigable={() => false} emptyStateTitle="" showHorizontalScrollbar={false}
        renderCell={(ticker, column) => {
          const sourceColumn = sample.columns[Number(column.id)]!;
          const identifier = sourceColumn.label === "TICKER" || sourceColumn.label === "NEW HIGH";
          const row = SAMPLE_TICKERS.indexOf(ticker);
          return {
            text: identifier ? ticker : native ? "" : "░".repeat(Math.max(2, Math.floor(column.width * placeholderFraction(row, Number(column.id))))),
            color: colors.textMuted,
            content: native && !identifier
              ? <Placeholder row={row} column={Number(column.id)} width={column.width} native />
              : undefined,
            ...(!identifier ? { attributes: 2 } : {}),
          };
        }}
      />
    </Box>}
  </>;
}
