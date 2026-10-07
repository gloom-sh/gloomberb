import { ActionRow } from "../../../components";
import { Box, ChartSurface, Text, useUiCapabilities } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import type { ChartVectorShape } from "../../../ui/host";
import type { ExposureComponent } from "../../../api-client/exposure";
import { basisLabel, rangeText, type ExposureRow } from "./model";
import { truncateToDisplayWidth } from "../../../utils/format";

/** A disclosure-bound interval, not a probability band. Same numerical domain on both renderers. */
export function ExposureRanges({ rows, selectedId, width, height, onSelect, onOpen, showTargets = false }: {
  rows: ExposureRow[]; selectedId: string | null; width: number; height: number; onSelect: (id: string) => void; onOpen: (id: string) => void; showTargets?: boolean;
}) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const selected = rows.find(r => r.id === selectedId) ?? rows[0];
  const eligible = rows.filter(r => r.shockId === selected?.shockId && r.basis === selected?.basis && r.period === selected?.period && r.exposure);
  const shown = eligible.slice(0, Math.max(1, height - 1));
  const lower = Math.min(0, ...eligible.map(r => r.exposure!.low));
  // A fifth of headroom past the largest bound, so no interval or point sits on the edge of its track.
  const upper = Math.max(1, ...eligible.map(r => r.exposure!.high)) * 1.2;
  const span = upper - lower;
  const labelWidth = Math.max(10, Math.min(showTargets ? 42 : 22, Math.floor(width * .32)));
  const plotWidth = Math.max(8, width - labelWidth - 24);
  return <Box flexDirection="column" flexGrow={1} minHeight={0} data-gloom-role="exposure-ranges">
    {shown.map(row => {
      const low = (row.exposure!.low - lower) / span, high = (row.exposure!.high - lower) / span;
      const color = row.classification === "disclosed" ? colors.borderFocused : colors.warning;
      // A disclosed point is a tick; an estimated interval is a band between two ticks.
      const vectors: ChartVectorShape[] = [
        { id: "zero", points: [{ x: (0 - lower) / span, y: .2 }, { x: (0 - lower) / span, y: .8 }], color: colors.border, strokeWidth: 1 },
        { id: "track", points: [{ x: 0, y: .5 }, { x: 1, y: .5 }], color: colors.border, strokeWidth: 1 },
        ...(high - low > 0.004 ? [{ id: "range", points: [{ x: low, y: .5 }, { x: high, y: .5 }], color, strokeWidth: 5 }] : []),
        { id: "low", points: [{ x: low, y: .15 }, { x: low, y: .85 }], color, strokeWidth: 3 },
        { id: "high", points: [{ x: high, y: .15 }, { x: high, y: .85 }], color, strokeWidth: 3 },
      ];
      const start = Math.floor(low * (plotWidth - 1)), end = Math.floor(high * (plotWidth - 1));
      return <Box key={row.id} flexDirection="row" height={1} minHeight={1} paddingX={1}>
        <Box width={labelWidth}><ActionRow label={truncateToDisplayWidth(showTargets ? `${row.label} · ${row.symbol}` : row.symbol || row.label, labelWidth - 1)} active={selectedId === row.id} onPress={() => { onSelect(row.id); onOpen(row.id); }} /></Box>
        {desktop ? <ChartSurface width={plotWidth} height={1} vectors={vectors} /> : <Text fg={color}>{" ".repeat(start)}{"─".repeat(Math.max(0, end - start))}│{" ".repeat(Math.max(0, plotWidth - end - 1))}</Text>}
        <Box width={20} alignItems="flex-end"><Text fg={color}>{rangeText(row.exposure)}</Text></Box>
      </Box>;
    })}
  </Box>;
}

export function ExposurePathDiagram({ component, width, height }: { component: ExposureComponent | null; width: number; height: number }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  if (!component?.path.length) return <Box paddingX={1} flexGrow={1}><Text fg={colors.textDim}>{component ? `${component.label} · ${basisLabel(component.basis)}` : "Select an evidence path."}</Text></Box>;
  const hops = component.path;
  const nodes = [hops[0]!.from, ...hops.map(h => h.to)];
  const nodeWidth = Math.max(8, Math.floor((width - 2) / nodes.length));
  const vectors: ChartVectorShape[] = hops.map((hop, i) => ({ id: `${i}`, points: [{ x: (i + .5) / nodes.length, y: .5 }, { x: (i + 1.5) / nodes.length, y: .5 }], color: hop.pct === null ? colors.textDim : colors.warning, strokeWidth: 2, handles: true }));
  return <Box flexDirection="column" height={height} overflow="hidden">
    <Box paddingX={1} height={1} flexShrink={0}><Text fg={colors.textDim}>{hops.length} hop{hops.length === 1 ? "" : "s"} · {component.classification}{component.exposurePct ? ` · ${rangeText(component.exposurePct)}` : ""}</Text></Box>
    <Box flexDirection="row" height={1} flexShrink={0} paddingX={1}>{nodes.map((node, i) => <Box key={`${node.id}:${i}`} width={nodeWidth} alignItems="center"><Text fg={colors.textBright}>{truncateToDisplayWidth(node.symbol ?? node.name, nodeWidth - 2)}</Text></Box>)}</Box>
    <Box height={1} flexShrink={0} paddingX={1}>
      {desktop ? <ChartSurface width={width - 2} height={1} vectors={vectors} /> : <Text fg={colors.textDim}>{nodes.map((_, i) => i < hops.length ? "─".repeat(Math.max(1, nodeWidth - 2)) + "→ " : "").join("")}</Text>}
    </Box>
    {height >= 4 ? <Box flexDirection="row" height={1} flexShrink={0} paddingX={1}>{nodes.map((_, i) => <Box key={i} width={nodeWidth} alignItems="center"><Text fg={colors.warning}>{i === 0 ? "" : truncateToDisplayWidth(hops[i - 1]!.pct === null ? "Undisclosed share" : `${hops[i - 1]!.pct}% ${basisLabel(hops[i - 1]!.basis)}`, nodeWidth - 1)}</Text></Box>)}</Box> : null}
    {height >= 5 ? <Box flexDirection="row" height={1} flexShrink={0} paddingX={1}>{nodes.map((_, i) => {
      const evidence = i > 0 ? hops[i - 1]!.evidence[0] : null;
      return <Box key={i} width={nodeWidth} alignItems="center"><Text fg={colors.textDim}>{evidence ? truncateToDisplayWidth(`${evidence.tier} · ${evidence.asOf ?? "undated"}`, nodeWidth - 1) : ""}</Text></Box>;
    })}</Box> : null}
  </Box>;
}
