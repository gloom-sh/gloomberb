import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../ui/host";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";
import { chromeRowPx } from "../../../../theme/font-scale";

export const TABLE_INLINE_PADDING_PX = 8;

/**
 * The header row is a chrome row, the same height as the pane header and the
 * query bar above it; body rows stay one text cell. Rows are positioned below
 * this offset, so scrolling by whole rows keeps them aligned under the header.
 */
export function tableHeaderPx(): number {
  return chromeRowPx();
}
export const CSS_BG = "var(--gloom-bg)";
export const CSS_PANEL = "var(--gloom-panel)";
export const CSS_TEXT = "var(--gloom-text)";
export const CSS_TEXT_DIM = "var(--gloom-text-dim)";
export const CSS_TEXT_BRIGHT = "var(--gloom-text-bright)";
export const CSS_SELECTED = "var(--gloom-selected)";
export const CSS_SELECTED_TEXT = "var(--gloom-selected-text)";

function hasAttribute(attributes: unknown, flag: number): boolean {
  return typeof attributes === "number" && (attributes & flag) !== 0;
}

export function cellTextStyle(
  color: string,
  attributes: number | undefined,
): CSSProperties {
  return {
    color,
    display: "inline-block",
    lineHeight: "var(--cell-h)",
    fontWeight: hasAttribute(attributes, TextAttributes.BOLD) ? 700 : undefined,
    fontStyle: hasAttribute(attributes, TextAttributes.ITALIC) ? "italic" : undefined,
    opacity: hasAttribute(attributes, TextAttributes.DIM) ? 0.65 : undefined,
    filter: hasAttribute(attributes, TextAttributes.INVERSE) ? "invert(1)" : undefined,
    textDecoration: [
      hasAttribute(attributes, TextAttributes.UNDERLINE) ? "underline" : "",
      hasAttribute(attributes, TextAttributes.STRIKETHROUGH)
        ? "line-through"
        : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    whiteSpace: "nowrap",
    overflow: "visible",
    textOverflow: "clip",
  };
}

export function clippedCellTextStyle(
  column: DataTableColumn,
  color: string,
  attributes: number | undefined,
): CSSProperties {
  return {
    ...cellTextStyle(color, attributes),
    display: "block",
    width: "100%",
    maxWidth: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    textAlign: column.align,
  };
}

export function toCellY(pixels: number): number {
  return Math.max(0, Math.round(pixels / WEB_CELL_HEIGHT));
}

export function toCellX(pixels: number): number {
  return Math.max(0, Math.round(pixels / WEB_CELL_WIDTH));
}

export function useScrollbarState(initialVisible: boolean) {
  const [visible, setVisible] = useState(initialVisible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const bar = useMemo(
    () => ({
      get visible() {
        return visibleRef.current;
      },
      set visible(nextVisible: boolean) {
        const normalized = nextVisible === true;
        visibleRef.current = normalized;
        setVisible(normalized);
      },
    }),
    [],
  );

  return { visible, bar };
}

export function useScrollBoxHandle(
  ref: RefObject<ScrollBoxRenderable | null>,
  elementRef: RefObject<HTMLDivElement | null>,
  horizontalScrollBar: { visible: boolean },
  verticalScrollBar: { visible: boolean },
  options: {
    headerOnly?: boolean;
    viewportTopInsetPx?: number;
  } = {},
) {
  useImperativeHandle(ref, () => ({
    get scrollTop() {
      if (options.headerOnly) return 0;
      return toCellY(elementRef.current?.scrollTop ?? 0);
    },
    set scrollTop(value: number) {
      if (options.headerOnly) return;
      const element = elementRef.current;
      if (!element) return;
      element.scrollTop = Math.max(0, value) * WEB_CELL_HEIGHT;
    },
    get scrollLeft() {
      return toCellX(elementRef.current?.scrollLeft ?? 0);
    },
    set scrollLeft(value: number) {
      const element = elementRef.current;
      if (!element) return;
      element.scrollLeft = Math.max(0, value) * WEB_CELL_WIDTH;
    },
    get scrollHeight() {
      const element = elementRef.current;
      if (!element) return 0;
      if (options.headerOnly) return 1;
      return toCellY(Math.max(0, element.scrollHeight - (options.viewportTopInsetPx ?? 0)));
    },
    get scrollWidth() {
      return toCellX(elementRef.current?.scrollWidth ?? 0);
    },
    get viewport() {
      const element = elementRef.current;
      if (options.headerOnly) {
        return {
          width: toCellX(element?.clientWidth ?? 0),
          height: 1,
        };
      }
      return {
        width: toCellX(element?.clientWidth ?? 0),
        height: Math.max(
          1,
          toCellY(Math.max(0, (element?.clientHeight ?? 0) - (options.viewportTopInsetPx ?? 0))),
        ),
      };
    },
    horizontalScrollBar,
    verticalScrollBar,
    scrollTo(target: number | { x?: number; y?: number }, y?: number) {
      const element = elementRef.current;
      if (!element) return;
      if (options.headerOnly) {
        if (typeof target === "number") {
          if (typeof y === "number") {
            element.scrollLeft = Math.max(0, y) * WEB_CELL_WIDTH;
          }
          return;
        }
        if (typeof target.x === "number") {
          element.scrollLeft = Math.max(0, target.x) * WEB_CELL_WIDTH;
        }
        return;
      }
      if (typeof target === "number") {
        element.scrollTop = Math.max(0, target) * WEB_CELL_HEIGHT;
        if (typeof y === "number") {
          element.scrollLeft = Math.max(0, y) * WEB_CELL_WIDTH;
        }
        return;
      }
      element.scrollTo({
        left: Math.max(0, target.x ?? toCellX(element.scrollLeft)) * WEB_CELL_WIDTH,
        top: Math.max(0, target.y ?? toCellY(element.scrollTop)) * WEB_CELL_HEIGHT,
      });
    },
  }), [
    elementRef,
    horizontalScrollBar,
    options.headerOnly,
    options.viewportTopInsetPx,
    ref,
    verticalScrollBar,
  ]);
}

export function eventWithCellCoordinates(event: MouseEvent<HTMLElement>) {
  const target = event.currentTarget;
  const rect = target.getBoundingClientRect();
  const preciseX = (event.clientX - rect.left) / WEB_CELL_WIDTH;
  const preciseY = (event.clientY - rect.top) / WEB_CELL_HEIGHT;
  return {
    detail: event.detail,
    button: event.button,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    x: Math.max(0, Math.floor(preciseX)),
    y: Math.max(0, Math.floor(preciseY)),
    preciseX: Math.max(0, preciseX),
    preciseY: Math.max(0, preciseY),
    pixelX: event.clientX,
    pixelY: event.clientY,
  };
}
