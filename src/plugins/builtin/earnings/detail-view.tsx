import { useMemo } from "react";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import type { EarningsEvent } from "../../../types/data-provider";
import { buildEarningsDetail, formatGrowth, rangeBar, type EstimateBlock } from "./detail-model";

interface EarningsDetailViewProps {
  event: EarningsEvent;
  width: number;
  height: number;
}

function signColor(value: number | null): string {
  if (value == null) return colors.textDim;
  return value > 0 ? colors.positive : value < 0 ? colors.negative : colors.textDim;
}

/** One estimate: the consensus, where it sits in the range, and how it moved. */
function EstimatePanel({ block, width }: { block: EstimateBlock; width: number }) {
  const labelWidth = 13;
  const barWidth = Math.max(12, width - block.lowText.length - block.highText.length - 4);
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Box height={1}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{block.label.toUpperCase()}</Text>
      </Box>
      <Box height={1} flexDirection="row">
        <Text fg={block.consensus ? colors.textBright : colors.textDim} attributes={TextAttributes.BOLD}>
          {block.consensus ?? "no consensus"}
        </Text>
        {block.analysts != null ? (
          <Text fg={colors.textDim}>{`  ${block.analysts} ${block.analysts === 1 ? "analyst" : "analysts"}`}</Text>
        ) : null}
      </Box>
      {block.position != null ? (
        <Box height={1} flexDirection="row">
          <Text fg={colors.textDim}>{`${block.lowText} `}</Text>
          <Text fg={colors.borderFocused}>{rangeBar(block.position, barWidth)}</Text>
          <Text fg={colors.textDim}>{` ${block.highText}`}</Text>
        </Box>
      ) : block.lowText || block.highText ? (
        <Box height={1}>
          <Text fg={colors.textDim}>{`range ${block.lowText || "?"} to ${block.highText || "?"}`}</Text>
        </Box>
      ) : null}
      {block.yearAgo || block.growth != null ? (
        <Box height={1} flexDirection="row">
          <Box width={labelWidth} flexShrink={0}>
            <Text fg={colors.textDim}>year ago</Text>
          </Box>
          <Text fg={colors.text}>{block.yearAgo ?? ""}</Text>
          {block.growth != null ? (
            <Text fg={signColor(block.growth)}>{`${block.yearAgo ? "  " : ""}${formatGrowth(block.growth)}`}</Text>
          ) : null}
        </Box>
      ) : null}
      {block.trend.map((row) => (
        <Box key={row.label} height={1} flexDirection="row">
          <Box width={labelWidth} flexShrink={0}>
            <Text fg={colors.textDim}>{row.label}</Text>
          </Box>
          <Text fg={colors.text}>{row.value}</Text>
          {row.changeText ? <Text fg={signColor(row.change)}>{`  ${row.changeText}`}</Text> : null}
        </Box>
      ))}
      {block.revisions.map((row) => {
        const net = row.up != null && row.down != null ? row.up - row.down : null;
        return (
          <Box key={row.label} height={1} flexDirection="row">
            <Box width={labelWidth} flexShrink={0}>
              <Text fg={colors.textDim}>{`revisions ${row.label}`}</Text>
            </Box>
            <Text fg={signColor(net)}>{`${row.up ?? "?"} up · ${row.down ?? "?"} down`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Everything the provider knows about one upcoming report, laid out instead
 * of squeezed into fifteen columns. The deeper surfaces (ticker, estimates,
 * calls, analysts) are the pane footer's `t` `e` `c` `a`, not a row here.
 */
export function EarningsDetailView({ event, width, height }: EarningsDetailViewProps) {
  const detail = useMemo(() => buildEarningsDetail(event), [event]);
  const inner = Math.max(20, width - 2);
  const wide = inner >= 76;
  const panelWidth = wide ? Math.floor((inner - 3) / 2) : inner;
  const facts = [
    detail.date,
    detail.timing,
    detail.dateStatus ? `date ${detail.dateStatus}` : null,
    detail.period,
  ].filter((part): part is string => !!part);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box height={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{detail.date}</Text>
        {facts.length > 1 ? (
          <Text fg={detail.dateStatus === "estimated" ? colors.warning : colors.textDim}>{`  ${facts.slice(1).join(" · ")}`}</Text>
        ) : null}
      </Box>
      <Box flexDirection={wide ? "row" : "column"} marginTop={1} gap={wide ? 3 : 1}>
        <EstimatePanel block={detail.eps} width={panelWidth} />
        <EstimatePanel block={detail.revenue} width={panelWidth} />
      </Box>
    </Box>
  );
}
