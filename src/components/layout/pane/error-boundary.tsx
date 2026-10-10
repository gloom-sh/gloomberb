import { Component, type ErrorInfo, type ReactNode } from "react";
import { tf } from "../../../i18n";
import { getSharedRegistry } from "../../../plugins/registry/shared";
import { reportCrash } from "../../../telemetry/crash-reports";
import { debugLog } from "../../../utils/debug-log";
import { Button } from "../../ui/button";
import { PaneStatusBody } from "../../ui/status";

const MAX_MESSAGE_LENGTH = 200;

/** The first line of what was thrown, clipped: the card has one line for it. */
function failureMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message || error.name
    : typeof error === "string" ? error : String(error);
  const line = raw.split("\n").find((part) => part.trim())?.trim() || "Unknown error";
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : line;
}

function failureKey(error: unknown): string {
  return error instanceof Error ? `${error.name}\n${error.message}` : String(error);
}

interface PaneErrorBoundaryProps {
  paneType: string;
  title: string;
  /** Takes the pane out of the layout; without it the card offers Reload only. */
  onClose?: () => void;
  children: ReactNode;
}

interface PaneErrorBoundaryState {
  error: { value: unknown } | null;
}

/**
 * Keeps a pane that throws while rendering inside its own frame: the pane body
 * becomes a failure card with Reload and Close, and every other pane, the
 * command bar and the layout keep working. The pane's header stays outside, so
 * it can still be moved or closed from its menu.
 *
 * Only render errors reach it. Event handlers, effects and async work fail the
 * way they always have.
 */
export class PaneErrorBoundary extends Component<PaneErrorBoundaryProps, PaneErrorBoundaryState> {
  override state: PaneErrorBoundaryState = { error: null };
  private reportedKey: string | null = null;

  static getDerivedStateFromError(error: unknown): PaneErrorBoundaryState {
    return { error: { value: error } };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // A pane that fails again after Reload, or re-renders its card, is still
    // the same failure: reported once.
    const key = failureKey(error);
    if (key === this.reportedKey) return;
    this.reportedKey = key;
    const { paneType } = this.props;
    const plugin = getSharedRegistry()?.getPanePluginId(paneType);
    reportCrash(error, { kind: "render", pane: paneType, plugin, componentStack: errorInfo.componentStack });
    // Logged under the owning plugin, so the Plugins pane counts it as one of its errors.
    debugLog.createLogger(plugin ?? "pane").error(`Pane ${paneType} stopped rendering: ${failureMessage(error)}`, {
      componentStack: errorInfo.componentStack,
    });
  }

  private readonly reload = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <FallbackGuard>
        <PaneStatusBody
          error={failureMessage(error.value)}
          errorTitle={tf("{title} stopped working.", { title: this.props.title })}
          actions={(
            <>
              <Button label="Reload pane" variant="primary" compact onPress={this.reload} />
              {this.props.onClose && <Button label="Close pane" variant="secondary" compact onPress={this.props.onClose} />}
            </>
          )}
        />
      </FallbackGuard>
    );
  }
}

/** A card that cannot render leaves the body empty rather than taking the app down with it. */
class FallbackGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
