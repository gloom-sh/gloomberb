import { useEffect, useMemo, useRef, useState } from "react";
import { ActionRow, usePaneStatusFooter } from "../../../components";
import { Box, ChartSurface, ScrollBox, Span, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import type { ChartVectorShape } from "../../../ui/host";
import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import type { SupplyEntity } from "../../../api-client/supply-chain";
import { useThemeColors } from "../../../theme/theme-context";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { truncateToDisplayWidth } from "../../../utils/format";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import { entityLabel, graphNodes } from "./graph-model";

const TONES = { upstream: "#60a5fa", downstream: "#fbbf24", related: "#a78bfa" };
function blend(foreground: string, background: string, opacity: number): string {
  const f = parseHex(foreground), b = parseHex(background);
  return `#${(["r", "g", "b"] as const).map(i => Math.round(f[i] * opacity + b[i] * (1 - opacity)).toString(16).padStart(2, "0")).join("")}`;
}
export function SupplyGraph({ data, width, height, focused, selectedId, selectedPath, collapsed, onSelect, onRecenter, onVisible }: {
  data: GraphPayload; width: number; height: number; focused: boolean; selectedId: string | null; selectedPath: GraphPath | null;
  collapsed: string[]; onSelect: (id: string) => void; onRecenter: (entity: SupplyEntity) => void; onVisible: (ids: string[]) => void;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const colors = useThemeColors(), desktop = !!useUiCapabilities().nativePaneChrome;
  const nodes = useMemo(() => graphNodes(data, collapsed, selectedPath), [data, collapsed, selectedPath]);
  const [pages, setPages] = useState<Record<number, number>>({});
  useEffect(() => setPages({}), [data]);
  const columns = [...new Set(nodes.map(node => node.column))].sort((a, b) => a - b);
  const cellWidth = Math.max(16, Math.floor(width / Math.max(columns.length, 1)));
  const plotWidth = Math.max(width, columns.length * cellWidth);
  const plotHeight = Math.max(6, height - 1);
  const capacity = Math.max(1, Math.floor((plotHeight - 3) / 3));
  const visible = columns.flatMap(column => {
    const peers = nodes.filter(node => node.column === column), start = ((pages[column] ?? 0) * capacity) % Math.max(1, peers.length);
    const page = peers.slice(start, start + capacity);
    const required = peers.find(node => selectedPath?.nodeIds.includes(node.entity.id));
    if (required && !page.includes(required)) page[page.length - 1] = required;
    return page;
  });
  const positioned = visible.map(node => {
    const peers = visible.filter(peer => peer.column === node.column), index = peers.findIndex(peer => peer.entity.id === node.entity.id);
    return { ...node, x: columns.indexOf(node.column) * cellWidth + 1, y: 2 + (peers.length === 1 ? Math.floor((plotHeight - 5) / 2) : index * 3) };
  });
  const positions = new Map(positioned.map(node => [node.entity.id, node]));
  useEffect(() => {
    const scroll = scrollRef.current, selected = positions.get(selectedId ?? data.entity?.id ?? "");
    if (!scroll || !selected) return;
    const viewportWidth = scroll.viewport?.width ?? width;
    const left = scroll.scrollLeft ?? 0;
    if (selected.x < left) scroll.scrollLeft = Math.max(0, selected.x - 1);
    else if (selected.x + cellWidth > left + viewportWidth) scroll.scrollLeft = selected.x + cellWidth - viewportWidth;
  }, [selectedId, data, cellWidth, width]);
  const pathLinks = new Set(selectedPath?.linkIds ?? []);
  const vectors: ChartVectorShape[] = data.links.flatMap(link => {
    const from = positions.get(link.from), to = positions.get(link.to);
    if (!from || !to) return [];
    const left = from.x <= to.x ? from : to, right = from.x <= to.x ? to : from;
    const highlighted = pathLinks.has(link.id);
    const tone = link.relationship === "commerce" ? (left.column < 0 ? TONES.upstream : TONES.downstream) : TONES.related;
    const opacity = selectedPath && !highlighted ? .15 : Math.max(.28, link.confidence);
    const start = left.x + cellWidth - 3, end = right.x - 1;
    return [{ id: link.id, color: blend(tone, colors.bg, opacity), strokeWidth: highlighted ? 3 : 1.2,
      points: Array.from({ length: 33 }, (_, i) => { const t = i / 32, smooth = t * t * (3 - 2 * t); return { x: (start + (end - start) * t) / plotWidth, y: (left.y + .5 + (right.y - left.y) * smooth) / plotHeight }; }) }];
  });
  const visibleIds = vectors.map(vector => vector.id).join("\n");
  useEffect(() => { onVisible(visibleIds ? visibleIds.split("\n") : []); }, [visibleIds, onVisible]);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, plotHeight);
  const vectorKey = JSON.stringify(vectors);
  const bitmap = useMemo(() => {
    if (desktop || !bitmapSize) return null;
    const { pixelWidth: w, pixelHeight: h } = bitmapSize;
    const pixels = new Uint8Array(w * h * 4); fillOpaque(pixels, parseHex(colors.bg));
    for (const vector of vectors) for (let i = 1; i < vector.points.length; i++) {
      const a = vector.points[i - 1]!, b = vector.points[i]!;
      drawLine(pixels, w, h, a.x * w, a.y * h, b.x * w, b.y * h, parseHex(vector.color), vector.strokeWidth ?? 1);
    }
    return { width: w, height: h, pixels };
  }, [desktop, bitmapSize, vectorKey, colors.bg]);
  const fallback = useMemo(() => {
    if (desktop) return [];
    const grid = Array.from({ length: plotHeight }, () => Array.from({ length: plotWidth }, () => ({ mask: 0, color: colors.textDim })));
    const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
    for (const vector of vectors) for (let p = 1; p < vector.points.length; p++) {
      const a = vector.points[p - 1]!, b = vector.points[p]!;
      const steps = Math.ceil(Math.max(Math.abs(b.x - a.x) * plotWidth * 2, Math.abs(b.y - a.y) * plotHeight * 4)) + 1;
      for (let i = 0; i <= steps; i++) {
        const px = Math.floor((a.x + (b.x - a.x) * i / steps) * plotWidth * 2), py = Math.floor((a.y + (b.y - a.y) * i / steps) * plotHeight * 4);
        const cell = grid[Math.floor(py / 4)]?.[Math.floor(px / 2)];
        if (cell && px >= 0 && py >= 0) { cell.mask |= bits[py % 4]![px % 2]!; cell.color = vector.color; }
      }
    }
    return grid.map(line => {
      const spans: { text: string; color: string }[] = [];
      for (const cell of line) { const char = cell.mask ? String.fromCharCode(0x2800 + cell.mask) : " "; if (spans.at(-1)?.color === cell.color) spans.at(-1)!.text += char; else spans.push({ text: char, color: cell.color }); }
      return spans;
    });
  }, [desktop, plotHeight, plotWidth, vectorKey, colors.textDim]);
  const pageColumn = positions.get(selectedId ?? "")?.column ?? columns.find(column => nodes.filter(node => node.column === column).length > capacity);
  const pageCount = pageColumn === undefined ? 1 : Math.ceil(nodes.filter(node => node.column === pageColumn).length / capacity);
  const advancePage = (column: number, delta: number) => {
    const peers = nodes.filter(node => node.column === column), count = Math.ceil(peers.length / capacity);
    const next = ((pages[column] ?? 0) + delta + count) % count;
    setPages(old => ({ ...old, [column]: next }));
    if (peers[next * capacity]) onSelect(peers[next * capacity]!.entity.id);
  };
  const page = (delta: number) => { if (pageColumn !== undefined) advancePage(pageColumn, delta); };
  usePaneStatusFooter({ registrationId: "supply-graph:paging", enabled: focused && pageCount > 1, hints: [
    { id: "previous-layer-page", key: "[", label: "previous companies", onPress: () => page(-1) },
    { id: "next-layer-page", key: "]", label: "next companies", onPress: () => page(1) },
  ] });
  useShortcut(event => {
    if (!focused || event.defaultPrevented || !visible.length) return;
    const index = Math.max(0, visible.findIndex(node => node.entity.id === selectedId));
    if (isPlainKey(event, "j", "down", "k", "up")) onSelect(visible[(index + (isPlainKey(event, "j", "down") ? 1 : -1) + visible.length) % visible.length]!.entity.id);
    else if (isPlainKey(event, "return", "enter")) onRecenter(visible[index]!.entity);
    else return;
    event.preventDefault(); event.stopPropagation();
  });
  return <ScrollBox ref={scrollRef} width={width} height={height} flexGrow={1} flexBasis={0} minHeight={0} scrollX scrollY focusable={false}>
    <Box width={plotWidth} height={plotHeight} flexShrink={0} position="relative">
      <ChartSurface width={plotWidth} height={plotHeight} position="absolute" top={0} left={0} vectors={desktop ? vectors : undefined} bitmap={bitmap} aria-label="Supply chain multi-hop graph">
        {!desktop ? fallback.map((spans, y) => <Text key={y}>{spans.map((span, i) => <Span key={i} fg={span.color}>{span.text}</Span>)}</Text>) : null}
      </ChartSurface>
      {columns.map((column, index) => <Box key={column} position="absolute" top={0} left={index * cellWidth + 1} width={cellWidth - 2}><Text fg={column < 0 ? TONES.upstream : column > 0 ? TONES.downstream : colors.textMuted}>{column < 0 ? `${-column} HOP${column === -1 ? "" : "S"}` : column > 0 ? `${column} HOP${column === 1 ? "" : "S"}` : "FOCUS"}</Text></Box>)}
      {columns.map((column, index) => {
        const count = nodes.filter(node => node.column === column).length;
        return count > capacity ? <Box key={`page:${column}`} position="absolute" top={plotHeight - 1} left={index * cellWidth + 1} width={cellWidth - 2}><ActionRow label="Next companies" onPress={() => advancePage(column, 1)} /></Box> : null;
      })}
      {positioned.map(node => <Box key={node.entity.id} position="absolute" left={node.x} top={node.y} width={cellWidth - 3} height={2} zIndex={10} flexDirection="column" backgroundColor={colors.bg} onMouseOver={() => onSelect(node.entity.id)}>
        <ActionRow label={truncateToDisplayWidth(`${collapsed.includes(node.entity.id) ? "+ " : ""}${entityLabel(node.entity)}`, cellWidth - 4)} active={node.entity.id === selectedId} fg={node.related ? TONES.related : node.column < 0 ? TONES.upstream : node.column > 0 ? TONES.downstream : colors.textBright} onPress={() => onRecenter(node.entity)}  />
        <Text fg={colors.textDim}>{truncateToDisplayWidth(node.hops ? `${node.hops}H · ${Math.round((node.path?.confidence ?? 0) * 100)}% · ${node.related ? (node.hops > 1 ? "via " : "") + (data.links.find(link => node.path?.linkIds.includes(link.id) && link.relationship !== "commerce")?.relationship ?? "related") : node.column < 0 ? "supplier" : "customer"}` : node.entity.name, cellWidth - 3)}</Text>
      </Box>)}
    </Box>
  </ScrollBox>;
}
