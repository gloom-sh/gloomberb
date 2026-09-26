import { createContext, useContext, type ComponentType, type ReactNode } from "react";

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  title?: string;
  subtitle?: string;
  duration?: number;
  action?: ToastAction;
  /** Rendered next to `action`. Use for a dismissing counterpart such as snooze. */
  secondaryAction?: ToastAction;
}

export interface ToastHost {
  Viewport: ComponentType<{ position?: string }>;
  success(body: string, options?: ToastOptions): string | number | undefined;
  error(body: string, options?: ToastOptions): string | number | undefined;
  info(body: string, options?: ToastOptions): string | number | undefined;
  dismiss(id: string | number): void;
  /** Runs the newest visible toast's action, for the keyboard. False when no toast has one. */
  activateNewest?(): boolean;
  /** Dismisses the newest visible toast, for the keyboard. False when none is showing. */
  dismissNewest?(): boolean;
}

export type ToastTone = "success" | "error" | "info";

interface ToastRecord {
  id: number;
  body: string;
  tone: ToastTone;
  options?: ToastOptions;
}

/** A host's toasts minus how they draw. Each renderer supplies its own `Viewport`. */
export interface ToastStore extends Omit<ToastHost, "Viewport"> {
  activateNewest(): boolean;
  dismissNewest(): boolean;
  subscribe(listener: () => void): () => void;
  /** The toasts on screen, oldest first. The same array until something changes. */
  getSnapshot(): readonly ToastRecord[];
}

const MAX_VISIBLE_TOASTS = 4;
/** Small buffer above the visible cap so a dismissal can reveal a recent toast. */
const MAX_RETAINED_TOASTS = 8;
const DEFAULT_TOAST_DURATION_MS = 4_000;

export function createToastStore(): ToastStore {
  let nextToastId = 1;
  let toasts: ToastRecord[] = [];
  let visible: ToastRecord[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const clearTimer = (id: number) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const publish = (next: ToastRecord[]) => {
    toasts = next;
    visible = next.slice(-MAX_VISIBLE_TOASTS);
    for (const listener of listeners) listener();
  };
  const dismiss = (id: string | number) => {
    const numericId = typeof id === "number" ? id : Number(id);
    if (!Number.isFinite(numericId)) return;
    clearTimer(numericId);
    const next = toasts.filter((toast) => toast.id !== numericId);
    if (next.length !== toasts.length) publish(next);
  };
  const add = (tone: ToastTone) => (body: string, options?: ToastOptions): number => {
    const id = nextToastId++;
    // Only the newest MAX_VISIBLE_TOASTS render, so anything past the cap is
    // unreachable. Keeping it would let a dismissal resurface a stale toast.
    const kept = [...toasts, { id, body, tone, options }].slice(-MAX_RETAINED_TOASTS);
    for (const dropped of toasts) {
      if (!kept.some((toast) => toast.id === dropped.id)) clearTimer(dropped.id);
    }
    publish(kept);
    const duration = options?.duration ?? DEFAULT_TOAST_DURATION_MS;
    // 0 and Infinity both mean "until dismissed".
    if (Number.isFinite(duration) && duration > 0) {
      timers.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  };

  return {
    success: add("success"),
    error: add("error"),
    info: add("info"),
    dismiss,
    activateNewest() {
      const toast = visible.findLast((entry) => entry.options?.action);
      const action = toast?.options?.action;
      if (!toast || !action) return false;
      try {
        action.onClick();
      } finally {
        dismiss(toast.id);
      }
      return true;
    },
    dismissNewest() {
      const toast = visible.at(-1);
      if (!toast) return false;
      dismiss(toast.id);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => visible,
  };
}

const ToastContext = createContext<ToastHost | null>(null);

export function ToastHostProvider({
  host,
  children,
}: {
  host: ToastHost;
  children: ReactNode;
}) {
  return <ToastContext value={host}>{children}</ToastContext>;
}

export function useToastHost(): ToastHost {
  const host = useContext(ToastContext);
  if (!host) throw new Error("useToastHost must be used inside ToastHostProvider");
  return host;
}

export function ToastViewport(props: { position?: string }) {
  const { Viewport } = useToastHost();
  return <Viewport {...props} />;
}
