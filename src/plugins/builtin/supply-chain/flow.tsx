import type { ChartVectorShape } from "../../../ui/host";
import { useEffect, useMemo, useState } from "react";
import { ActionRow } from "../../../components";
import { Box, ChartSurface, Text, Span, useUiCapabilities } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { truncateToDisplayWidth } from "../../../utils/format";
import { useThemeColors } from "../../../theme/theme-context";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import type { SupplyRow } from "../../../api-client/supply-chain";
import { dollars, flowBands, percentage, ROLE_COLORS, type FlowBand, type FlowNode } from "./model";

interface PositionedNode extends FlowNode { x: number; y: number; width: number; }
function curve(x0: number, y0: number, x1: number, y1: number) {
  return Array.from({ length: 49 }, (_, i) => { const t = i / 48, s = t * t * (3 - 2 * t); return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * s }; });
}
/** The terminal and SVG consume the same geometry and selection. Labels remain native controls. */
export function SupplyFlow({ rows, symbol, focusId, width, height, focused, selectedId, onSelect, onOpen, onVisible }: {
  rows: SupplyRow[]; symbol: string; focusId?: string; width: number; height: number; focused: boolean;
  selectedId: string | null; onSelect: (id: string) => void; onOpen: (row: SupplyRow) => void; onVisible: (ids: string[]) => void;
}) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const bitmapSize = useStaticChartBitmapSize(width, height);
  const [pages, setPages] = useState<Partial<Record<FlowBand, number>>>({});
  const hasRelated = rows.some((row) => row.role !== "supplier" && row.role !== "customer");
  const plotRows = Math.max(4, height - (hasRelated ? 8 : 4));
  const limit = Math.max(2, Math.min(8, Math.floor(plotRows / 2)));
  const bands = useMemo(() => ({ ...flowBands(rows, limit, pages, focusId), related: flowBands(rows, 3, pages, focusId).related }), [rows, limit, pages, focusId]);
  const related = bands.related.length > 0;
  const labelWidth = Math.max(16, Math.min(27, Math.floor(width * 0.27)));
  const centerWidth = Math.max(9, Math.min(15, symbol.length + 5));
  const centerX = Math.floor((width - centerWidth) / 2), centerY = Math.max(3, Math.floor((height - (related ? 6 : 2)) / 2));
  const nodes: PositionedNode[] = [];
  for (const band of ["suppliers", "customers"] as const) {
    const entries = bands[band];
    const usable = plotRows;
    entries.forEach((node, index) => nodes.push({ ...node, x: band === "suppliers" ? 1 : width - labelWidth - 1,
      y: 2 + Math.floor(index * usable / Math.max(entries.length, 1)), width: labelWidth }));
  }
  // Relationships without a trade direction get their own band, never a fabricated supplier/customer arrow.
  const relatedLimit = Math.min(3, bands.related.length);
  const relatedNodes = bands.related.slice(0, relatedLimit);
  relatedNodes.forEach((node, index) => nodes.push({ ...node, x: 1 + Math.floor(index * (width - 2) / relatedLimit), y: height - 3, width: Math.floor((width - 3) / relatedLimit) - 1 }));
  const visibleIds = nodes.filter((node) => node.row).map((node) => node.id).join("\n");
  useEffect(() => { onVisible(visibleIds ? visibleIds.split("\n") : []); }, [visibleIds, onVisible]);
  const selectedIndex = Math.max(0, nodes.findIndex((node) => node.id === selectedId));
  const selectNode = (node: PositionedNode) => {
    if (node.more) setPages((old) => ({ ...old, [node.band]: (old[node.band] ?? 0) + 1 }));
    else if (node.row) { onSelect(node.id); onOpen(node.row); }
  };
  useShortcut((event) => {
    if (!focused || event.defaultPrevented || nodes.length === 0) return;
    if (isPlainKey(event, "j", "down") || isPlainKey(event, "k", "up")) {
      const direction = isPlainKey(event, "j", "down") ? 1 : -1;
      onSelect(nodes[(selectedIndex + direction + nodes.length) % nodes.length]!.id);
    } else if (isPlainKey(event, "return", "enter")) selectNode(nodes[selectedIndex]!);
    else return;
    event.preventDefault(); event.stopPropagation();
  });
  const vectors: ChartVectorShape[] = nodes.filter((node) => node.row && node.band !== "related").map((node) => {
    const left = node.band === "suppliers";
    const startX = left ? node.x + node.width : centerX + centerWidth;
    const endX = left ? centerX : node.x;
    return { id: node.id, points: curve(startX / width, (left ? node.y + 0.5 : centerY + 0.5) / height,
      endX / width, (left ? centerY + 0.5 : node.y + 0.5) / height),
      color: ROLE_COLORS[node.row!.role], strokeWidth: node.weight > 0.035 ? Math.max(1.5, node.weight * 16) : 1.5 };
  });
  const bitmap = useMemo(() => {
    if (desktop || !bitmapSize) return null;
    const { pixelWidth: w, pixelHeight: h } = bitmapSize;
    const pixels = new Uint8Array(w * h * 4); fillOpaque(pixels, parseHex(colors.bg));
    for (const vector of vectors) for (let i = 1; i < vector.points.length; i++) {
      const a = vector.points[i - 1]!, b = vector.points[i]!;
      drawLine(pixels, w, h, a.x * w, a.y * h, b.x * w, b.y * h, parseHex(vector.color, 0.7), (vector.strokeWidth ?? 2) * w / (width * 8));
    }
    return { width: w, height: h, pixels };
  }, [desktop, bitmapSize, JSON.stringify(vectors), colors.bg, width]);
  const fallback = useMemo(() => {
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ mask: 0, color: colors.textDim })));
    const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
    for (const vector of vectors) for (let p = 1; p < vector.points.length; p++) {
      const a = vector.points[p - 1]!, b = vector.points[p]!;
      const steps = Math.ceil(Math.max(Math.abs(b.x - a.x) * width * 2, Math.abs(b.y - a.y) * height * 4)) + 1;
      for (let i = 0; i <= steps; i++) {
        const px = Math.floor((a.x + (b.x - a.x) * i / steps) * width * 2);
        const py = Math.floor((a.y + (b.y - a.y) * i / steps) * height * 4);
        const radius = Math.floor((vector.strokeWidth ?? 1) / 7);
        for (let dy = -radius; dy <= radius; dy++) {
          const y = py + dy; if (y < 0 || px < 0) continue;
          const cell = grid[Math.floor(y / 4)]?.[Math.floor(px / 2)];
          if (cell) { cell.mask |= bits[y % 4]![px % 2]!; cell.color = vector.color; }
        }
      }
    }
    return grid.map((line) => {
      const spans: { text: string; color: string }[] = [];
      for (const cell of line) {
        const char = cell.mask ? String.fromCharCode(0x2800 + cell.mask) : " ";
        if (spans.at(-1)?.color === cell.color) spans.at(-1)!.text += char;
        else spans.push({ text: char, color: cell.color });
      }
      return spans;
    });
  }, [width, height, JSON.stringify(vectors), colors.textDim]);
  const nodeMetric = (row: SupplyRow) => {
    if (row.pctOfRevenue !== null) {
      if (row.reportingEntity.id !== focusId) return `${Number(row.pctOfRevenue.toFixed(1))}% of ${row.reportingEntity.ticker ?? row.reportingEntity.name}${row.pctBasis === "revenue" ? " rev" : ` ${row.pctBasis}`}`;
      return percentage(row);
    }
    return [row.counterparty.ticker, row.usd !== null ? dollars(row) : row.role].filter(Boolean).join(" · ");
  };
  return <Box width={width} height={height} flexGrow={1} flexBasis={0} minHeight={0} position="relative" overflow="hidden">
    <ChartSurface width={width} height={height} position="absolute" left={0} top={0} vectors={desktop ? vectors : undefined} bitmap={bitmap} flexDirection="column" aria-label="Supply chain flow">
      {!desktop ? fallback.map((spans, y) => <Text key={y}>{spans.map((span, i) => <Span key={i} fg={span.color}>{span.text}</Span>)}</Text>) : null}
    </ChartSurface>
    <Box position="absolute" top={0} left={1}><Text fg={ROLE_COLORS.supplier}>SUPPLIERS</Text></Box>
    <Box position="absolute" top={0} left={width - labelWidth - 1}><Text fg={ROLE_COLORS.customer}>CUSTOMERS</Text></Box>
    <Box position="absolute" left={centerX} top={centerY} width={centerWidth} height={2} backgroundColor={colors.selected} alignItems="center" justifyContent="center"><Text fg={colors.textBright}>{symbol}</Text></Box>
    {bands.suppliers.length === 0 ? <Box position="absolute" top={3} left={1}><Text fg={colors.textDim}>None disclosed</Text></Box> : null}
    {bands.customers.length === 0 ? <Box position="absolute" top={3} left={width - labelWidth - 1}><Text fg={colors.textDim}>None disclosed</Text></Box> : null}
    {related ? <Box position="absolute" left={1} top={height - 5}><Text fg={colors.textDim}>PARTNERS · COMPETITORS · INVESTEES</Text></Box> : null}
    {nodes.map((node) => <Box key={node.id} position="absolute" left={node.x} top={node.y} width={node.width} height={2} flexDirection="column" backgroundColor={colors.bg}>
      <ActionRow width={node.width} height={1} label={truncateToDisplayWidth(node.label, node.width - 1)} fg={node.row ? ROLE_COLORS[node.row.role] : colors.textMuted}
        active={nodes[selectedIndex]?.id === node.id} onPress={() => selectNode(node)} />
      {node.row ? <Text fg={colors.textDim}>{truncateToDisplayWidth(nodeMetric(node.row), node.width - 1)}</Text> : null}
    </Box>)}
  </Box>;
}
