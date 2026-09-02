/** @jsxImportSource react */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ToastHostProvider, type ToastHost, type ToastOptions } from "../../../ui/toast";

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

export function WebToastHostProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

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
                <div className="gloom-toast-content">
                  {(toast.title || toast.subtitle) && (
                    <div className="gloom-toast-heading">
                      {toast.title && <span className="gloom-toast-title">{toast.title}</span>}
                      {toast.subtitle && <span className="gloom-toast-subtitle">{toast.subtitle}</span>}
                    </div>
                  )}
                  <div className="gloom-toast-body">{toast.body}</div>
                </div>
                <div className="gloom-toast-controls">
                  {toast.action && (
                    <button
                      type="button"
                      className="gloom-toast-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        activate();
                      }}
                    >
                      {toast.action.label}
                    </button>
                  )}
                  {toast.secondaryAction && (
                    <button
                      type="button"
                      className="gloom-toast-action gloom-toast-action-secondary"
                      onClick={(event) => {
                        event.stopPropagation();
                        try {
                          toast.secondaryAction?.onClick();
                        } finally {
                          dismiss(toast.id);
                        }
                      }}
                    >
                      {toast.secondaryAction.label}
                    </button>
                  )}
                  <button
                    type="button"
                    className="gloom-toast-dismiss"
                    aria-label="Dismiss notification"
                    onClick={(event) => {
                      event.stopPropagation();
                      dismiss(toast.id);
                    }}
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path d="M2.25 2.25 9.75 9.75M9.75 2.25 2.25 9.75" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      );
    },
    success: (body, options) => push("success", body, options),
    error: (body, options) => push("error", body, options),
    info: (body, options) => push("info", body, options),
    dismiss,
  }), [dismiss, push, toasts]);

  return (
    <ToastHostProvider host={host}>
      {children}
    </ToastHostProvider>
  );
}
