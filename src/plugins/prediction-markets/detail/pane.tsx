import { Box, ScrollBox, Text } from "../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import type { RefObject } from "react";
import { Tabs } from "../../../components";
import { EmptyState } from "../../../components/ui/status";
import { colors } from "../../../theme/colors";
import { padTo } from "../../../utils/format";
import { DETAIL_TABS } from "../navigation";
import {
  formatPredictionEndsAt,
  formatPredictionMetric,
  formatPredictionProbability,
  formatPredictionSpread,
  getPredictionProbabilityColor,
} from "../metrics";
import type {
  PredictionDetailTab,
  PredictionHistoryRange,
  PredictionListRow,
  PredictionMarketDetail,
  PredictionMarketSummary,
} from "../types";
import { PredictionMarketBookView } from "./book";
import { PredictionMarketOverviewView } from "./overview";
import { PredictionMarketRulesView } from "./rules";
import { truncatePredictionText } from "./shared";
import { PredictionMarketTradesView } from "./trades";
import { PredictionMarketChart } from "../chart";

type RelatedMarketPointerEvent = { preventDefault(): void };

interface MetricCell {
  label: string;
  value: string;
  width: number;
  color?: string;
}

/**
 * Drops trailing metrics that do not fit rather than letting the strip overflow
 * the detail pane. YES and NO always survive.
 */
function fitMetrics(metrics: MetricCell[], width: number): MetricCell[] {
  const fitted: MetricCell[] = [];
  let used = 0;
  for (const metric of metrics) {
    const next = used + metric.width + (fitted.length > 0 ? 1 : 0);
    if (fitted.length >= 2 && next > width) break;
    fitted.push(metric);
    used = next;
  }
  return fitted;
}

function MetricLabelRow({ metrics }: { metrics: MetricCell[] }) {
  return (
    <Box flexDirection="row" height={1}>
      {metrics.map((metric, index) => (
        <Box
          key={metric.label}
          width={metric.width + (index === metrics.length - 1 ? 0 : 1)}
        >
          <Text fg={colors.textDim}>{padTo(metric.label, metric.width)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function MetricValueRow({ metrics }: { metrics: MetricCell[] }) {
  return (
    <Box flexDirection="row" height={1}>
      {metrics.map((metric, index) => (
        <Box
          key={metric.label}
          width={metric.width + (index === metrics.length - 1 ? 0 : 1)}
        >
          <Text
            fg={metric.color ?? colors.textBright}
            attributes={TextAttributes.BOLD}
          >
            {padTo(metric.value, metric.width)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function PredictionMarketDetailPane({
  detail,
  detailError,
  detailLoadCount,
  detailTab,
  detailWidth,
  focused,
  height,
  historyRange,
  onDetailTabChange,
  onHistoryRangeChange,
  onSelectMarket,
  selectedRow,
  selectedSummary,
  scrollRef,
}: {
  detail: PredictionMarketDetail | null;
  detailError: string | null;
  detailLoadCount: number;
  detailTab: PredictionDetailTab;
  detailWidth: number;
  focused: boolean;
  height: number;
  historyRange: PredictionHistoryRange;
  onDetailTabChange: (tab: PredictionDetailTab) => void;
  onHistoryRangeChange: (range: PredictionHistoryRange) => void;
  onSelectMarket: (marketKey: string) => void;
  selectedRow: PredictionListRow | null;
  selectedSummary: PredictionMarketSummary | null;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  if (!selectedSummary) {
    return (
      <Box flexGrow={1} justifyContent="center">
        <EmptyState
          title="Select a market."
          hint="Use the table on the left to inspect live prediction market detail."
        />
      </Box>
    );
  }

  const summaryMetrics = detail?.summary ?? selectedSummary;
  const detailSubtitleParts: string[] = [];
  if (selectedRow?.kind === "group") {
    if (summaryMetrics.category) detailSubtitleParts.push(summaryMetrics.category);
  } else if (
    summaryMetrics.eventLabel &&
    summaryMetrics.eventLabel !== summaryMetrics.title
  ) {
    detailSubtitleParts.push(summaryMetrics.eventLabel);
  } else if (summaryMetrics.category) {
    detailSubtitleParts.push(summaryMetrics.category);
  }
  const endsLabel = formatPredictionEndsAt(
    selectedRow?.kind === "group" ? selectedRow.endsAt : summaryMetrics.endsAt,
  );
  if (endsLabel !== "—") detailSubtitleParts.push(endsLabel);
  const detailSubtitle = detailSubtitleParts.join(" · ");
  const metrics: MetricCell[] = [
    {
      label: "YES",
      value: formatPredictionProbability(summaryMetrics.yesPrice),
      color: getPredictionProbabilityColor(summaryMetrics.yesPrice),
      width: 6,
    },
    {
      label: "NO",
      value: formatPredictionProbability(summaryMetrics.noPrice),
      color: getPredictionProbabilityColor(summaryMetrics.noPrice),
      width: 6,
    },
    {
      label: "24H VOL",
      value: formatPredictionMetric(
        summaryMetrics.volume24h,
        summaryMetrics.volume24hUnit ?? "usd",
      ),
      width: 8,
    },
    {
      label: "TOTAL VOL",
      value: formatPredictionMetric(
        summaryMetrics.totalVolume,
        summaryMetrics.totalVolumeUnit ?? "usd",
      ),
      width: 9,
    },
    {
      label: "OI",
      value: formatPredictionMetric(
        summaryMetrics.openInterest,
        summaryMetrics.openInterestUnit ?? "usd",
      ),
      width: 7,
    },
    {
      label: "SPREAD",
      value: formatPredictionSpread(summaryMetrics.spread),
      width: 7,
    },
    {
      label: "LAST",
      value: formatPredictionProbability(summaryMetrics.lastTradePrice),
      color: colors.textBright,
      width: 7,
    },
  ];
  const visibleMetrics = fitMetrics(metrics, Math.max(12, detailWidth));
  const relatedSiblings =
    selectedRow?.kind === "group"
      ? []
      : (detail?.siblings
          ?.filter((sibling) => sibling.key !== selectedSummary.key)
          .slice(
            0,
            Math.max(Math.min(Math.floor((detailWidth - 10) / 18), 3), 0),
          ) ?? []);
  const headerHeight = detailSubtitle.length > 0 ? 2 : 0;
  const detailLoading = detailLoadCount > 0 && !detail;
  const detailTextWidth = Math.max(detailWidth, 12);

  return (
    <>
      {headerHeight > 0 && (
        <Box flexDirection="column" height={headerHeight} paddingBottom={1}>
          <Box flexDirection="row" height={1}>
            <Text fg={colors.textDim}>
              {truncatePredictionText(detailSubtitle, detailTextWidth)}
            </Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" height={3} paddingBottom={1}>
        <MetricLabelRow metrics={visibleMetrics} />
        <MetricValueRow metrics={visibleMetrics} />
      </Box>

      {relatedSiblings.length > 0 && (
        <Box flexDirection="row" gap={1} height={1} paddingBottom={1}>
          <Text fg={colors.textDim}>Related:</Text>
          {relatedSiblings.map((sibling) => (
            <Box
              key={sibling.key}
              onMouseDown={(event: RelatedMarketPointerEvent) => {
                event.preventDefault();
                onSelectMarket(sibling.key);
              }}
            >
              <Text fg={colors.text}>
                {`${truncatePredictionText(sibling.label, 10)} ${formatPredictionProbability(sibling.yesPrice)}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box paddingBottom={1}>
        <Tabs
          tabs={DETAIL_TABS.map((tab) => ({
            label: tab.label,
            value: tab.value,
          }))}
          activeValue={detailTab}
          onSelect={(value) => onDetailTabChange(value as PredictionDetailTab)}
          compact
          focused={focused}
        />
      </Box>

      {/* Shown even when cached detail is on screen, so a failed refresh is never
          presented as current data. */}
      {detailError && (
        <Box paddingBottom={1}>
          <Text
            fg={colors.negative}
            width={detailTextWidth}
            wrapMode="word"
            wrapText
          >
            {detail ? `Showing cached data: ${detailError}` : detailError}
          </Text>
        </Box>
      )}

      {detailTab === "overview" || detailTab === "rules" ? (
        <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
          {detailTab === "overview" && (
            <PredictionMarketOverviewView
              detail={detail}
              detailWidth={detailWidth}
              onSelectMarket={onSelectMarket}
              selectedRow={selectedRow}
              summary={summaryMetrics}
            />
          )}

          {detailTab === "rules" && (
            <PredictionMarketRulesView
              detailWidth={detailTextWidth}
              rules={detail?.rules ?? []}
            />
          )}
        </ScrollBox>
      ) : null}

      {detailTab === "chart" && (
        <PredictionMarketChart
          history={detail?.history ?? []}
          width={detailWidth}
          height={Math.max(height - 8, 8)}
          loading={detailLoading}
          focused={focused}
          range={historyRange}
          onRangeSelect={onHistoryRangeChange}
        />
      )}

      {detailTab === "book" && (
        detail ? (
          <PredictionMarketBookView
            detail={detail}
            focused={focused}
            width={detailWidth}
          />
        ) : (
          <Box flexGrow={1} justifyContent="center">
            <EmptyState
              title={detailLoading ? "Loading order book." : "No order book."}
              hint="This venue did not return current order book depth."
            />
          </Box>
        )
      )}

      {detailTab === "trades" && (
        <PredictionMarketTradesView
          focused={focused}
          trades={detail?.trades ?? []}
          width={detailWidth}
        />
      )}
    </>
  );
}
