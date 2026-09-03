import { createElement, forwardRef, useCallback, useRef, type ComponentProps, type ForwardedRef } from "react";
import { useForwardedScrollBoxRef, useRegisterPaneScrollBox } from "../state/pane-scroll-registry";
import { useUiHost, type UiHost } from "./host";
import { useRemoteUiNode } from "../remote/semantic-tree";
import {
  remoteChartEvent,
  remoteEvent,
  remoteMetadataFromProps,
  remoteNumberValue,
  remotePropLabel,
  remotePropRole,
  remoteStringValue,
} from "../remote/semantic-helpers";
export {
  RGBA,
  StyledText,
  TextAttributes,
  UiHostProvider,
  useCommandBarShortcut,
  useNativeRenderer,
  useRendererHost,
  useSyntaxStyleFactory,
  useUiCapabilities,
  useUiHost,
} from "./host";
export {
  ContextMenuProvider,
  compactContextMenuItems,
  editableTextContextMenuItems,
  linkContextMenuItems,
  tickerContextMenuItems,
  useContextMenu,
  useTickerContextMenu,
} from "./context-menu";
export { contextMenuDivider } from "../types/context-menu";
export type {
  BitmapSurface,
  BoxRenderable,
  ChartSurfaceProps,
  HostCheckboxProps,
  HostPopoverProps,
  Highlight,
  ImageSurfaceProps,
  MediaSurfaceHandle,
  MediaSurfaceProps,
  InputRenderable,
  NativeCursorState,
  NativeRendererHost,
  NativePostProcessFn,
  PixelResolution,
  RendererHost,
  ScrollBoxRenderable,
  SyntaxStyleLike,
  TextareaRenderable,
} from "./host";

export const Box = forwardRef<any, ComponentProps<UiHost["Box"]>>((props, ref) => {
  const { Box: HostBox } = useUiHost();
  const rawProps = props as Record<string, unknown>;
  const onMouseDown = rawProps.onMouseDown as ((event?: unknown) => unknown) | undefined;
  const onMouseUp = rawProps.onMouseUp as ((event?: unknown) => unknown) | undefined;
  const onContextMenu = rawProps.onContextMenu as ((event?: unknown) => unknown) | undefined;
  const remoteNodeId = useRemoteUiNode(
    onMouseDown || onMouseUp || onContextMenu
      ? {
        role: remotePropRole(rawProps, "box"),
        label: remotePropLabel(rawProps),
        actions: {
          press: onMouseDown ? (input) => onMouseDown(remoteEvent(input)) : undefined,
          release: onMouseUp ? (input) => onMouseUp(remoteEvent(input)) : undefined,
          contextMenu: onContextMenu ? (input) => onContextMenu(remoteEvent(input)) : undefined,
        },
        metadata: {
          width: rawProps.width,
          height: rawProps.height,
        },
      }
      : null,
  );
  return createElement(HostBox as any, { ...props, ref, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
Box.displayName = "Box";

export const Text = forwardRef<any, ComponentProps<UiHost["Text"]>>((props, ref) => {
  const { Text: HostText } = useUiHost();
  const rawProps = props as Record<string, unknown>;
  const onMouseDown = rawProps.onMouseDown as ((event?: unknown) => unknown) | undefined;
  const label = remotePropLabel(rawProps)
    ?? (typeof rawProps.children === "string" ? rawProps.children : undefined)
    ?? (typeof rawProps.content === "string" ? rawProps.content : undefined);
  const remoteNodeId = useRemoteUiNode(
    onMouseDown
      ? {
        role: remotePropRole(rawProps, "text"),
        label,
        actions: {
          press: (input) => onMouseDown(remoteEvent(input)),
        },
      }
      : null,
  );
  return createElement(HostText as any, { ...props, ref, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
Text.displayName = "Text";

export const Span = forwardRef<any, ComponentProps<UiHost["Span"]>>((props, ref) => {
  const { Span: HostSpan } = useUiHost();
  return createElement(HostSpan as any, { ...props, ref });
});
Span.displayName = "Span";

export const Strong = forwardRef<any, ComponentProps<UiHost["Strong"]>>((props, ref) => {
  const { Strong: HostStrong } = useUiHost();
  return createElement(HostStrong as any, { ...props, ref });
});
Strong.displayName = "Strong";

export const Underline = forwardRef<any, ComponentProps<UiHost["Underline"]>>((props, ref) => {
  const { Underline: HostUnderline } = useUiHost();
  return createElement(HostUnderline as any, { ...props, ref });
});
Underline.displayName = "Underline";

export const ScrollBox = forwardRef<any, ComponentProps<UiHost["ScrollBox"]>>((props, ref) => {
  const { ScrollBox: HostScrollBox } = useUiHost();
  const localRef = useForwardedScrollBoxRef<any>(ref);
  const rawProps = props as Record<string, unknown>;
  const remoteNodeId = useRemoteUiNode(
    props.scrollY === true
      ? {
        role: remotePropRole(rawProps, "scrollbox"),
        label: remotePropLabel(rawProps),
        actions: {
          scrollTo: (input) => {
            const top = remoteNumberValue(input, ["top", "index"]);
            localRef.current?.scrollTo?.(Math.max(0, Math.round(top)));
          },
          scrollBy: (input) => {
            const currentTop = Math.max(0, Math.round(localRef.current?.scrollTop ?? 0));
            const delta = input && typeof input === "object" && (input as { direction?: unknown }).direction === "up"
              ? remoteNumberValue(input, ["delta"], -1)
              : remoteNumberValue(input, ["delta"], 1);
            localRef.current?.scrollTo?.(Math.max(0, currentTop + Math.round(delta)));
          },
        },
        metadata: {
          ...remoteMetadataFromProps(rawProps),
          width: rawProps.width,
          height: rawProps.height,
          scrollY: props.scrollY === true,
          scrollTop: localRef.current?.scrollTop,
          viewportHeight: localRef.current?.viewport?.height,
        },
      }
      : null,
  );
  useRegisterPaneScrollBox(localRef, {
    enabled: props.scrollY === true,
    onScrollActivity: typeof props.onMouseScroll === "function"
      ? props.onMouseScroll as (event: { scroll: { direction: "up" | "down"; delta: number } }) => void
      : undefined,
  });
  return createElement(HostScrollBox as any, { ...props, ref: localRef, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
ScrollBox.displayName = "ScrollBox";

export const Input = forwardRef<any, ComponentProps<UiHost["Input"]>>((props, ref) => {
  const { Input: HostInput } = useUiHost();
  const rawProps = props as Record<string, unknown>;
  const onInput = rawProps.onInput as ((value: string) => unknown) | undefined;
  const onChange = rawProps.onChange as ((value: string) => unknown) | undefined;
  const onSubmit = rawProps.onSubmit as ((value?: string) => unknown) | undefined;
  const remoteNodeId = useRemoteUiNode({
    role: remotePropRole(rawProps, "input"),
    label: remotePropLabel(rawProps),
    disabled: rawProps.disabled === true,
    actions: {
      setValue: (input) => {
        const value = remoteStringValue(input);
        onInput?.(value);
        onChange?.(value);
      },
      submit: (input) => {
        const value = remoteStringValue(input, undefined);
        onSubmit?.(value);
      },
      focus: () => (ref && typeof ref === "object" ? ref.current?.focus?.() : undefined),
    },
    metadata: {
      ...remoteMetadataFromProps(rawProps),
      value: rawProps.value,
      placeholder: rawProps.placeholder,
      focused: rawProps.focused,
    },
  });
  return createElement(HostInput as any, { ...props, ref, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
Input.displayName = "Input";

export const Textarea = forwardRef<any, ComponentProps<UiHost["Textarea"]>>((props, ref) => {
  const { Textarea: HostTextarea } = useUiHost();
  const rawProps = props as Record<string, unknown>;
  const onInput = rawProps.onInput as ((value: string) => unknown) | undefined;
  const onChange = rawProps.onChange as ((value: string) => unknown) | undefined;
  const onSubmit = rawProps.onSubmit as (() => unknown) | undefined;
  const remoteNodeId = useRemoteUiNode({
    role: remotePropRole(rawProps, "textarea"),
    label: remotePropLabel(rawProps),
    disabled: rawProps.disabled === true,
    actions: {
      setValue: (input) => {
        const value = remoteStringValue(input);
        onInput?.(value);
        onChange?.(value);
      },
      submit: () => onSubmit?.(),
      focus: () => (ref && typeof ref === "object" ? ref.current?.focus?.() : undefined),
    },
    metadata: {
      ...remoteMetadataFromProps(rawProps),
      value: rawProps.value ?? rawProps.initialValue,
      placeholder: rawProps.placeholder,
      focused: rawProps.focused,
    },
  });
  return createElement(HostTextarea as any, { ...props, ref, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
Textarea.displayName = "Textarea";

function assignForwardedRef(ref: ForwardedRef<any>, value: any): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export const ChartSurface = forwardRef<any, ComponentProps<UiHost["ChartSurface"]>>((props, ref) => {
  const { ChartSurface: HostChartSurface } = useUiHost();
  const rawProps = props as Record<string, unknown>;
  const localRef = useRef<any>(null);
  const setSurfaceRef = useCallback((value: any) => {
    localRef.current = value;
    assignForwardedRef(ref, value);
  }, [ref]);
  const onMouseMove = rawProps.onMouseMove as ((event?: unknown) => unknown) | undefined;
  const onMouseDown = rawProps.onMouseDown as ((event?: unknown) => unknown) | undefined;
  const onMouseDrag = rawProps.onMouseDrag as ((event?: unknown) => unknown) | undefined;
  const onMouseUp = rawProps.onMouseUp as ((event?: unknown) => unknown) | undefined;
  const onMouseDragEnd = rawProps.onMouseDragEnd as ((event?: unknown) => unknown) | undefined;
  const onMouseScroll = rawProps.onMouseScroll as ((event?: unknown) => unknown) | undefined;
  const width = typeof rawProps.width === "number" ? rawProps.width : undefined;
  const height = typeof rawProps.height === "number" ? rawProps.height : undefined;
  const bitmap = rawProps.bitmap;
  const bitmaps = Array.isArray(rawProps.bitmaps) ? rawProps.bitmaps : null;
  const hasBitmap = !!bitmap || (bitmaps?.length ?? 0) > 0;
  const visualRole = typeof rawProps["data-gloom-role"] === "string" ? rawProps["data-gloom-role"] : undefined;
  const remoteNodeId = useRemoteUiNode({
    role: "chart",
    label: remotePropLabel(rawProps) ?? "Chart",
    actions: {
      moveCursor: onMouseMove ? (input) => onMouseMove(remoteChartEvent(input, localRef.current, width, height)) : undefined,
      press: onMouseDown ? (input) => onMouseDown(remoteChartEvent(input, localRef.current, width, height)) : undefined,
      drag: onMouseDrag ? (input) => onMouseDrag(remoteChartEvent(input, localRef.current, width, height)) : undefined,
      release: onMouseUp ? (input) => onMouseUp(remoteChartEvent(input, localRef.current, width, height)) : undefined,
      endDrag: onMouseDragEnd ? (input) => onMouseDragEnd(remoteChartEvent(input, localRef.current, width, height)) : undefined,
      scroll: onMouseScroll ? (input) => onMouseScroll(remoteChartEvent(input, localRef.current, width, height)) : undefined,
    },
    metadata: {
      ...remoteMetadataFromProps(rawProps),
      width: rawProps.width,
      height: rawProps.height,
      hasBitmap,
      bitmapCount: bitmaps?.length ?? (bitmap ? 1 : 0),
      hasCrosshair: rawProps.crosshair != null,
      interactive: !!(onMouseMove || onMouseDown || onMouseDrag || onMouseUp || onMouseScroll),
      visualRole,
    },
  });
  return createElement(HostChartSurface as any, { ...props, ref: setSurfaceRef, "data-gloom-remote-node-id": remoteNodeId ?? undefined });
});
ChartSurface.displayName = "ChartSurface";

export const ImageSurface = forwardRef<any, ComponentProps<UiHost["ImageSurface"]>>((props, ref) => {
  const { ImageSurface: HostImageSurface } = useUiHost();
  return createElement(HostImageSurface as any, { ...props, ref });
});
ImageSurface.displayName = "ImageSurface";

export const MediaSurface = forwardRef<any, ComponentProps<UiHost["MediaSurface"]>>((props, ref) => {
  const { MediaSurface: HostMediaSurface } = useUiHost();
  return createElement(HostMediaSurface as any, { ...props, ref });
});
MediaSurface.displayName = "MediaSurface";

export const SpinnerMark = forwardRef<any, ComponentProps<UiHost["SpinnerMark"]>>((props, ref) => {
  const { SpinnerMark: HostSpinnerMark } = useUiHost();
  return createElement(HostSpinnerMark as any, { ...props, ref });
});
SpinnerMark.displayName = "SpinnerMark";

export const AsciiText = forwardRef<any, ComponentProps<UiHost["AsciiText"]>>((props, ref) => {
  const { AsciiText: HostAsciiText } = useUiHost();
  return createElement(HostAsciiText as any, { ...props, ref });
});
AsciiText.displayName = "AsciiText";
