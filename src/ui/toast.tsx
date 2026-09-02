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
