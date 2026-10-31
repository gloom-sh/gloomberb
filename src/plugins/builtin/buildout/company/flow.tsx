import { useMemo, useRef, useState } from "react";
import type { ChartVectorShape } from "../../../../ui/host";
import { Box, ChartSurface, Span, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import { BADGE_TINT, ClippedText, NATIVE_BADGE_STYLE } from "../../../../components/ui/display";
import { cardSurfaceStyle } from "../../../../components/ui/card";
import { useShortcut } from "../../../../react/input";
import { blendHex } from "../../../../theme/colors";
import { SERIES_COLORS } from "../../../../theme/series-colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { displayWidth } from "../../../../utils/format";
import { isPlainKey } from "../../../../utils/keyboard";
import { ribbonY } from "../../supply-chain/flow-layout";
import type { BuildoutCompanyProfile, BuildoutRelation, RelationRole } from "./model";

/** Power and hosting gold, then the supply chain's own supplier, customer and competitor colours. */
const RELATION_COLORS: Record<RelationRole, string> = {
  power: SERIES_COLORS[2]!,
  supplier: SERIES_COLORS[0]!,
  customer: SERIES_COLORS[1]!,
  competitor: SERIES_COLORS[5]!,
};

const GROUP_LABELS: Record<RelationRole, string> = { power: "Power", supplier: "Suppliers", customer: "Customers", competitor: "Competitors" };
const CARD_ROWS = 2;
const LINK_STEPS = 40;
const CHIP_LABEL_CELLS = 13;
/** Below this the columns and the ribbons between them do not fit; the flow reads as a list. */
export const FLOW_MIN_WIDTH = 64;

interface Rect { x: number; y: number; width: number; height: number }
interface FlowCard extends Rect { relation: BuildoutRelation }
interface FlowHeader { role: RelationRole; x: number; y: number }
interface FlowMore { role: RelationRole; x: number; y: number; hidden: number }
interface FlowLink { id: string; role: RelationRole; x0: number; y0: number; x1: number; y1: number }
interface FlowChip { relation: BuildoutRelation | null; label: string; x: number; width: number }

export interface FlowGeometry {
  center: Rect;
  cards: FlowCard[];
  headers: FlowHeader[];
  more: FlowMore[];
  links: FlowLink[];
  chips: FlowChip[];
  chipRow: number | null;
}

interface Group { role: RelationRole; items: BuildoutRelation[]; page: number }

/** Rows a column of groups takes with `counts` cards each. */
function columnRows(groups: readonly Group[], counts: readonly number[], gap: number): number {
  return groups.reduce((sum, group, index) => {
    if (!group.items.length) return sum;
    const shown = counts[index]!;
    return sum + (sum ? 1 : 0) + 1 + shown * CARD_ROWS + Math.max(0, shown - 1) * gap + (shown < group.items.length ? 1 : 0);
  }, 0);
}

/** Places a column's groups in `rows`, the last group giving up cards first, centred when there is room. */
function placeColumn(groups: readonly Group[], x: number, width: number, rows: number) {
  const cards: FlowCard[] = [];
  const headers: FlowHeader[] = [];
  const more: FlowMore[] = [];
  for (const gap of [1, 0]) {
    const counts = groups.map((group) => group.items.length);
    while (columnRows(groups, counts, gap) > rows) {
      let index = -1;
      for (let i = counts.length - 1; i >= 0; i--) if (counts[i]! > 1) { index = i; break; }
      if (index < 0) break;
      counts[index]!--;
    }
    const used = columnRows(groups, counts, gap);
    if (used > rows && gap === 1) continue;
    let y = Math.max(0, Math.floor((rows - used) / 2));
    let first = true;
    groups.forEach((group, index) => {
      if (!group.items.length) return;
      if (!first) y += 1;
      first = false;
      headers.push({ role: group.role, x, y });
      y += 1;
      const shown = counts[index]!;
      const pages = Math.max(1, Math.ceil(group.items.length / Math.max(1, shown)));
      const start = shown < group.items.length ? (group.page % pages) * shown : 0;
      group.items.slice(start, start + shown).forEach((relation, offset) => {
        cards.push({ relation, x, y, width, height: CARD_ROWS });
        y += CARD_ROWS + (offset < shown - 1 ? gap : 0);
      });
      if (shown < group.items.length) {
        more.push({ role: group.role, x, y, hidden: group.items.length - shown });
        y += 1;
      }
    });
    break;
  }
  return { cards, headers, more };
}

/**
 * Power and hosting deals and suppliers on the left, customers on the right,
 * the company between them with a line from every card to its edge, in card
 * order so no two cross; competitors as chips on the last row.
 */
function flowGeometry(profile: BuildoutCompanyProfile, width: number, height: number, focusLabel: string, pages: Partial<Record<RelationRole, number>>): FlowGeometry {
  const of = (role: RelationRole) => profile.relations.filter((relation) => relation.role === role);
  const competitors = of("competitor");
  const chipRow = competitors.length ? height - 1 : null;
  const rows = Math.max(CARD_ROWS + 1, (chipRow ?? height) - (chipRow === null ? 0 : 1));
  const cardWidth = Math.max(18, Math.min(38, Math.floor(width * (width < 110 ? 0.31 : 0.27))));
  const left = placeColumn([{ role: "power", items: of("power"), page: pages.power ?? 0 }, { role: "supplier", items: of("supplier"), page: pages.supplier ?? 0 }], 1, cardWidth, rows);
  const right = placeColumn([{ role: "customer", items: of("customer"), page: pages.customer ?? 0 }], width - cardWidth - 1, cardWidth, rows);
  const centerWidth = Math.max(12, Math.min(26, displayWidth(focusLabel) + 6));
  const centerHeight = Math.max(3, Math.min(9, Math.floor(rows * 0.4)));
  const center = { x: Math.floor((width - centerWidth) / 2), y: Math.floor((rows - centerHeight) / 2), width: centerWidth, height: centerHeight };
  const links: FlowLink[] = [];
  const leftCards = left.cards;
  leftCards.forEach((card, index) => links.push({
    id: `${card.relation.role}:${card.relation.id}`, role: card.relation.role,
    x0: card.x + card.width, y0: card.y + 1, x1: center.x, y1: center.y + (center.height * (index + 0.5)) / leftCards.length,
  }));
  right.cards.forEach((card, index) => links.push({
    id: `${card.relation.role}:${card.relation.id}`, role: card.relation.role,
    x0: center.x + center.width, y0: center.y + (center.height * (index + 0.5)) / right.cards.length, x1: card.x, y1: card.y + 1,
  }));
  // Competitors as chips while they fit, then "+N more".
  const chips: FlowChip[] = [];
  let x = CHIP_LABEL_CELLS + 1;
  for (const [index, relation] of competitors.entries()) {
    const label = relation.ticker ?? relation.name;
    const chipWidth = Math.min(22, displayWidth(label) + 2);
    const rest = competitors.length - index - 1;
    if (x + chipWidth + (rest ? 11 : 0) > width - 1) {
      chips.push({ relation: null, label: `+${competitors.length - index} more`, x, width: displayWidth(`+${competitors.length - index} more`) + 2 });
      break;
    }
    chips.push({ relation, label, x, width: chipWidth });
    x += chipWidth + 1;
  }
  return {
    center,
    cards: [...left.cards, ...right.cards],
    headers: [...left.headers, ...right.headers],
    more: [...left.more, ...right.more],
    links,
    chips,
    chipRow,
  };
}

const linkId = (relation: BuildoutRelation) => `${relation.role}:${relation.id}`;

export function CompanyFlow({ profile, width, height, focused, onOpen }: {
  profile: BuildoutCompanyProfile;
  width: number;
  height: number;
  focused: boolean;
  onOpen: (relation: BuildoutRelation) => void;
}) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const [pages, setPages] = useState<Partial<Record<RelationRole, number>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const surfaceRef = useRef<{ x: number; y: number; absoluteX?: number; absoluteY?: number } | null>(null);
  const focusLabel = profile.ticker ?? profile.name;
  const geometry = useMemo(() => flowGeometry(profile, width, height, focusLabel, pages), [focusLabel, height, pages, profile, width]);
  const { cards, links, center } = geometry;
  const selectable = useMemo(() => [...cards.map((card) => card.relation), ...geometry.chips.flatMap((chip) => chip.relation ? [chip.relation] : [])], [cards, geometry.chips]);
  const selectedIndex = Math.max(0, selectable.findIndex((relation) => linkId(relation) === selectedId));
  const selected = selectable[selectedIndex] ? linkId(selectable[selectedIndex]!) : null;
  const active = hovered ?? (focused ? selected : null);
  const focusTint = blendHex(colors.bg, colors.textBright, 0.55);

  useShortcut((event) => {
    if (!focused || event.defaultPrevented || selectable.length === 0) return;
    if (isPlainKey(event, "j", "down") || isPlainKey(event, "k", "up")) {
      const step = isPlainKey(event, "j", "down") ? 1 : -1;
      setSelectedId(linkId(selectable[(selectedIndex + step + selectable.length) % selectable.length]!));
    } else if (isPlainKey(event, "return", "enter")) onOpen(selectable[selectedIndex]!);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  const linkColors = (link: FlowLink) => link.x0 < center.x ? [RELATION_COLORS[link.role], focusTint] : [focusTint, RELATION_COLORS[link.role]];
  const vectors = useMemo<ChartVectorShape[]>(() => links.map((link) => ({
    id: link.id,
    points: Array.from({ length: LINK_STEPS + 1 }, (_, step) => {
      const x = link.x0 + (link.x1 - link.x0) * step / LINK_STEPS;
      return { x: x / width, y: ribbonY(link, x) / height };
    }),
    color: RELATION_COLORS[link.role],
    gradient: linkColors(link),
    strokeWidth: active === link.id ? 2.4 : 1.4,
    opacity: active && active !== link.id ? 0.3 : active === link.id ? 1 : 0.75,
  })), [active, height, links, width, focusTint, center.x]);

  // The terminal draws the same curves in braille, each coloured from its card to the company.
  const braille = useMemo(() => {
    if (desktop) return null;
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ mask: 0, color: colors.textDim })));
    const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
    for (const link of links) {
      const [from, to] = linkColors(link);
      for (let dx = Math.ceil(link.x0 * 2); dx < Math.floor(link.x1 * 2); dx++) {
        const x = (dx + 0.5) / 2;
        const t = (x - link.x0) / Math.max(1e-6, link.x1 - link.x0);
        const dy = Math.round(ribbonY(link, x) * 4 - 0.5);
        const cell = grid[Math.floor(dy / 4)]?.[Math.floor(dx / 2)];
        if (!cell || dy < 0) continue;
        cell.mask |= bits[dy % 4]![dx % 2]!;
        const color = blendHex(from!, to!, t);
        cell.color = active === link.id ? color : blendHex(colors.bg, color, 0.75);
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
  }, [active, colors.bg, colors.textDim, desktop, height, links, width, focusTint, center.x]);

  /** The line under the pointer comes forward. */
  const hoverAt = (event: { preciseX?: number; preciseY?: number; x: number; y: number }) => {
    const origin = surfaceRef.current;
    if (!origin) return;
    const x = (event.preciseX ?? event.x) - (origin.absoluteX ?? origin.x);
    const y = (event.preciseY ?? event.y) - (origin.absoluteY ?? origin.y);
    let best: { id: string; distance: number } | null = null;
    for (const link of links) {
      if (x < link.x0 || x > link.x1) continue;
      const distance = Math.abs(ribbonY(link, x) - y);
      if (distance < 0.7 && (!best || distance < best.distance)) best = { id: link.id, distance };
    }
    const next = best?.id ?? null;
    if (next !== hovered) setHovered(next);
  };

  return (
    <Box width={width} height={height} flexGrow={1} flexBasis={0} minHeight={0} position="relative" overflow="hidden">
      <ChartSurface ref={surfaceRef} width={width} height={height} position="absolute" left={0} top={0}
        vectors={desktop ? vectors : undefined} flexDirection="column"
        onMouseMove={hoverAt} onMouseOut={() => setHovered(null)}
        onMouseDown={() => { const card = hovered ? cards.find((entry) => linkId(entry.relation) === hovered) : null; if (card) onOpen(card.relation); }}
        aria-label={`${profile.name} power, suppliers and customers`}>
        {braille ? braille.map((spans, y) => <Text key={y}>{spans.map((span, i) => <Span key={i} fg={span.color}>{span.text}</Span>)}</Text>) : null}
      </ChartSurface>
      {geometry.headers.map((header) => (
        <Box key={header.role} position="absolute" left={header.x} top={header.y} width={20} height={1}>
          <Text fg={RELATION_COLORS[header.role]} attributes={TextAttributes.BOLD}>{GROUP_LABELS[header.role]}</Text>
        </Box>
      ))}
      <FocusCard profile={profile} label={focusLabel} rect={center} desktop={desktop} />
      {cards.map((card) => (
        <RelationCard key={linkId(card.relation)} card={card} desktop={desktop} active={active === linkId(card.relation)}
          onPress={() => { setSelectedId(linkId(card.relation)); onOpen(card.relation); }}
          onHover={(on) => setHovered(on ? linkId(card.relation) : null)} />
      ))}
      {geometry.more.map((entry) => (
        <Box key={`more:${entry.role}`} position="absolute" left={entry.x} top={entry.y} width={20} height={1}
          onMouseDown={() => setPages((current) => ({ ...current, [entry.role]: (current[entry.role] ?? 0) + 1 }))}
          style={desktop ? { cursor: "pointer" } : undefined} role="button" aria-label={`Show ${entry.hidden} more ${GROUP_LABELS[entry.role].toLowerCase()}`}>
          <Text fg={colors.textDim}>{`+${entry.hidden} more`}</Text>
        </Box>
      ))}
      {geometry.chipRow !== null ? (
        <Box position="absolute" left={1} top={geometry.chipRow} width={CHIP_LABEL_CELLS} height={1}>
          <Text fg={RELATION_COLORS.competitor}>Competitors</Text>
        </Box>
      ) : null}
      {geometry.chipRow !== null ? geometry.chips.map((chip) => (
        <CompetitorChip key={chip.label} chip={chip} row={geometry.chipRow!} desktop={desktop}
          active={!!chip.relation && active === linkId(chip.relation)} onPress={() => { if (chip.relation) onOpen(chip.relation); }} />
      )) : null}
    </Box>
  );
}

function FocusCard({ profile, label, rect, desktop }: { profile: BuildoutCompanyProfile; label: string; rect: Rect; desktop: boolean }) {
  const colors = useThemeColors();
  const showName = profile.name && profile.name.toUpperCase() !== label.toUpperCase() && rect.height >= (desktop ? 3 : 4);
  return (
    <Box position="absolute" left={rect.x} top={rect.y} width={rect.width} height={rect.height} flexDirection="column" alignItems="center" justifyContent="center"
      border={!desktop} borderStyle="rounded" borderColor={colors.textMuted}
      style={desktop ? cardSurfaceStyle({ padding: "0" }) : undefined}>
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{label}</Text>
      {showName ? <ClippedText fg={colors.textDim} text={profile.name} width={rect.width - 4} /> : null}
    </Box>
  );
}

function RelationCard({ card, desktop, active, onPress, onHover }: {
  card: FlowCard; desktop: boolean; active: boolean; onPress: () => void; onHover: (on: boolean) => void;
}) {
  const colors = useThemeColors();
  const { relation } = card;
  const accent = RELATION_COLORS[relation.role];
  const inner = Math.max(4, card.width - 2);
  const nameWidth = Math.max(4, inner - (relation.ticker ? displayWidth(relation.ticker) + 1 : 0));
  const listed = !!relation.ticker;
  return (
    <Box position="absolute" left={card.x} top={card.y} width={card.width} height={card.height} flexDirection="column"
      backgroundColor={desktop ? undefined : active ? colors.selected : blendHex(colors.bg, accent, 0.12)}
      style={desktop ? { ...cardSurfaceStyle({ selected: active, accent, padding: "0 var(--gloom-space-sm)" }), cursor: "pointer" } : undefined}
      onMouseDown={onPress} onMouseOver={() => onHover(true)} onMouseOut={() => onHover(false)}
      data-gloom-role="buildout-flow-card" role="button" aria-label={`Open ${relation.name}`}>
      <Box flexDirection="row" height={1} overflow="hidden" style={desktop ? { flexWrap: "wrap" } : undefined}>
        {!desktop ? <Text fg={accent}>▍</Text> : null}
        <ClippedText fg={active && !desktop ? colors.selectedText : listed ? colors.textBright : colors.text}
          attributes={listed ? TextAttributes.BOLD : 0} text={relation.name} width={nameWidth} />
        {relation.ticker && (desktop || displayWidth(relation.name) + displayWidth(relation.ticker) + 1 <= inner)
          ? <Text fg={colors.textDim} style={desktop ? { flex: "0 0 auto" } : undefined}>{` ${relation.ticker}`}</Text> : null}
      </Box>
      {relation.figure ? (
        <Box height={1} paddingLeft={desktop ? 0 : 1} overflow="hidden">
          <ClippedText fg={active && !desktop ? colors.selectedText : colors.textDim} text={relation.figure} width={inner - (desktop ? 0 : 1)} />
        </Box>
      ) : null}
    </Box>
  );
}

function CompetitorChip({ chip, row, desktop, active, onPress }: { chip: FlowChip; row: number; desktop: boolean; active: boolean; onPress: () => void }) {
  const colors = useThemeColors();
  const accent = RELATION_COLORS.competitor;
  const more = !chip.relation;
  const background = desktop
    ? active ? accent : more ? undefined : blendHex(colors.bg, accent, BADGE_TINT)
    : active ? blendHex(colors.bg, accent, 0.45) : more ? undefined : blendHex(colors.bg, accent, 0.14);
  const text = <ClippedText fg={more ? colors.textDim : active ? desktop ? colors.bg : colors.textBright : accent} text={chip.label} width={chip.width - 2} />;
  return (
    <Box position="absolute" left={chip.x} top={row} width={chip.width} height={1} justifyContent={desktop ? "center" : undefined}
      onMouseDown={onPress} role="button" aria-label={chip.relation ? `Open ${chip.relation.name}` : chip.label}>
      {desktop
        ? <Box paddingX={1} minWidth={0} backgroundColor={background} justifyContent="center" style={{ ...NATIVE_BADGE_STYLE, cursor: more ? undefined : "pointer" }}>{text}</Box>
        : <Box paddingX={1} height={1} backgroundColor={background}>{text}</Box>}
    </Box>
  );
}

/** The flow as a list, for a pane too narrow for columns: each group under its name. */
export function CompanyFlowList({ profile, width, onOpen }: { profile: BuildoutCompanyProfile; width: number; onOpen: (relation: BuildoutRelation) => void }) {
  const colors = useThemeColors();
  const roles: RelationRole[] = ["power", "customer", "supplier", "competitor"];
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {roles.map((role) => {
        const items = profile.relations.filter((relation) => relation.role === role);
        if (!items.length) return null;
        return (
          <Box key={role} flexDirection="column" marginBottom={1}>
            <Text fg={RELATION_COLORS[role]} attributes={TextAttributes.BOLD}>{GROUP_LABELS[role]}</Text>
            {items.map((relation) => (
              <Box key={linkId(relation)} flexDirection="column" onMouseDown={() => onOpen(relation)}>
                <ClippedText fg={relation.ticker ? colors.textBright : colors.text} text={`${relation.name}${relation.ticker ? ` ${relation.ticker}` : ""}`} width={width - 2} />
                {relation.figure ? <ClippedText fg={colors.textDim} text={relation.figure} width={width - 2} /> : null}
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
