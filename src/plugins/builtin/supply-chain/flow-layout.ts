import type { SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import { displayWidth } from "../../../utils/format";
import { flowBands, flowGroups, type FlowBand, type FlowNode } from "./model";

/** A node card or a related chip, in pane cells. */
export interface PositionedNode extends FlowNode { x: number; y: number; width: number; height: number; role: SupplyRole | null }

/**
 * One ribbon from a node's edge to the focus card's edge, in pane cells. The
 * thickness is in rows and is null for a relationship with no comparable
 * figure, which draws as a hairline.
 */
export interface FlowRibbon { id: string; band: "suppliers" | "customers"; x0: number; y0: number; x1: number; y1: number; thickness: number | null; role: SupplyRole }

interface FlowRelatedRow { role: SupplyRole; y: number; chips: PositionedNode[]; total: number }

export interface FlowGeometry {
  center: { x: number; y: number; width: number; height: number };
  /** Supplier and customer cards, then related chips, in keyboard order. */
  nodes: PositionedNode[];
  ribbons: FlowRibbon[];
  related: FlowRelatedRow[];
  groups: SupplyRow[];
  groupRow: number | null;
  headerRow: number;
  legendRow: number;
  /** What sets ribbon widths in each column, when any ribbon there has a figure. */
  scale: { suppliers: "revenue" | "usd" | null; customers: "revenue" | "usd" | null; scope: string | null };
  cardWidth: number;
}

const CARD_ROWS = 2;
const MAX_CARDS = 12;
const MAX_CARD_GAP = 2;
const RELATED_ROLES: SupplyRole[] = ["partner", "competitor", "investee"];
/** The thickest ribbon stays inside its two-row card. */
const MAX_RIBBON_ROWS = 1.5;
export const RELATED_LABEL_CELLS = 13;

/** The curve every ribbon follows: horizontal at both ends, eased between. */
export function ribbonY(ribbon: Pick<FlowRibbon, "x0" | "y0" | "x1" | "y1">, x: number): number {
  const t = ribbon.x1 === ribbon.x0 ? 0 : Math.max(0, Math.min(1, (x - ribbon.x0) / (ribbon.x1 - ribbon.x0)));
  return ribbon.y0 + (ribbon.y1 - ribbon.y0) * t * t * (3 - 2 * t);
}

/** Width in rows, proportional to the figure on its column's scale, so two ribbons compare exactly. */
const ribbonRows = (weight: number | null) => weight === null ? null : weight * MAX_RIBBON_ROWS;

const chipLabel = (node: FlowNode) => node.more ? `+${node.more} more` : node.row?.counterparty.ticker ?? node.label;
const chipWidth = (node: FlowNode) => Math.min(24, displayWidth(chipLabel(node)) + 2);
export { chipLabel as flowChipLabel };

/**
 * Where everything in the flow sits for a pane size: supplier cards on the
 * left, customers on the right, the focus card between them with every ribbon
 * ending on its edge in node order (so ribbons never cross), and the
 * partners, competitors, investees and cohort groups in a band underneath.
 */
export function flowGeometry(rows: readonly SupplyRow[], options: {
  width: number; height: number; focusId?: string; focusLabelWidth: number;
  pages?: Partial<Record<FlowBand, number>>; relatedPages?: Partial<Record<SupplyRole, number>>;
}): FlowGeometry {
  const { width, height } = options;
  const all = flowBands([...rows], Number.MAX_SAFE_INTEGER, {}, options.focusId);
  const relatedRoles = RELATED_ROLES.filter((role) => all.related.some((node) => node.row?.role === role));
  const groups = flowGroups(rows);
  const bandRows = relatedRoles.length + (groups.length ? 1 : 0);
  const legendRow = height - 1;
  const bandTop = legendRow - bandRows - (bandRows ? 1 : 0);
  const headerRow = 0;
  const plotTop = 1, plotRows = Math.max(CARD_ROWS, bandTop - plotTop);
  // As many cards as fit with a row between them (up to a dozen a side), packed tight only when the pane is short.
  const spaced = Math.floor((plotRows + 1) / (CARD_ROWS + 1));
  const limit = Math.max(2, Math.min(MAX_CARDS, spaced >= 3 ? spaced : Math.floor(plotRows / CARD_ROWS)));
  const bands = flowBands([...rows], limit, options.pages ?? {}, options.focusId);
  const longest = Math.max(bands.suppliers.length, bands.customers.length, 1);
  // A tall pane spreads the cards rather than leaving a band of empty rows above and below them.
  const gap = longest < 2 ? 0 : Math.max(spaced >= 3 ? 1 : 0, Math.min(MAX_CARD_GAP, Math.floor((plotRows - longest * CARD_ROWS) / (longest - 1))));
  const cardWidth = Math.max(16, Math.min(40, Math.floor(width * (width < 120 ? 0.28 : 0.24))));
  const centerWidth = Math.max(12, Math.min(26, options.focusLabelWidth + 4));
  const centerHeight = Math.max(3, Math.min(16, Math.floor(plotRows * 0.45)));
  const center = { x: Math.floor((width - centerWidth) / 2), y: plotTop + Math.floor((plotRows - centerHeight) / 2), width: centerWidth, height: centerHeight };
  const nodes: PositionedNode[] = [];
  const ribbons: FlowRibbon[] = [];
  for (const band of ["suppliers", "customers"] as const) {
    const entries = bands[band];
    const stack = entries.length * CARD_ROWS + Math.max(0, entries.length - 1) * gap;
    const top = plotTop + Math.max(0, Math.floor((plotRows - stack) / 2));
    const x = band === "suppliers" ? 1 : width - cardWidth - 1;
    const drawn = entries.filter((node) => node.row);
    entries.forEach((node, index) => {
      const y = top + index * (CARD_ROWS + gap);
      nodes.push({ ...node, x, y, width: cardWidth, height: CARD_ROWS, role: node.row?.role ?? null });
      const order = drawn.indexOf(node);
      if (!node.row || order < 0) return;
      // Ribbons meet the focus card in the order their cards stand, spread over its edge.
      const end = center.y + (center.height * (order + 0.5)) / drawn.length;
      const edge = y + CARD_ROWS / 2;
      ribbons.push(band === "suppliers"
        ? { id: node.id, band, x0: x + cardWidth, y0: edge, x1: center.x, y1: end, thickness: ribbonRows(node.weight), role: node.row.role }
        : { id: node.id, band, x0: center.x + center.width, y0: end, x1: x, y1: edge, thickness: ribbonRows(node.weight), role: node.row.role });
    });
  }
  const related: FlowRelatedRow[] = relatedRoles.map((role, index) => {
    const members = all.related.filter((node) => node.row?.role === role);
    const room = width - RELATED_LABEL_CELLS - 2;
    const fit = (count: number) => members.slice(0, count).reduce((sum, node) => sum + chipWidth(node) + 1, 0);
    let count = members.length;
    while (count > 0 && fit(count) + (count < members.length ? 11 : 0) > room) count--;
    const pageSize = Math.max(1, count);
    const pages = Math.max(1, Math.ceil(members.length / pageSize));
    const start = count < members.length ? ((options.relatedPages?.[role] ?? 0) % pages) * pageSize : 0;
    const shown = members.slice(start, start + pageSize);
    const y = bandTop + 1 + index;
    let x = RELATED_LABEL_CELLS + 1;
    const chips: PositionedNode[] = shown.map((node) => {
      const chip = { ...node, id: node.id, band: "related" as const, x, y, width: chipWidth(node), height: 1, role };
      x += chip.width + 1;
      return chip;
    });
    if (shown.length < members.length) {
      const more: FlowNode = { id: `more:related:${role}`, label: "", row: null, band: "related", more: members.length - shown.length, weight: null, weightScope: null, weightBasis: null };
      chips.push({ ...more, x, y, width: chipWidth(more), height: 1, role });
    }
    return { role, y, chips, total: members.length };
  });
  nodes.push(...related.flatMap((row) => row.chips));
  const basis = (band: "suppliers" | "customers") => bands[band].some((node) => node.weight !== null) ? bands[band].find((node) => node.weightBasis)?.weightBasis ?? null : null;
  return {
    center, nodes, ribbons, related, groups, groupRow: groups.length ? bandTop + 1 + relatedRoles.length : null, headerRow, legendRow, cardWidth,
    scale: { suppliers: basis("suppliers"), customers: basis("customers"), scope: bands.customers.find((node) => node.weightScope)?.weightScope ?? null },
  };
}
