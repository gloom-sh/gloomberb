import { useCallback } from "react";
import { useShortcut, type KeyEventLike } from "../../react/input";
import { isPlainKey } from "../../utils/keyboard";
import {
  findMetricTreemapNeighbor,
  type FloatMetricTreemapTile,
  type MetricTreemapDirection,
  type MetricTreemapTile,
} from "./layout";

type TreemapTile<T> = MetricTreemapTile<T> | FloatMetricTreemapTile<T>;

export interface UseMetricTreemapNavigationOptions<T> {
  focused: boolean;
  scope?: string;
  tiles: readonly TreemapTile<T>[];
  itemCount: number;
  activeIndex: number;
  activeId: string | null;
  selectIndex: (index: number) => void;
  selectTile: (tile: TreemapTile<T>) => void;
  onActivate?: (shift: boolean) => void;
  vimHorizontal?: boolean;
  homeEndPage?: boolean;
  onExtraKey?: (event: KeyEventLike) => boolean;
}

export function useMetricTreemapNavigation<T>({
  focused,
  scope,
  tiles,
  itemCount,
  activeIndex,
  activeId,
  selectIndex,
  selectTile,
  onActivate,
  vimHorizontal = false,
  homeEndPage = false,
  onExtraKey,
}: UseMetricTreemapNavigationOptions<T>): void {
  const selectNeighbor = useCallback((direction: MetricTreemapDirection) => {
    const target = findMetricTreemapNeighbor(tiles, activeId, direction);
    if (target) selectTile(target);
  }, [activeId, selectTile, tiles]);

  useShortcut((event) => {
    if (!focused) return;
    if (onExtraKey?.(event)) return;
    const consume = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (homeEndPage && isPlainKey(event, "home", "end", "pageup", "pagedown")) {
      if (itemCount === 0) return;
      return consume(() => selectIndex(event.name === "home" || event.name === "pageup" ? 0 : itemCount - 1));
    }
    if (isPlainKey(event, "j")) {
      return consume(() => selectIndex(Math.min((activeIndex >= 0 ? activeIndex : 0) + 1, itemCount - 1)));
    }
    if (isPlainKey(event, "k")) {
      return consume(() => selectIndex(Math.max((activeIndex >= 0 ? activeIndex : 0) - 1, 0)));
    }
    if (vimHorizontal ? isPlainKey(event, "left", "h") : isPlainKey(event, "left")) {
      return consume(() => selectNeighbor("left"));
    }
    if (vimHorizontal ? isPlainKey(event, "right", "l") : isPlainKey(event, "right")) {
      return consume(() => selectNeighbor("right"));
    }
    if (isPlainKey(event, "up")) return consume(() => selectNeighbor("up"));
    if (isPlainKey(event, "down")) return consume(() => selectNeighbor("down"));
    if (
      onActivate
      && (event.name === "enter" || event.name === "return")
      && !event.ctrl
      && !event.meta
      && !event.super
      && !event.alt
    ) {
      if (event.shift && !homeEndPage) return;
      consume(() => onActivate(!!event.shift));
    }
  }, scope ? { enabled: focused, scope } : undefined);
}
