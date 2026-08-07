import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CommandBarRoute } from "../workflow/types";
import type { ListScreenState, ResultItem } from "./model";
import type { CommandBarListScrollEvent } from "./view";

interface CommandBarListNavigationOptions {
  activateListSelectionRef: RefObject<(options?: { secondary?: boolean; item?: ResultItem }) => void>;
  currentRouteRef: RefObject<CommandBarRoute | null>;
  markRootSelectionNavigated: () => void;
  setRootHoveredIdx: Dispatch<SetStateAction<number | null>>;
  setRootSelectedIdx: Dispatch<SetStateAction<number>>;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  visibleListStateRef: RefObject<ListScreenState | null>;
}

function clampListIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

export function useCommandBarListNavigation({
  activateListSelectionRef,
  currentRouteRef,
  markRootSelectionNavigated,
  setRootHoveredIdx,
  setRootSelectedIdx,
  setRouteStack,
  visibleListStateRef,
}: CommandBarListNavigationOptions) {
  const moveListSelection = useCallback((delta: number) => {
    const listState = visibleListStateRef.current;
    if (!listState || listState.results.length === 0 || delta === 0) return;
    const nextIndex = clampListIndex(listState.selectedIdx + delta, listState.results.length);
    const selectionChanged = nextIndex !== listState.selectedIdx;
    const hoverChanged = listState.hoveredIdx !== null;
    if (!selectionChanged && !hoverChanged) return;
    const nextListState = { ...listState, selectedIdx: nextIndex, hoveredIdx: null };
    visibleListStateRef.current = nextListState;

    if (!currentRouteRef.current) {
      markRootSelectionNavigated();
      setRootSelectedIdx((current) => (current === nextIndex ? current : nextIndex));
      setRootHoveredIdx((current) => (current === null ? current : null));
      return;
    }
    setRouteStack((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const top = next[next.length - 1];
      if (!top || (top.kind !== "mode" && top.kind !== "picker" && top.kind !== "pane-settings")) {
        return current;
      }
      if (top.selectedIdx === nextIndex && top.hoveredIdx === null) return current;
      next[next.length - 1] = { ...top, selectedIdx: nextIndex, hoveredIdx: null };
      return next;
    });
  }, [
    currentRouteRef,
    markRootSelectionNavigated,
    setRootHoveredIdx,
    setRootSelectedIdx,
    setRouteStack,
    visibleListStateRef,
  ]);

  const setHoveredIndex = useCallback((index: number | null) => {
    if (!currentRouteRef.current) {
      setRootHoveredIdx((current) => (current === index ? current : index));
      return;
    }
    setRouteStack((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const route = next[next.length - 1];
      if (!route) return current;
      if (route.kind === "mode" || route.kind === "picker" || route.kind === "pane-settings") {
        if (route.hoveredIdx === index) return current;
        next[next.length - 1] = { ...route, hoveredIdx: index };
        return next;
      }
      return current;
    });
  }, [currentRouteRef, setRootHoveredIdx, setRouteStack]);

  const handleListScroll = useCallback((event: CommandBarListScrollEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const direction = event.scroll?.direction;
    const delta = Math.max(1, Math.round(event.scroll?.delta ?? 1));
    setHoveredIndex(null);
    if (direction === "down" || direction === "right") {
      moveListSelection(delta);
    } else if (direction === "up" || direction === "left") {
      moveListSelection(-delta);
    }
  }, [moveListSelection, setHoveredIndex]);

  const handleListRowMouseDown = useCallback((event: any, item: ResultItem, globalIdx: number) => {
    event.stopPropagation?.();
    event.preventDefault?.();
    if (!currentRouteRef.current) {
      markRootSelectionNavigated();
      setRootSelectedIdx((current) => (current === globalIdx ? current : globalIdx));
    } else {
      setRouteStack((current) => {
        if (current.length === 0) return current;
        const next = [...current];
        const route = next[next.length - 1];
        if (!route || (route.kind !== "mode" && route.kind !== "picker" && route.kind !== "pane-settings")) {
          return current;
        }
        if (route.selectedIdx === globalIdx && route.hoveredIdx === globalIdx) return current;
        next[next.length - 1] = { ...route, selectedIdx: globalIdx, hoveredIdx: globalIdx };
        return next;
      });
    }
    activateListSelectionRef.current?.({ item });
  }, [
    activateListSelectionRef,
    currentRouteRef,
    markRootSelectionNavigated,
    setRootSelectedIdx,
    setRouteStack,
  ]);

  return {
    handleListRowMouseDown,
    handleListScroll,
    moveListSelection,
    setHoveredIndex,
  };
}
