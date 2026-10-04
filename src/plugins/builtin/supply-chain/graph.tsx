import { useEffect, useMemo, useRef, useState } from "react";
import { ActionRow, Badge, Button, usePaneStatusFooter } from "../../../components";
import { Box, ChartSurface, ScrollBox, Span, Text, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import type { ChartVectorShape } from "../../../ui/host";
import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import type { SupplyEntity, SupplyRole } from "../../../api-client/supply-chain";
import { useThemeColors } from "../../../theme/theme-context";
import { useShortcut } from "../../../react/input";
import { useScrollBoxLayout } from "../../../components/use-scrollbox-layout";
import { isPlainKey } from "../../../utils/keyboard";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import { entityLabel, graphNodes } from "./graph-model";
import { ROLE_COLORS } from "./model";
import { blendHex } from "../../../theme/colors";

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
  const cellWidth = Math.max(24, Math.floor(width / Math.max(columns.length, 1)));
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
  const revealSelected = () => {
    const scroll = scrollRef.current, selected = positions.get(selectedId ?? data.entity?.id ?? "");
    if (!scroll || !selected) return;
    const viewportWidth = scroll.viewport?.width ?? width;
    const left = scroll.scrollLeft ?? 0;
    if (selected.x < left) scroll.scrollLeft = Math.max(0, selected.x - 1);
    else if (selected.x + cellWidth > left + viewportWidth) scroll.scrollLeft = selected.x + cellWidth - viewportWidth;
  };
  useEffect(revealSelected, [selectedId, data, cellWidth, width]);
  useScrollBoxLayout(scrollRef, revealSelected);
  const pathLinks = new Set(selectedPath?.linkIds ?? []);
  const vectors: ChartVectorShape[] = data.links.flatMap(link => {
    const from = positions.get(link.from), to = positions.get(link.to);
    if (!from || !to) return [];
    const left = from.x <= to.x ? from : to, right = from.x <= to.x ? to : from;
    const highlighted = pathLinks.has(link.id);
    const tone = ROLE_COLORS[link.relationship === "commerce" ? (left.column < 0 ? "supplier" : "customer") : link.relationship];
    const opacity = selectedPath && !highlighted ? .15 : Math.max(.28, link.confidence);
    const start = left.x + cellWidth - 3, end = right.x;
    return [{ id: link.id, color: blendHex(colors.bg, tone, opacity), strokeWidth: highlighted ? 3 : 1.2,
      points: Array.from({ length: 33 }, (_, i) => { const t = i / 32, smooth = t * t * (3 - 2 * t); return { x: (start + (end - start) * t) / plotWidth, y: (left.y + 1 + (right.y - left.y) * smooth) / plotHeight }; }) }];
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
      {columns.map((column, index) => <Box key={column} position="absolute" top={0} left={index * cellWidth + 1} width={cellWidth - 2}><Text fg={column < 0 ? ROLE_COLORS.supplier : column > 0 ? ROLE_COLORS.customer : colors.textMuted}>{column < 0 ? `${-column} HOP${column === -1 ? "" : "S"}` : column > 0 ? `${column} HOP${column === 1 ? "" : "S"}` : "FOCUS"}</Text></Box>)}
      {columns.map((column, index) => {
        const count = nodes.filter(node => node.column === column).length;
        return count > capacity ? <Box key={`page:${column}`} position="absolute" top={plotHeight - 1} left={index * cellWidth + 1} width={cellWidth - 2}><ActionRow label="Next companies" onPress={() => advancePage(column, 1)} /></Box> : null;
      })}
      {positioned.map(node => {
        const relationship = data.links.find(link => node.path?.linkIds.includes(link.id) && link.relationship !== "commerce")?.relationship;
        const role: SupplyRole | null = !node.hops ? null : node.related && relationship && relationship !== "commerce" ? relationship : node.column < 0 ? "supplier" : "customer";
        const accent = role ? ROLE_COLORS[role] : colors.textMuted;
        const active = node.entity.id === selectedId, company = !node.entity.aggregate && !node.entity.anonymous;
        const kind = node.entity.aggregate ? "group" : node.entity.anonymous ? "undisclosed" : null;
        const inner = cellWidth - 5;
        const tickerWidth = node.entity.ticker ? displayWidth(node.entity.ticker) + 3 : 0;
        const showTicker = company && tickerWidth > 0 && inner >= tickerWidth + 5;
        const prefix = collapsed.includes(node.entity.id) ? "+ " : "";
        const name = truncateToDisplayWidth(prefix + (showTicker ? node.entity.name : entityLabel(node.entity)), inner - (showTicker ? tickerWidth : 0));
        const relation = kind ?? (node.related ? `${node.hops > 1 ? "via " : ""}${role}` : role);
        const confidence = `${Math.round((node.path?.confidence ?? 0) * 100)}%`;
        const detail = node.hops ? `${node.hops}H · ${relation}${inner >= displayWidth(relation ?? "") + 12 ? ` · ${confidence}` : ""}` : showTicker ? "Focus company" : node.entity.name;
        return <Box key={node.entity.id} position="absolute" left={node.x} top={node.y} width={cellWidth - 3} height={2} zIndex={10} flexDirection="column" overflow="hidden"
          backgroundColor={active ? desktop ? blendHex(colors.bg, accent, 0.2) : colors.selected : node.hops ? blendHex(colors.bg, accent, desktop ? 0.09 : 0.12) : colors.panel}
          style={desktop ? { borderLeft: role ? `3px solid ${accent}` : undefined, border: role ? undefined : `1px solid ${blendHex(colors.bg, colors.textBright, 0.35)}`,
            borderRadius: role ? 3 : 6, paddingLeft: 6, cursor: "pointer", boxShadow: active ? `inset 0 0 0 1px ${blendHex(colors.bg, accent, 0.6)}` : undefined } : undefined}
          onMouseOver={() => onSelect(node.entity.id)} data-gloom-role="supply-graph-node">
          <Button label={`${prefix}${entityLabel(node.entity)}`} title={node.entity.name} variant="plain" compact flush stopPropagation height={2} width={cellWidth - (desktop ? 5 : 3)} onPress={() => onRecenter(node.entity)}>
            <Box flexDirection="column" width="100%">
              <Box flexDirection="row" height={1} gap={desktop ? 1 : 0} overflow="hidden">
                {!desktop ? <Text fg={accent}>▍</Text> : null}
                <Text fg={active && !desktop ? colors.selectedText : company ? colors.textBright : colors.textDim} attributes={company ? TextAttributes.BOLD : 0}>{name}</Text>
                {showTicker ? desktop ? <Badge label={node.entity.ticker!} tone="accent" /> : <Text fg={active ? colors.selectedText : colors.textDim}>{` ${node.entity.ticker}`}</Text> : null}
              </Box>
              <Box height={1} paddingLeft={desktop ? 0 : 1} overflow="hidden"><Text fg={active && !desktop ? colors.selectedText : colors.textDim}>{truncateToDisplayWidth(detail, inner)}</Text></Box>
            </Box>
          </Button>
        </Box>;
      })}
    </Box>
  </ScrollBox>;
}
