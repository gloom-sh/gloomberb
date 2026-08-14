/** @jsxImportSource @opentui/react */
import { useTerminalDimensions } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { colors } from "../../theme/colors";
import type { ToastHost, ToastOptions } from "../../ui/toast";

type ToastTone = "success" | "error" | "info";

interface ToastRecord {
  id: number;
  body: string;
  tone: ToastTone;
  options?: ToastOptions;
}

let nextToastId = 1;
let toasts: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(): void {
  for (const listener of listeners) listener();
}

function dismissToast(id: string | number): void {
  const numericId = typeof id === "number" ? id : Number(id);
  if (!Number.isFinite(numericId)) return;
  const timer = timers.get(numericId);
  if (timer) clearTimeout(timer);
  timers.delete(numericId);
  const next = toasts.filter((toast) => toast.id !== numericId);
  if (next.length === toasts.length) return;
  toasts = next;
  publish();
}

function addToast(tone: ToastTone, body: string, options?: ToastOptions): number {
  const id = nextToastId++;
  toasts = [...toasts, { id, body, tone, options }];
  publish();
  const duration = options?.duration ?? 4_000;
  if (Number.isFinite(duration) && duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), duration));
  }
  return id;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastRecord[] {
  return toasts;
}

function toneColor(tone: ToastTone): string {
  if (tone === "success") return colors.positive;
  if (tone === "error") return colors.negative;
  return colors.neutral;
}

function toneIcon(tone: ToastTone): string {
  if (tone === "success") return "✓";
  if (tone === "error") return "!";
  return "i";
}

function ToastViewport({ position = "bottom-right" }: { position?: string }) {
  const dimensions = useTerminalDimensions();
  const visibleToasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const maxWidth = Math.max(1, Math.min(60, dimensions.width - 4));
  const placement = position.startsWith("top") ? { top: 1 } : { bottom: 1 };
  const horizontal = position.endsWith("left")
    ? { left: 2 }
    : position.endsWith("center")
      ? { left: Math.max(0, Math.floor((dimensions.width - maxWidth) / 2)) }
      : { right: 2 };

  if (visibleToasts.length === 0) return null;

  return (
    <box
      position="absolute"
      {...placement}
      {...horizontal}
      width={maxWidth}
      zIndex={9_900}
      flexDirection="column"
      gap={1}
    >
      {visibleToasts.slice(-4).map((toast) => (
        <box
          key={toast.id}
          width="100%"
          border
          borderStyle="single"
          borderColor={toneColor(toast.tone)}
          backgroundColor={colors.panel}
          paddingX={1}
          flexDirection="row"
          gap={1}
        >
          <text fg={toneColor(toast.tone)}>{toneIcon(toast.tone)}</text>
          <text fg={colors.text} flexGrow={1} wrapMode="word">{toast.body}</text>
          {toast.options?.action && (
            <text
              fg={colors.textBright}
              attributes={1}
              onMouseDown={(event) => {
                event.stopPropagation();
                toast.options?.action?.onClick();
              }}
            >
              {`[${toast.options.action.label}]`}
            </text>
          )}
          <text
            fg={colors.textMuted}
            onMouseDown={(event) => {
              event.stopPropagation();
              dismissToast(toast.id);
            }}
          >
            ×
          </text>
        </box>
      ))}
    </box>
  );
}

export const openTuiToastHost: ToastHost = {
  Viewport: ToastViewport,
  success: (body, options) => addToast("success", body, options),
  error: (body, options) => addToast("error", body, options),
  info: (body, options) => addToast("info", body, options),
  dismiss: dismissToast,
};
