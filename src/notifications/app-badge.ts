/**
 * The badge on the app's icon: the Dock icon on macOS. Only a host that can
 * show one installs a sink, which is the desktop app's main window; the
 * terminal and the web app have none, so nothing is set up for them.
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
