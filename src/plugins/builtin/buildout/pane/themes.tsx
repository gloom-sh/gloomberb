import { useId, useMemo } from "react";
import { MetricTreemapSurface, StatGrid, type MetricTreemapItem, type StatItem } from "../../../../components";
import { statGridWithin } from "../../../../components/ui/stat-grid";
import { useShortcut } from "../../../../react/input";
import { priceColor } from "../../../../theme/colors";
import { isPlainKey } from "../../../../utils/keyboard";
import { metricNumber, moneyAmount, text } from "../format";
import type { BuildoutList } from "../model/types";

/** The board leaves the table at least this many rows, and draws only when it has this many itself. */
const MIN_TABLE_ROWS = 8;
const MIN_BOARD_ROWS = 6;

/** The themes the board draws, largest first: the order the arrows step through. */
export function boardThemes(lists: readonly BuildoutList[]): BuildoutList[] {
  return lists
    .filter((list) => list.slug !== "all")
    .map((list, index) => ({ list, index, cap: moneyAmount(list.totalMarketCap) ?? 0 }))
    .sort((left, right) => right.cap - left.cap || left.index - right.index)
    .map(({ list }) => list);
}

/** The theme the board opens on: the one saved with the pane, else the largest. */
export function resolveBoardTheme(themes: readonly BuildoutList[], slug: string | null): BuildoutList | null {
  return themes.find((list) => list.slug === slug) ?? themes[0] ?? null;
}

/** Rows for the board in a Themes body of `height` rows; zero when the table needs them all. */
export function boardRows(height: number): number {
  const rows = Math.min(Math.floor(height * 0.46), height - MIN_TABLE_ROWS);
  return rows >= MIN_BOARD_ROWS ? rows : 0;
}

/**
 * Left and right step to the next theme by size, board or not; up and down
 * stay with the companies table. Ahead of the pane's tabs, which take left and
 * right as well; h and l still switch tabs.
 */
export function useThemeStepKeys({ themes, selectedSlug, enabled, onSelect }: {
  themes: readonly BuildoutList[];
  selectedSlug: string | null;
  enabled: boolean;
  onSelect: (list: BuildoutList) => void;
}) {
  const scope = useId();
  const index = Math.max(0, themes.findIndex((list) => list.slug === selectedSlug));
  useShortcut((event) => {
    if (!enabled || themes.length === 0) return;
    const step = isPlainKey(event, "left") ? -1 : isPlainKey(event, "right") ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(themes[(index + step + themes.length) % themes.length]!);
  }, { enabled, scope: `buildout-themes:${scope}` });
}

/** The selected theme in figures, between the board and its companies. */
function themeStatItems(list: BuildoutList | null): StatItem[] {
  if (!list) return [];
  const returnColor = metricNumber(list.avgReturn1y);
  const growthColor = metricNumber(list.avgSectorGrowth);
  return [
    { id: "theme", label: "Theme", value: list.name, detail: list.shortDescription ?? undefined, detailVariants: [""], wide: true },
    { id: "companies", label: "Companies", value: text(list.companyCount) },
    { id: "return", label: "1Y median", value: text(list.avgReturn1y), ...(returnColor == null ? {} : { color: priceColor(returnColor) }) },
    { id: "growth", label: "Growth", value: text(list.avgSectorGrowth), ...(growthColor == null ? {} : { color: priceColor(growthColor) }) },
    { id: "leaders", label: "Leaders", value: text(list.leaders) },
  ];
}

export function themeStatRows(list: BuildoutList | null, width: number): number {
  return statGridWithin(themeStatItems(list), width, 2).lines;
}

export function ThemeStats({ list, width }: { list: BuildoutList | null; width: number }) {
  const { items } = statGridWithin(themeStatItems(list), width, 2);
  return <StatGrid items={items} width={width} maxLines={2} />;
}

/**
 * The themes as a board: each tile sized by the theme's market value and
 * coloured by its companies' median one-year return.
 */
export function ThemeBoard({ themes, selectedSlug, width, height, onSelect }: {
  themes: readonly BuildoutList[];
  selectedSlug: string | null;
  width: number;
  height: number;
  onSelect: (list: BuildoutList) => void;
}) {
  const items = useMemo<MetricTreemapItem<BuildoutList>[]>(() => themes.map((list) => ({
    id: list.slug,
    label: list.name,
    weight: moneyAmount(list.totalMarketCap),
    colorValue: metricNumber(list.avgReturn1y),
    primaryText: list.avgReturn1y,
    tooltip: [list.name, `${text(list.avgReturn1y)} 1Y median · ${text(list.totalMarketCap)} · ${text(list.companyCount)} companies`],
    data: list,
  })), [themes]);
  return (
    <MetricTreemapSurface
      items={items}
      width={width}
      height={height}
      selectedId={selectedSlug}
      onSelect={(item) => onSelect(item.data)}
      emptyStateTitle="No themes"
    />
  );
}
