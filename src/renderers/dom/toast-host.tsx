/** @jsxImportSource react */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useActionShortcut } from "../../ui";
import {
  createToastStore,
  ToastHostProvider,
  type ToastHost,
  type ToastStore,
} from "../../ui/toast";
import { WebButton } from "./desktop/controls";
import { WebIconButton } from "./desktop/icons";

function ToastViewport({ store }: { store: ToastStore }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { dismiss } = store;
  const actionShortcut = useActionShortcut("notification-action");
  const dismissShortcut = useActionShortcut("notification-dismiss");
  const newestActionId = toasts.findLast((toast) => toast.options?.action)?.id;
  return (
    <div className="gloom-toast-viewport" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => {
        const { action, secondaryAction, title, subtitle } = toast.options ?? {};
        const activate = () => {
          if (!action) return;
          try {
            action.onClick();
          } finally {
            dismiss(toast.id);
          }
        };
        return (
          <div
            key={toast.id}
            className="gloom-toast"
            data-type={toast.tone}
            data-actionable={action ? "true" : "false"}
            onClick={action ? activate : undefined}
          >
            <span className="gloom-toast-indicator" aria-hidden="true" />
            {(title || subtitle) && (
              <div className="gloom-toast-heading">
                {title && <span className="gloom-toast-title">{title}</span>}
                {subtitle && <span className="gloom-toast-subtitle">{subtitle}</span>}
              </div>
            )}
            <div className="gloom-toast-body">{toast.body}</div>
            <div className="gloom-toast-controls">
              {action && (
                <WebButton
                  label={action.label}
                  shortcut={toast.id === newestActionId && actionShortcut ? actionShortcut : undefined}
                  onPress={activate}
                  stopPropagation
                />
              )}
              {secondaryAction && (
                <WebButton
                  label={secondaryAction.label}
                  variant="ghost"
                  stopPropagation
                  onPress={() => {
                    try {
                      secondaryAction.onClick();
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
  const [host] = useState<ToastHost>(() => {
    const store = createToastStore();
    return { ...store, Viewport: () => <ToastViewport store={store} /> };
  });

  return (
    <ToastHostProvider host={host}>
      {children}
    </ToastHostProvider>
  );
}
