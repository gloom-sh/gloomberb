/** @jsxImportSource react */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useActionShortcut } from "../../../ui";
import { ToastHostProvider, type ToastHost, type ToastOptions } from "../../../ui/toast";
import { WebButton } from "./desktop/controls";
import { WebIconButton } from "./desktop/icons";

type WebToastType = "info" | "success" | "error";

interface ToastEntry {
  id: number;
  body: string;
  type: WebToastType;
  title?: string;
  subtitle?: string;
  action?: ToastOptions["action"];
  secondaryAction?: ToastOptions["secondaryAction"];
}

let nextToastId = 1;

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: ToastEntry[];
  dismiss: (id: number) => void;
}) {
  const actionShortcut = useActionShortcut("notification-action");
  const dismissShortcut = useActionShortcut("notification-dismiss");
  const newestActionId = [...toasts].reverse().find((toast) => toast.action)?.id;
  return (
    <div className="gloom-toast-viewport" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => {
        const activate = () => {
          if (!toast.action) return;
          try {
            toast.action.onClick();
          } finally {
            dismiss(toast.id);
          }
        };
        return (
          <div
            key={toast.id}
            className="gloom-toast"
            data-type={toast.type}
            data-actionable={toast.action ? "true" : "false"}
            onClick={toast.action ? activate : undefined}
          >
            <span className="gloom-toast-indicator" aria-hidden="true" />
            {(toast.title || toast.subtitle) && (
              <div className="gloom-toast-heading">
                {toast.title && <span className="gloom-toast-title">{toast.title}</span>}
                {toast.subtitle && <span className="gloom-toast-subtitle">{toast.subtitle}</span>}
              </div>
            )}
            <div className="gloom-toast-body">{toast.body}</div>
            <div className="gloom-toast-controls">
              {toast.action && (
                <WebButton
                  label={toast.action.label}
                  shortcut={toast.id === newestActionId && actionShortcut ? actionShortcut : undefined}
                  onPress={activate}
                  stopPropagation
                />
              )}
              {toast.secondaryAction && (
                <WebButton
                  label={toast.secondaryAction.label}
                  variant="ghost"
                  stopPropagation
                  onPress={() => {
                    try {
                      toast.secondaryAction?.onClick();
                    } finally {
                      dismiss(toast.id);
                    }
                  }}
                />
              )}
              <WebIconButton
                icon="close"
                label="Dismiss notification"
                shortcut={dismissShortcut || undefined}
                onPress={() => dismiss(toast.id)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WebToastHostProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const dismiss = useCallback((id: string | number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((type: ToastEntry["type"], body: string, options?: ToastOptions) => {
    const id = nextToastId++;
    setToasts((current) => [...current, {
      id,
      type,
      body,
      title: options?.title,
      subtitle: options?.subtitle,
      action: options?.action,
      secondaryAction: options?.secondaryAction,
    }]);
    if (options?.duration !== 0) {
      setTimeout(() => dismiss(id), options?.duration ?? 4500);
    }
    return id;
  }, [dismiss]);

  const host = useMemo<ToastHost>(() => ({
    Viewport() {
      return <ToastViewport toasts={toasts} dismiss={dismiss} />;
    },
    success: (body, options) => push("success", body, options),
    error: (body, options) => push("error", body, options),
    info: (body, options) => push("info", body, options),
    dismiss,
    activateNewest() {
      const toast = [...toastsRef.current].reverse().find((entry) => entry.action);
      if (!toast?.action) return false;
      try {
        toast.action.onClick();
      } finally {
        dismiss(toast.id);
      }
      return true;
    },
    dismissNewest() {
      const toast = toastsRef.current.at(-1);
      if (!toast) return false;
      dismiss(toast.id);
      return true;
    },
  }), [dismiss, push, toasts]);

  return (
    <ToastHostProvider host={host}>
      {children}
    </ToastHostProvider>
  );
}
