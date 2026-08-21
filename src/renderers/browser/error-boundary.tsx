/** @jsxImportSource react */
import { Component, type ErrorInfo, type ReactNode } from "react";

export class BrowserErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Browser renderer crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return <div className="gloom-fatal"><h1>Gloomberb crashed</h1><pre>{message}</pre><button onClick={() => window.location.reload()}>Reload</button></div>;
  }
}
