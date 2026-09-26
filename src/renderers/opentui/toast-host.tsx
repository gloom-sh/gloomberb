/** @jsxImportSource @opentui/react */
import { useTerminalDimensions } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { colors } from "../../theme/colors";
import { createToastStore, type ToastHost, type ToastTone } from "../../ui/toast";
import { useActionShortcut } from "../../ui";

const toastStore = createToastStore();

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
  const shownToasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
  const actionShortcut = useActionShortcut("notification-action");
  const maxWidth = Math.max(1, Math.min(60, dimensions.width - 4));
  const placement = position.startsWith("top") ? { top: 1 } : { bottom: 1 };
  const horizontal = position.endsWith("left")
    ? { left: 2 }
    : position.endsWith("center")
      ? { left: Math.max(0, Math.floor((dimensions.width - maxWidth) / 2)) }
      : { right: 2 };

  if (shownToasts.length === 0) return null;
  const newestActionId = shownToasts.findLast((toast) => toast.options?.action)?.id;

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
      {shownToasts.map((toast) => (
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
              {toast.id === newestActionId && actionShortcut
                ? `[${toast.options.action.label} ${actionShortcut}]`
                : `[${toast.options.action.label}]`}
            </text>
          )}
          {toast.options?.secondaryAction && (
            <text
              fg={colors.textMuted}
              onMouseDown={(event) => {
                event.stopPropagation();
                toast.options?.secondaryAction?.onClick();
              }}
            >
              {`[${toast.options.secondaryAction.label}]`}
            </text>
          )}
          <text
            fg={colors.textMuted}
            onMouseDown={(event) => {
              event.stopPropagation();
              toastStore.dismiss(toast.id);
            }}
          >
            ×
          </text>
        </box>
      ))}
    </box>
  );
}

export const openTuiToastHost: ToastHost = { ...toastStore, Viewport: ToastViewport };
