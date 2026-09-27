import { useShortcut } from "../../react/input";
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { scrollByLines } from "../../state/pane-scroll-registry";
import type { ScrollBoxRenderable } from "../../ui";
import { isPlainKey } from "../../utils/keyboard";
import {
  DataTableView,
  type DataTableKeyEvent,
  type DataTableViewProps,
} from "./view";
import { PageStackView, type DataTableColumn } from "../ui";

/**
 * Shorter than the pause a person takes before pressing Enter, longer than
 * the gap between two steps of a held key, so scrolling through a list never
 * fires it and settling on a row does.
 */
export const DETAIL_PREFETCH_REST_MS = 120;

export interface DataTableStackViewProps<
  T,
  C extends DataTableColumn = DataTableColumn,
> extends Omit<DataTableViewProps<T, C>, "focused"> {
  focused: boolean;
  detailOpen: boolean;
  onBack: () => void;
  detailContent: ReactNode;
  detailTitle?: string;
  onDetailKeyDown?: (event: DataTableKeyEvent) => boolean | void;
  /**
   * The open detail's scroll body, usually a `DetailScrollBody`. j/k and the
   * up/down arrows step it one line, where the pane scroll keys would move a
   * quarter page. `onDetailKeyDown` sees the key first.
   */
  detailScrollRef?: RefObject<ScrollBoxRenderable | null>;
  /**
   * Warms whatever the detail of `item` will need, once the cursor has rested
   * on it. Runs before Enter, so it must be free of side effects beyond
   * filling a cache: no read marking, no state that opens the detail. Called
   * again only when the cursor moves to another row.
   */
  prefetchDetail?: (item: T, index: number) => void;
}

export function DataTableStackView<
  T,
  C extends DataTableColumn = DataTableColumn,
>({
  focused,
  detailOpen,
  onBack,
  detailContent,
  detailTitle,
  keyboardNavigation = true,
  onDetailKeyDown,
  detailScrollRef,
  prefetchDetail,
  onCursorChange,
  ...tableProps
}: DataTableStackViewProps<T, C>) {
  useShortcut((event) => {
    if (!focused || !detailOpen || !keyboardNavigation) return;
    if (onDetailKeyDown?.(event) === true) {
      event.preventDefault();
      return;
    }
    const scrollBox = detailScrollRef?.current;
    const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
    if (!scrollBox || !delta) return;
    // Claimed at either end too, so the pane scroll keys never page it on.
    event.stopPropagation();
    event.preventDefault();
    scrollByLines(scrollBox, delta);
  });

  const prefetchRef = useRef(prefetchDetail);
  prefetchRef.current = prefetchDetail;
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRestTimer = useCallback(() => {
    if (restTimer.current) clearTimeout(restTimer.current);
    restTimer.current = null;
  }, []);
  useEffect(() => clearRestTimer, [clearRestTimer]);

  const handleCursorChange = useCallback<NonNullable<DataTableViewProps<T, C>["onCursorChange"]>>((item, index, reason) => {
    onCursorChange?.(item, index, reason);
    clearRestTimer();
    if (!prefetchRef.current) return;
    restTimer.current = setTimeout(() => {
      restTimer.current = null;
      prefetchRef.current?.(item, index);
    }, DETAIL_PREFETCH_REST_MS);
  }, [clearRestTimer, onCursorChange]);

  const rootContent = (
    <DataTableView<T, C>
      {...tableProps}
      focused={focused && !detailOpen}
      keyboardNavigation={keyboardNavigation}
      onCursorChange={handleCursorChange}
    />
  );

  return (
    <PageStackView
      focused={focused}
      detailOpen={detailOpen}
      onBack={onBack}
      rootContent={rootContent}
      detailContent={detailContent}
      detailTitle={detailTitle}
    />
  );
}
