/** @jsxImportSource react */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { colors } from "../../../theme/colors";
import { ToastHostProvider, type ToastHost, type ToastOptions } from "../../../ui/toast";

type WebToastType = "info" | "success" | "error";

interface ToastEntry {
  id: number;
  body: string;
  type: WebToastType;
  action?: ToastOptions["action"];
}

let nextToastId = 1;

function webToastBorderColor(type: WebToastType): string {
  if (type === "success") return colors.positive;
  if (type === "error") return colors.negative;
  return colors.borderFocused;
}

function getToastStyle(type: WebToastType): CSSProperties {
  return {
    background: colors.panel,
    borderColor: webToastBorderColor(type),
    color: colors.text,
  };
}

function getToastActionStyle(): CSSProperties {
  return {
    background: colors.selected,
    border: `1px solid ${colors.borderFocused}`,
    color: colors.selectedText,
  };
}

export function WebToastHostProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string | number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((type: ToastEntry["type"], body: string, options?: ToastOptions) => {
    const id = nextToastId++;
    setToasts((current) => [...current, { id, type, body, action: options?.action }].slice(-6));
    if (options?.duration !== 0) {
      setTimeout(() => dismiss(id), options?.duration ?? 4500);
    }
    return id;
  }, [dismiss]);

  const host = useMemo<ToastHost>(() => ({
    Viewport() {
      return (
        <div className="gloom-toast-viewport">
          {toasts.map((toast) => (
            <div key={toast.id} className="gloom-toast" style={getToastStyle(toast.type)}>
              <div>{toast.body}</div>
              {toast.action && (
                <button
                  className="gloom-toast-action"
                  style={getToastActionStyle()}
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          ))}
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
