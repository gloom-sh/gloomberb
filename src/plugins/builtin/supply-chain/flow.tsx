import type { ChartVectorShape } from "../../../ui/host";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import { Box, ChartSurface, Span, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { fillOpaque, fillRect, parseHex } from "../../../components/chart/native/raster/primitives";
import { counterpartyKind, counterpartyLabel, disclosedValue, dollars, nativeValue, roleLabel, ROLE_COLORS, scopeWords, shareParts, type FlowBand } from "./model";
import { flowChipLabel, flowGeometry, RELATED_LABEL_CELLS, ribbonY, type FlowRibbon, type PositionedNode } from "./flow-layout";
import { evidenceDate, evidenceLabel, trustTier } from "./trust";

const RIBBON_STEPS = 48;
const reportedRow = (row: SupplyRow) => trustTier(row) === 4 || trustTier(row) === 5;
const dashVisible = (t: number) => (Math.max(0, Math.min(1, t)) * RIBBON_STEPS) % 6 <= 4;
const ROLE_PLURAL: Record<SupplyRole, string> = { supplier: "Suppliers", customer: "Customers", partner: "Partners", competitor: "Competitors", investee: "Investees" };

/** A ribbon's outline in the overlay's 0..1 space: the upper edge out, the lower edge back. */
function ribbonPolygon(ribbon: FlowRibbon, width: number, height: number, thickness: number) {
  const xs = Array.from({ length: RIBBON_STEPS + 1 }, (_, i) => ribbon.x0 + (ribbon.x1 - ribbon.x0) * i / RIBBON_STEPS);
  const upper = xs.map((x) => ({ x: x / width, y: (ribbonY(ribbon, x) - thickness / 2) / height }));
  const lower = xs.map((x) => ({ x: x / width, y: (ribbonY(ribbon, x) + thickness / 2) / height })).reverse();
  return [...upper, ...lower];
}

/** The disclosed figure a card shows under the name, in the reporting company's own terms. */
function nodeMetric(node: PositionedNode, focusId?: string): string {
  const row = node.row!;
  if (trustTier(row) !== 1) return `${evidenceLabel(row)} · ${evidenceDate(row)}`;
  if (node.weight !== null && node.weightBasis === "usd") return dollars(row);
  const share = shareParts(row, focusId);
  if (share) return `${share.value} ${share.basis}`;
  if (nativeValue(row) !== null || row.usd !== null) return disclosedValue(row);
  // With no figure, the card says where the relationship is disclosed.
  const reporter = focusId && row.reportingEntity.id !== focusId ? `${row.reportingEntity.ticker ?? row.reportingEntity.name} ` : "";
  return `${evidenceLabel(row)} · ${reporter}${row.form ?? "filing"}${row.fiscalYear ? ` · FY${row.fiscalYear}` : ""}`;
}

/**
 * Suppliers flow in from the left and customers out to the right of the
 * focus company. Ribbon width follows a disclosed share or dollar figure on
 * one comparable scale per column; a relationship without one is a hairline.
 * Hover or select a ribbon or card to bring it forward; click to open the
 * counterparty. The desktop draws SVG ribbons and real cards; the terminal
 * draws the same geometry in braille with aligned text.
 */
export function SupplyFlow({ rows, symbol, focusName, focusId, width, height, focused, selectedId, onSelect, onOpen, onVisible }: {
  rows: SupplyRow[]; symbol: string; focusName?: string | null; focusId?: string; width: number; height: number; focused: boolean;
  selectedId: string | null; onSelect: (id: string) => void; onOpen: (row: SupplyRow) => void; onVisible: (ids: string[]) => void;
}) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const bitmapSize = useStaticChartBitmapSize(width, height);
  const [pages, setPages] = useState<Partial<Record<FlowBand, number>>>({});
  const [relatedPages, setRelatedPages] = useState<Partial<Record<SupplyRole, number>>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const surfaceRef = useRef<{ x: number; y: number; absoluteX?: number; absoluteY?: number } | null>(null);
  const focusLabel = focusName && displayWidth(focusName) <= 22 ? focusName : symbol;
  const geometry = useMemo(() => flowGeometry(rows, { width, height, focusId, focusLabelWidth: Math.max(symbol.length, displayWidth(focusLabel)), pages, relatedPages }),
    [rows, width, height, focusId, symbol, focusLabel, pages, relatedPages]);
  const { nodes, ribbons, center } = geometry;
  const reportedIds = useMemo(() => new Set(nodes.filter((node) => node.row && reportedRow(node.row)).map((node) => node.id)), [nodes]);
  const visibleIds = nodes.filter((node) => node.row).map((node) => node.id).join("\n");
  useEffect(() => { onVisible(visibleIds ? visibleIds.split("\n") : []); }, [visibleIds, onVisible]);
  const selectedIndex = Math.max(0, nodes.findIndex((node) => node.id === selectedId));
  const selected = nodes[selectedIndex]?.id ?? null;
  const active = hovered ?? selected;
  const focusTint = blendHex(colors.bg, colors.textBright, 0.55);
  const selectNode = (node: PositionedNode) => {
    if (node.more && node.band === "related" && node.role) setRelatedPages((old) => ({ ...old, [node.role!]: (old[node.role!] ?? 0) + 1 }));
    else if (node.more) setPages((old) => ({ ...old, [node.band]: (old[node.band] ?? 0) + 1 }));
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

  const ribbonColors = (ribbon: FlowRibbon) => ribbon.band === "suppliers" ? [ROLE_COLORS[ribbon.role], focusTint] : [focusTint, ROLE_COLORS[ribbon.role]];
  const vectors = useMemo<ChartVectorShape[]>(() => ribbons.flatMap((ribbon): ChartVectorShape[] => {
    const lit = active === ribbon.id;
    const dim = hovered !== null && !lit;
    if (ribbon.thickness === null) {
      const vector: ChartVectorShape = { id: ribbon.id, points: Array.from({ length: RIBBON_STEPS + 1 }, (_, i) => {
        const x = ribbon.x0 + (ribbon.x1 - ribbon.x0) * i / RIBBON_STEPS;
        return { x: x / width, y: ribbonY(ribbon, x) / height };
      }), color: ROLE_COLORS[ribbon.role], gradient: ribbonColors(ribbon), strokeWidth: lit ? 2.4 : 1.4, opacity: dim ? 0.25 : lit ? 1 : 0.7 };
      if (!reportedIds.has(ribbon.id)) return [vector];
      // Use the same gaps in SVG, bitmap and braille; reported links are always hairlines.
      const [from, to] = ribbonColors(ribbon);
      return Array.from({ length: 8 }, (_, index) => ({ ...vector, id: `${ribbon.id}:dash:${index}`,
        points: vector.points.slice(index * 6, index * 6 + 5),
        gradient: [blendHex(from!, to!, index * 6 / RIBBON_STEPS), blendHex(from!, to!, (index * 6 + 4) / RIBBON_STEPS)] }));
    }
    return [{ id: ribbon.id, points: ribbonPolygon(ribbon, width, height, ribbon.thickness), color: ROLE_COLORS[ribbon.role], fill: true,
      gradient: ribbonColors(ribbon), fillOpacity: lit ? 0.9 : 0.6, opacity: dim ? 0.3 : 1 }];
  }), [ribbons, reportedIds, active, hovered, width, height, focusTint]);

  // The terminal's native graphics: the same ribbons filled column by column.
  const bitmap = useMemo(() => {
    if (desktop || !bitmapSize) return null;
    const { pixelWidth: w, pixelHeight: h } = bitmapSize;
    const sx = w / width, sy = h / height;
    const pixels = new Uint8Array(w * h * 4); fillOpaque(pixels, parseHex(colors.bg));
    for (const ribbon of ribbons) {
      const [from, to] = ribbonColors(ribbon);
      for (let px = Math.round(ribbon.x0 * sx); px <= Math.round(ribbon.x1 * sx); px++) {
        const x = px / sx, t = (x - ribbon.x0) / Math.max(1e-6, ribbon.x1 - ribbon.x0);
        if (reportedIds.has(ribbon.id) && !dashVisible(t)) continue;
        const half = ribbon.thickness === null ? 0.6 / sy : ribbon.thickness / 2;
        const y = ribbonY(ribbon, x);
        fillRect(pixels, w, h, px, (y - half) * sy, px, (y + half) * sy, parseHex(blendHex(from!, to!, t), active === ribbon.id ? 0.95 : 0.7));
      }
    }
    return { width: w, height: h, pixels };
  }, [desktop, bitmapSize, ribbons, reportedIds, colors.bg, width, height, active, focusTint]);

  // Braille fallback: a filled band per ribbon, coloured along its length from the role to the focus company.
  const fallback = useMemo(() => {
    if (desktop || bitmap) return null;
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ mask: 0, color: colors.textDim })));
    const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
    for (const ribbon of ribbons) {
      const [from, to] = ribbonColors(ribbon);
      const lit = active === ribbon.id;
      for (let dx = Math.ceil(ribbon.x0 * 2); dx < Math.floor(ribbon.x1 * 2); dx++) {
        const x = (dx + 0.5) / 2, t = (x - ribbon.x0) / Math.max(1e-6, ribbon.x1 - ribbon.x0);
        if (reportedIds.has(ribbon.id) && !dashVisible(t)) continue;
        const y = ribbonY(ribbon, x);
        const half = ribbon.thickness === null ? 0 : ribbon.thickness / 2;
        const color = blendHex(from!, to!, t);
        for (let dy = Math.round((y - half) * 4 - 0.5); dy <= Math.round((y + half) * 4 - 0.5); dy++) {
          const cell = grid[Math.floor(dy / 4)]?.[Math.floor(dx / 2)];
          if (!cell || dy < 0) continue;
          cell.mask |= bits[dy % 4]![dx % 2]!;
          cell.color = ribbon.thickness === null && !lit ? blendHex(colors.bg, color, 0.75) : color;
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
  }, [desktop, bitmap, width, height, ribbons, reportedIds, colors.textDim, colors.bg, active, focusTint]);

  /** Hovering a ribbon brings it forward; the nearest one under the pointer wins. */
  const hoverAt = (event: { preciseX?: number; preciseY?: number; x: number; y: number }) => {
    const origin = surfaceRef.current;
    if (!origin) return;
    const x = (event.preciseX ?? event.x) - (origin.absoluteX ?? origin.x), y = (event.preciseY ?? event.y) - (origin.absoluteY ?? origin.y);
    let best: { id: string; distance: number } | null = null;
    for (const ribbon of ribbons) {
      if (x < ribbon.x0 || x > ribbon.x1) continue;
      const distance = Math.abs(ribbonY(ribbon, x) - y) - (ribbon.thickness ?? 0) / 2;
      if (distance < 0.6 && (!best || distance < best.distance)) best = { id: ribbon.id, distance };
    }
    const next = best?.id ?? null;
    if (next !== hovered) setHovered(next);
  };

  const hoveredNode = hovered ? nodes.find((node) => node.id === hovered && node.row) : null;
  const legend = flowLegend(geometry, symbol);
  const header = (band: "suppliers" | "customers", x: number) => {
    const role: SupplyRole = band === "suppliers" ? "supplier" : "customer";
    return <Box position="absolute" top={geometry.headerRow} left={x} width={geometry.cardWidth}>
      <Text fg={ROLE_COLORS[role]} attributes={TextAttributes.BOLD}>{band === "suppliers" ? "Suppliers" : "Customers"}</Text>
    </Box>;
  };
  const hasBand = (band: "suppliers" | "customers") => nodes.some((node) => node.band === band);
  return <Box width={width} height={height} flexGrow={1} flexBasis={0} minHeight={0} position="relative" overflow="hidden">
    <ChartSurface ref={surfaceRef} width={width} height={height} position="absolute" left={0} top={0}
      vectors={desktop ? vectors : undefined} bitmap={bitmap} flexDirection="column" aria-label="Supply chain flow"
      onMouseMove={hoverAt} onMouseOut={() => setHovered(null)}
      onMouseDown={() => { const node = hovered ? nodes.find((entry) => entry.id === hovered) : null; if (node) selectNode(node); }}>
      {fallback ? fallback.map((spans, y) => <Text key={y}>{spans.map((span, i) => <Span key={i} fg={span.color}>{span.text}</Span>)}</Text>) : null}
    </ChartSurface>
    {header("suppliers", 1)}
    {header("customers", width - geometry.cardWidth - 1)}
    {!hasBand("suppliers") ? <Box position="absolute" top={center.y + 1} left={1}><Text fg={colors.textMuted}>None disclosed</Text></Box> : null}
    {!hasBand("customers") ? <Box position="absolute" top={center.y + 1} left={width - geometry.cardWidth - 1}><Text fg={colors.textMuted}>None disclosed</Text></Box> : null}
    <FocusCard symbol={symbol} name={focusName ?? null} {...center} desktop={desktop} />
    {nodes.filter((node) => node.band !== "related").map((node) => <FlowCard key={node.id} node={node} focusId={focusId} desktop={desktop}
      active={active === node.id} onPress={() => selectNode(node)} onHover={(on) => setHovered(on ? node.id : null)} />)}
    {geometry.related.map((row) => <Box key={row.role} position="absolute" top={row.y} left={1} width={RELATED_LABEL_CELLS}>
      <Text fg={ROLE_COLORS[row.role]}>{ROLE_PLURAL[row.role]}</Text>
    </Box>)}
    {geometry.related.flatMap((row) => row.chips).map((node) => <FlowChip key={node.id} node={node} desktop={desktop} active={active === node.id}
      onPress={() => selectNode(node)} onHover={(on) => setHovered(on ? node.id : null)} />)}
    {geometry.groupRow !== null ? <Box position="absolute" top={geometry.groupRow} left={1} width={width - 2} flexDirection="row" overflow="hidden">
      <Box width={RELATED_LABEL_CELLS} flexShrink={0}><Text fg={colors.textDim}>Groups</Text></Box>
      <Text fg={colors.textDim}>{truncateToDisplayWidth(geometry.groups.map((row) => {
        const share = shareParts(row, focusId);
        return `${counterpartyLabel(row)}${share ? ` ${share.value} ${share.basis}` : ""}`;
      }).join("  ·  "), width - RELATED_LABEL_CELLS - 3)}</Text>
    </Box> : null}
    {legend ? <Box position="absolute" top={geometry.legendRow} left={1} width={width - 2} flexDirection="row" gap={2} overflow="hidden">
      {legend.map((entry) => <Box key={entry.id} flexDirection="row" gap={1} flexShrink={0}>
        <LegendSwatch kind={entry.kind} desktop={desktop} />
        <Text fg={colors.textDim}>{entry.label}</Text>
      </Box>)}
    </Box> : null}
    {hoveredNode && hoveredNode.band !== "related" ? <FlowTooltip node={hoveredNode} focusId={focusId} width={width} desktop={desktop} anchor={tooltipAnchor(hoveredNode, ribbons, width)} /> : null}
  </Box>;
}

function tooltipAnchor(node: PositionedNode, ribbons: readonly FlowRibbon[], width: number) {
  const ribbon = ribbons.find((entry) => entry.id === node.id);
  const x = ribbon ? (ribbon.x0 + ribbon.x1) / 2 : node.x + node.width / 2;
  const y = ribbon ? ribbonY(ribbon, x) : node.y;
  return { x: Math.max(1, Math.min(width - 40, Math.round(x - 19))), y: Math.round(y) + 1 };
}

function flowLegend(geometry: ReturnType<typeof flowGeometry>, symbol: string): { id: string; kind: "weighted" | "hairline" | "reported"; label: string }[] | null {
  const entries: { id: string; kind: "weighted" | "hairline" | "reported"; label: string }[] = [];
  const { suppliers, customers, scope } = geometry.scale;
  if (customers === "revenue") entries.push({ id: "customers", kind: "weighted", label: `customers: share of ${symbol}${scope ? ` ${scopeWords(scope)}` : ""} revenue` });
  else if (customers === "usd") entries.push({ id: "customers", kind: "weighted", label: "customers: disclosed USD" });
  if (suppliers === "usd") entries.push({ id: "suppliers", kind: "weighted", label: "suppliers: disclosed USD" });
  else if (suppliers === "revenue") entries.push({ id: "suppliers", kind: "weighted", label: `suppliers: share of ${symbol} revenue` });
  const reported = new Set(geometry.nodes.filter((node) => node.row && reportedRow(node.row)).map((node) => node.id));
  if (geometry.ribbons.some((ribbon) => ribbon.thickness === null && !reported.has(ribbon.id))) entries.push({ id: "hairline", kind: "hairline", label: "no comparable figure" });
  if (reported.size) entries.push({ id: "reported", kind: "reported", label: "reported" });
  return entries.length ? entries : null;
}

function LegendSwatch({ kind, desktop }: { kind: "weighted" | "hairline" | "reported"; desktop: boolean }) {
  const colors = useThemeColors();
  if (!desktop) return <Text fg={colors.textMuted}>{kind === "weighted" ? "━━" : kind === "reported" ? "╌╌" : "──"}</Text>;
  return <Box width={2} height={1} justifyContent="center">
    <Box style={kind === "reported" ? { height: 0, borderTop: `1px dashed ${colors.textMuted}` } : { height: kind === "weighted" ? "7px" : "1px", borderRadius: kind === "weighted" ? "2px" : 0,
      background: `linear-gradient(90deg, ${colors.textMuted}, ${colors.textDim})` }} />
  </Box>;
}

function FocusCard({ symbol, name, x, y, width, height, desktop }: { symbol: string; name: string | null; x: number; y: number; width: number; height: number; desktop: boolean }) {
  const colors = useThemeColors();
  // The terminal's border takes two rows; the name shows only when the symbol keeps its own.
  const showName = !!name && name.toUpperCase() !== symbol.toUpperCase() && height >= (desktop ? 3 : 4);
  return <Box position="absolute" left={x} top={y} width={width} height={height} flexDirection="column" alignItems="center" justifyContent="center"
    backgroundColor={desktop ? colors.panel : undefined} border={!desktop} borderStyle="rounded" borderColor={colors.textMuted}
    style={desktop ? { border: `1px solid ${blendHex(colors.bg, colors.textBright, 0.35)}`, borderRadius: 6, boxShadow: `0 0 0 3px ${blendHex(colors.bg, colors.textBright, 0.06)}` } : undefined}>
    <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{symbol}</Text>
    {showName ? <Text fg={colors.textDim}>{truncateToDisplayWidth(name!, width - 4)}</Text> : null}
  </Box>;
}

function FlowCard({ node, focusId, desktop, active, onPress, onHover }: {
  node: PositionedNode; focusId?: string; desktop: boolean; active: boolean; onPress: () => void; onHover: (on: boolean) => void;
}) {
  const colors = useThemeColors();
  const role = node.role;
  const accent = role ? ROLE_COLORS[role] : colors.textMuted;
  const company = node.row ? counterpartyKind(node.row) === "company" : false;
  const name = node.more ? `+${node.more} more` : node.row ? counterpartyLabel(node.row) : node.label;
  const metric = node.row ? nodeMetric(node, focusId) : "";
  const ticker = node.row?.counterparty.ticker ?? null;
  const inner = Math.max(4, node.width - (desktop ? 2 : 2));
  const nameWidth = Math.max(4, inner - (ticker ? displayWidth(ticker) + 1 : 0));
  const titleColor = node.more ? colors.textDim : company ? colors.textBright : colors.text;
  return <Box position="absolute" left={node.x} top={node.y} width={node.width} height={node.more ? 1 : node.height} flexDirection="column"
    backgroundColor={node.more ? undefined : active ? desktop ? blendHex(colors.bg, accent, 0.2) : colors.selected : blendHex(colors.bg, accent, desktop ? 0.09 : 0.12)}
    style={desktop ? { borderLeft: `3px ${node.more ? "dotted" : "solid"} ${node.more ? blendHex(colors.bg, accent, 0.5) : accent}`, borderRadius: 3, paddingLeft: 6, cursor: "pointer",
      boxShadow: active ? `inset 0 0 0 1px ${blendHex(colors.bg, accent, 0.6)}` : undefined } : undefined}
    onMouseDown={onPress} onMouseOver={() => onHover(true)} onMouseOut={() => onHover(false)} data-gloom-role="supply-flow-node">
    <Box flexDirection="row" height={1} overflow="hidden">
      {!desktop ? <Text fg={node.more ? colors.textMuted : accent}>▍</Text> : null}
      <Text fg={active && !desktop ? colors.selectedText : titleColor} attributes={company ? TextAttributes.BOLD : 0}>{truncateToDisplayWidth(name, nameWidth)}</Text>
      {ticker && displayWidth(name) + displayWidth(ticker) + 1 <= inner ? <Text fg={colors.textDim}>{` ${ticker}`}</Text> : null}
    </Box>
    {metric ? <Box height={1} paddingLeft={desktop ? 0 : 1} overflow="hidden">
      <Text fg={active && !desktop ? colors.selectedText : colors.textDim}>{truncateToDisplayWidth(metric, inner - (desktop ? 0 : 1))}</Text>
    </Box> : null}
  </Box>;
}

function FlowChip({ node, desktop, active, onPress, onHover }: { node: PositionedNode; desktop: boolean; active: boolean; onPress: () => void; onHover: (on: boolean) => void }) {
  const colors = useThemeColors();
  const accent = node.role ? ROLE_COLORS[node.role] : colors.textMuted;
  const label = truncateToDisplayWidth(flowChipLabel(node), node.width - 2);
  const background = active ? blendHex(colors.bg, accent, desktop ? 0.32 : 0.45) : node.more ? undefined : blendHex(colors.bg, accent, 0.14);
  const text = <Text fg={node.more ? colors.textDim : active ? colors.textBright : accent}>{label}</Text>;
  return <Box position="absolute" left={node.x} top={node.y} width={node.width} height={1} justifyContent={desktop ? "center" : undefined}
    onMouseDown={onPress} onMouseOver={() => onHover(true)} onMouseOut={() => onHover(false)} data-gloom-role="supply-flow-chip">
    {/* The desktop chip leaves a hairline of row above and below, like ticker chips. */}
    {desktop ? <Box paddingX={1} backgroundColor={background} justifyContent="center" style={{ height: "calc(100% - 4px)", borderRadius: 3, cursor: "pointer" }}>{text}</Box>
      : <Box paddingX={1} height={1} backgroundColor={background}>{text}</Box>}
  </Box>;
}

/** What the hovered relationship is: the figure and its denominator, the period and the filing. */
function FlowTooltip({ node, focusId, width, desktop, anchor }: { node: PositionedNode; focusId?: string; width: number; desktop: boolean; anchor: { x: number; y: number } }) {
  const colors = useThemeColors();
  const row = node.row!;
  const share = shareParts(row, focusId);
  const lines = [
    share ? `${share.value} ${share.basis}` : nativeValue(row) !== null || row.usd !== null ? disclosedValue(row) : "No figure disclosed",
    `${roleLabel(row.role)} · ${row.period}`,
    trustTier(row) === 1
      ? `${evidenceLabel(row)} · ${row.reportingEntity.ticker ?? row.reportingEntity.name} ${row.form ?? "filing"}${row.filedDate ? ` filed ${row.filedDate}` : ""}`
      : `${evidenceLabel(row)} · ${evidenceDate(row)}`,
  ];
  const tooltipWidth = Math.min(width - 2, Math.max(28, ...lines.map((line) => displayWidth(line) + 4), displayWidth(counterpartyLabel(row)) + 4));
  return <Box position="absolute" left={Math.max(1, Math.min(width - tooltipWidth - 1, anchor.x))} top={anchor.y} width={tooltipWidth} height={lines.length + 1}
    flexDirection="column" paddingX={1} backgroundColor={colors.panel} border={!desktop} borderColor={ROLE_COLORS[row.role]}
    style={desktop ? { border: `1px solid ${blendHex(colors.bg, ROLE_COLORS[row.role], 0.7)}`, borderRadius: 4, boxShadow: "0 6px 18px rgba(0,0,0,0.45)", zIndex: 20, pointerEvents: "none" } : undefined}
    data-gloom-role="supply-flow-tooltip">
    <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{truncateToDisplayWidth(counterpartyLabel(row), tooltipWidth - 2)}</Text>
    {lines.map((line, index) => <Text key={index} fg={index === 0 ? colors.text : colors.textDim}>{truncateToDisplayWidth(line, tooltipWidth - 2)}</Text>)}
  </Box>;
}
