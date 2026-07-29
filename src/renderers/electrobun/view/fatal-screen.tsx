/** @jsxImportSource react */
import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { backendRequest, requestElectrobunRestart } from "./backend-rpc";

declare global {
  interface Window {
    __gloomRenderFatalError?: (error: unknown, details?: string, source?: string) => void;
  }
}

interface DesktopFatalScreenProps {
  title?: string;
  error: unknown;
  details?: string;
  source: string;
}

interface ElectrobunErrorBoundaryState {
  hasError: boolean;
  error: unknown;
  details?: string;
}

function formatFatalError(error: unknown, details?: string): string {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  return [message, details].filter((value): value is string => Boolean(value)).join("\n");
}

export function DesktopFatalScreen({
  title = "Gloomberb crashed",
  error,
  details,
  source,
}: DesktopFatalScreenProps) {
  const [status, setStatus] = useState<string | null>(null);
  const errorText = useMemo(() => formatFatalError(error, details), [details, error]);

  const reloadWindow = () => {
    window.location.reload();
  };

  const restartApp = () => {
    setStatus("Restart requested...");
    try {
      requestElectrobunRestart({
        source,
        reason: errorText.slice(0, 240),
      });
      window.setTimeout(() => {
        setStatus("If the app stays open, quit it and open it again.");
      }, 2500);
    } catch (restartError) {
      setStatus(`Restart request failed: ${formatFatalError(restartError)}`);
    }
  };

  const copyError = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(errorText);
      } else {
        await backendRequest("host.copyText", { text: errorText });
      }
      setStatus("Error copied.");
    } catch (copyError) {
      setStatus(`Copy failed: ${formatFatalError(copyError)}`);
    }
  };

  return (
    <div className="gloom-fatal">
      <h1>{title}</h1>
      <div className="gloom-fatal-actions">
        <button type="button" data-variant="primary" onClick={restartApp}>Restart app</button>
        <button type="button" onClick={reloadWindow}>Reload window</button>
        <button type="button" onClick={copyError}>Copy error</button>
      </div>
      {status && <div className="gloom-fatal-status" aria-live="polite">{status}</div>}
      <pre>{errorText}</pre>
    </div>
  );
}

export class ElectrobunErrorBoundary extends Component<
  { children: ReactNode },
  ElectrobunErrorBoundaryState
> {
  override state: ElectrobunErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): ElectrobunErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.error("[desktop-recovery] renderer error boundary", error, errorInfo.componentStack);
    this.setState({
      hasError: true,
      error,
      details: errorInfo.componentStack ?? undefined,
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <DesktopFatalScreen
          title="Gloomberb crashed"
          error={this.state.error}
          details={this.state.details}
          source="react-error-boundary"
        />
      );
    }

    return this.props.children;
  }
}
