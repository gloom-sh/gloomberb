/** @jsxImportSource react */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportCrash } from "../../telemetry/crash-reports";
import { UiHostProvider, type RendererHost, type UiHost } from "../../ui/host";
import { WebDialogHostProvider } from "./dialog-host";
import { WebInputHostProvider } from "./input-host";
import { webNativeRenderer } from "./native-renderer";
import { WebToastHostProvider } from "./toast-host";

/** The host providers every DOM entry (desktop, browser, pane shots) mounts the app in. */
export function DomHostProviders({
  ui,
  renderer,
  children,
}: {
  ui: UiHost;
  renderer: RendererHost;
  children: ReactNode;
}) {
  return (
    <UiHostProvider ui={ui} renderer={renderer} nativeRenderer={webNativeRenderer}>
      <WebInputHostProvider>
        <WebToastHostProvider>
          <WebDialogHostProvider>
            {children}
          </WebDialogHostProvider>
        </WebToastHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

interface DomErrorBoundaryProps {
  /** Logged with the error and component stack. */
  label: string;
  fallback(error: unknown, details?: string): ReactNode;
  children: ReactNode;
}

interface DomErrorBoundaryState {
  hasError: boolean;
  error: unknown;
  details?: string;
}

export class DomErrorBoundary extends Component<DomErrorBoundaryProps, DomErrorBoundaryState> {
  override state: DomErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): DomErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.error(this.props.label, error, errorInfo.componentStack);
    reportCrash(error, { kind: "render", componentStack: errorInfo.componentStack });
    this.setState({ details: errorInfo.componentStack ?? undefined });
  }

  override render(): ReactNode {
    return this.state.hasError
      ? this.props.fallback(this.state.error, this.state.details)
      : this.props.children;
  }
}
