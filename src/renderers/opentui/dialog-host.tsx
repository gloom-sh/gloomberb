/** @jsxImportSource @opentui/react */
import { RGBA, type Renderable } from "@opentui/core";
import { flushSync, useKeyboard, useRenderer } from "@opentui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { colors } from "../../theme/colors";
import {
  DialogHostProvider,
  type AlertContext,
  type DialogApi,
  type PromptContext,
} from "../../ui/dialog";

type DialogSize = "small" | "medium" | "large" | "full";

interface DialogStyle {
  width?: number;
  maxWidth?: number;
  maxHeight?: number;
  [key: string]: unknown;
}

interface DialogRecord {
  id: string;
  content: unknown;
  kind: "alert" | "prompt";
  size?: DialogSize;
  style?: DialogStyle;
  closeOnEscape?: boolean;
  closeOnClickOutside?: boolean;
  settle(value: unknown): void;
}

export interface OpenTuiDialogHostProviderProps {
  children: ReactNode;
  size?: DialogSize;
  sizePresets?: Partial<Record<DialogSize, number>>;
  closeOnEscape?: boolean;
  closeOnClickOutside?: boolean;
  dialogOptions?: { style?: DialogStyle };
  backdropColor?: string;
  backdropOpacity?: number;
}

let nextDialogId = 1;

function renderDialogContent(content: unknown, context: AlertContext | PromptContext<unknown>): ReactNode {
  return typeof content === "function"
    ? (content as (context: AlertContext | PromptContext<unknown>) => ReactNode)(context)
    : content as ReactNode;
}

function dialogWidth(
  size: DialogSize,
  terminalWidth: number,
  sizePresets: OpenTuiDialogHostProviderProps["sizePresets"],
): number {
  const customWidth = sizePresets?.[size];
  const requestedWidth = customWidth && customWidth > 0
    ? customWidth
    : size === "small"
      ? 40
      : size === "large"
        ? 80
        : size === "full"
          ? terminalWidth - 4
          : 60;
  return Math.max(1, Math.min(requestedWidth, terminalWidth - 2));
}

function backdrop(color: string, opacity: number): RGBA {
  const value = RGBA.fromHex(color);
  value.a = Math.max(0, Math.min(opacity, 1));
  return value;
}

function DialogLayer({
  api,
  close,
  containerOptions,
  dialog,
  dimensions,
  index,
  isTopmost,
}: {
  api: DialogApi;
  close(id: string, value?: unknown): void;
  containerOptions: Omit<OpenTuiDialogHostProviderProps, "children">;
  dialog: DialogRecord;
  dimensions: { width: number; height: number };
  index: number;
  isTopmost: boolean;
}) {
  const effectiveSize = dialog.size ?? containerOptions.size ?? "medium";
  const providerStyle = containerOptions.dialogOptions?.style ?? {};
  const style = { ...providerStyle, ...dialog.style };
  const viewportWidth = Math.max(1, dimensions.width - 2);
  const viewportHeight = Math.max(1, dimensions.height - 2);
  const width = typeof style.width === "number"
    ? Math.max(1, Math.min(style.width, viewportWidth))
    : dialogWidth(effectiveSize, dimensions.width, containerOptions.sizePresets);
  const maxWidth = typeof style.maxWidth === "number"
    ? Math.max(1, Math.min(style.maxWidth, viewportWidth))
    : viewportWidth;
  const maxHeight = typeof style.maxHeight === "number"
    ? Math.max(1, Math.min(style.maxHeight, viewportHeight))
    : viewportHeight;
  const closeOnEscape = dialog.closeOnEscape ?? containerOptions.closeOnEscape ?? true;
  const closeOnClickOutside = dialog.closeOnClickOutside
    ?? containerOptions.closeOnClickOutside
    ?? false;
  const zIndex = 9_998 + index * 2;

  useKeyboard((event) => {
    if (!isTopmost || !closeOnEscape || event.name !== "escape") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    close(dialog.id);
  });

  const context = dialog.kind === "prompt"
    ? {
      dialogId: dialog.id,
      dismiss: () => close(dialog.id),
      resolve: (value: unknown) => close(dialog.id, value),
    }
    : {
      dialogId: dialog.id,
      dismiss: () => close(dialog.id),
    };

  return (
    <>
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions.width}
        height={dimensions.height}
        zIndex={zIndex}
        backgroundColor={backdrop(
          containerOptions.backdropColor ?? colors.bg,
          containerOptions.backdropOpacity ?? 0.8,
        )}
      />
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions.width}
        height={dimensions.height}
        zIndex={zIndex + 1}
        alignItems="center"
        justifyContent="center"
        onMouseDown={() => {
          if (isTopmost && closeOnClickOutside) close(dialog.id);
        }}
      >
        <box
          {...style as any}
          width={width}
          maxWidth={maxWidth}
          maxHeight={maxHeight}
          border={style.border ?? true}
          borderStyle={style.borderStyle ?? "single"}
          borderColor={style.borderColor ?? colors.borderFocused}
          backgroundColor={style.backgroundColor ?? colors.bg}
          paddingX={style.paddingX ?? 2}
          paddingY={style.paddingY ?? 1}
          onMouseDown={(event: { stopPropagation(): void }) => event.stopPropagation()}
        >
          <DialogHostProvider
            dialog={api}
            isOpen={true}
            dialogId={dialog.id}
            keyboardEnabled={isTopmost}
          >
            {renderDialogContent(dialog.content, context)}
          </DialogHostProvider>
        </box>
      </box>
    </>
  );
}

export function OpenTuiDialogHostProvider({
  children,
  ...containerOptions
}: OpenTuiDialogHostProviderProps) {
  const renderer = useRenderer();
  const [dimensions, setDimensions] = useState(() => ({
    width: renderer.width,
    height: renderer.height,
  }));
  const [dialogs, setDialogs] = useState<DialogRecord[]>([]);
  const dialogsRef = useRef<DialogRecord[]>([]);
  const savedFocusRef = useRef<Renderable | null>(null);
  const mountedRef = useRef(true);

  const publish = useCallback((next: DialogRecord[]) => {
    dialogsRef.current = next;
    if (mountedRef.current) flushSync(() => setDialogs(next));
  }, []);

  const close = useCallback((id: string, value?: unknown) => {
    const current = dialogsRef.current;
    const target = current.find((dialog) => dialog.id === id);
    if (!target) return;
    const next = current.filter((dialog) => dialog.id !== id);
    publish(next);
    target.settle(value);
    if (next.length === 0) {
      const savedFocus = savedFocusRef.current;
      savedFocusRef.current = null;
      queueMicrotask(() => {
        try {
          savedFocus?.focus();
        } catch {
          // The previously focused renderable may have unmounted with the dialog.
        }
      });
    }
  }, [publish]);

  const open = useCallback(<T,>(kind: DialogRecord["kind"], options: Record<string, unknown>) => (
    new Promise<T | undefined>((resolve) => {
      if (dialogsRef.current.length === 0) {
        savedFocusRef.current = renderer.currentFocusedRenderable;
        savedFocusRef.current?.blur();
      }
      let settled = false;
      const record: DialogRecord = {
        id: `gloom-dialog-${nextDialogId++}`,
        kind,
        content: options.content,
        size: options.size as DialogSize | undefined,
        style: options.style as DialogStyle | undefined,
        closeOnEscape: options.closeOnEscape as boolean | undefined,
        closeOnClickOutside: options.closeOnClickOutside as boolean | undefined,
        settle(value) {
          if (settled) return;
          settled = true;
          resolve(value as T | undefined);
        },
      };
      publish([...dialogsRef.current, record]);
    })
  ), [publish, renderer]);

  const api = useMemo<DialogApi>(() => ({
    alert: async (options) => {
      await open<void>("alert", options);
    },
    prompt: <T,>(options: Record<string, unknown>) => open<T>("prompt", options),
  }), [open]);

  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: renderer.width, height: renderer.height });
    };
    renderer.on("resize", updateDimensions);
    return () => {
      renderer.off("resize", updateDimensions);
    };
  }, [renderer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const dialog of dialogsRef.current) dialog.settle(undefined);
      dialogsRef.current = [];
      savedFocusRef.current = null;
    };
  }, []);

  return (
    <DialogHostProvider dialog={api} isOpen={dialogs.length > 0}>
      <box position="relative" width={dimensions.width} height={dimensions.height}>
        {children}
        {dialogs.map((dialog, index) => (
          <DialogLayer
            key={dialog.id}
            api={api}
            close={close}
            containerOptions={containerOptions}
            dialog={dialog}
            dimensions={dimensions}
            index={index}
            isTopmost={index === dialogs.length - 1}
          />
        ))}
      </box>
    </DialogHostProvider>
  );
}
