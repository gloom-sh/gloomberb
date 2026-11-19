/**
 * The unread badge on the macOS Dock icon or the browser tab. Hosts that
 * cannot show one do not install a sink.
 */
export interface AppBadgeHost {
  /** `""` clears the badge; otherwise the label from {@link appBadgeLabel}. */
  setBadge(label: string): void;
}

let host: AppBadgeHost | null = null;

/** Returns the uninstall. */
export function installAppBadgeHost(next: AppBadgeHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

export function getAppBadgeHost(): AppBadgeHost | null {
  return host;
}

/** The badge text for a count: none at zero, the number up to 99, `99+` above. Never message text. */
export function appBadgeLabel(count: number): string {
  const whole = Number.isFinite(count) ? Math.floor(count) : 0;
  if (whole < 1) return "";
  return whole > 99 ? "99+" : String(whole);
}
