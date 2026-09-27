/** @jsxImportSource @opentui/react */
import { RGBA, type Renderable } from "@opentui/core";
import { flushSync, useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { colors } from "../../theme/colors";
import {
  DialogHostProvider,
  type AlertContext,
  type DialogApi,
  type DialogOptions,
  type DialogStyle,
  type PromptContext,
} from "../../ui/dialog";
import { useDialogStack, type DialogKind } from "../../ui/dialog-stack";

interface DialogRecord {
  id: string;
  content: unknown;
  kind: DialogKind;
  size?: DialogOptions["size"];
  style?: DialogStyle;
  closeOnEscape?: boolean;
  closeOnClickOutside?: boolean;
}

function renderDialogContent(content: unknown, context: AlertContext | PromptContext<unknown>): ReactNode {
  return typeof content === "function"
    ? (content as (context: AlertContext | PromptContext<unknown>) => ReactNode)(context)
    : content as ReactNode;
}

function dialogWidth(size: DialogOptions["size"], terminalWidth: number): number {
  const requestedWidth = size === "small"
    ? 40
    : size === "large"
      ? 80
      : size === "full"
        ? terminalWidth - 4
        : 60;
  return Math.max(1, Math.min(requestedWidth, terminalWidth - 2));
}

function backdrop(): RGBA {
  const value = RGBA.fromHex(colors.bg);
  value.a = 0.8;
  return value;
}

function DialogLayer({
  api,
  close,
  dialog,
  dimensions,
  index,
  isTopmost,
}: {
  api: DialogApi;
  close(id: string, value?: unknown): void;
  dialog: DialogRecord;
  dimensions: { width: number; height: number };
  index: number;
  isTopmost: boolean;
}) {
  const style = dialog.style ?? {};
  const viewportWidth = Math.max(1, dimensions.width - 2);
  const viewportHeight = Math.max(1, dimensions.height - 2);
  const width = typeof style.width === "number"
    ? Math.max(1, Math.min(style.width, viewportWidth))
    : dialogWidth(dialog.size ?? "medium", dimensions.width);
  const maxWidth = typeof style.maxWidth === "number"
    ? Math.max(1, Math.min(style.maxWidth, viewportWidth))
    : viewportWidth;
  const maxHeight = typeof style.maxHeight === "number"
    ? Math.max(1, Math.min(style.maxHeight, viewportHeight))
    : viewportHeight;
  const closeOnEscape = dialog.closeOnEscape ?? true;
  const closeOnClickOutside = dialog.closeOnClickOutside ?? false;
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
        backgroundColor={backdrop()}
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

export function OpenTuiDialogHostProvider({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [dimensions, setDimensions] = useState(() => ({
    width: renderer.width,
    height: renderer.height,
  }));
  // Focus is saved once when the stack opens and restored when it empties.
  const savedFocusRef = useRef<Renderable | null>(null);
  const { dialogs, close, api } = useDialogStack<DialogRecord>({
    idPrefix: "gloom-dialog",
    commit: (update) => flushSync(update),
    createEntry: (id, kind, options, stackWasEmpty) => {
      if (stackWasEmpty) {
        savedFocusRef.current = renderer.currentFocusedRenderable;
        savedFocusRef.current?.blur();
      }
      return {
        id,
        kind,
        content: options.content,
        size: options.size,
        style: options.style,
        closeOnEscape: options.closeOnEscape,
        closeOnClickOutside: options.closeOnClickOutside,
      };
    },
    onClosed: (_dialog, remaining) => {
      if (remaining.length > 0) return;
      const savedFocus = savedFocusRef.current;
      savedFocusRef.current = null;
      queueMicrotask(() => {
        try {
          savedFocus?.focus();
        } catch {
          // The previously focused renderable may have unmounted with the dialog.
        }
      });
    },
  });

  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: renderer.width, height: renderer.height });
    };
    renderer.on("resize", updateDimensions);
    return () => {
      renderer.off("resize", updateDimensions);
    };
  }, [renderer]);

  return (
    <DialogHostProvider dialog={api} isOpen={dialogs.length > 0}>
      <box position="relative" width={dimensions.width} height={dimensions.height}>
        {children}
        {dialogs.map((dialog, index) => (
          <DialogLayer
            key={dialog.id}
            api={api}
            close={close}
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
