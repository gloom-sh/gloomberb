/**
 * The logo a broker is listed with on the desktop and the web: the icon of the
 * plugin that registered it (its gloom.json `icon`), else the app's own for a
 * broker Gloom connects for you (a signed-in broker, which no plugin owns),
 * else none, and the list draws the broker's initial instead (LogoMark).
 */
import type { BrokerAdapter } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import type { Portfolio } from "../types/ticker";
import type { BrokerDirectoryEntry } from "./directory";

function svg(markup: string): string {
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

/**
 * The marks the official plugins ship as their icon, for the same brokers
 * when Gloom connects them, keyed by the backend's broker id.
 */
const SIGNED_IN_BROKER_LOGOS: Readonly<Record<string, string>> = {
  ibkr: svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#262626"/><stop offset="1" stop-color="#0F0F0F"/></linearGradient><linearGradient id="m" gradientUnits="userSpaceOnUse" x1="3633.335" y1="66.0445" x2="3671.0737" y2="66.0445" gradientTransform="matrix(-1 0 0 1 3673.7529 0)"><stop offset="0" stop-color="#D71F27"/><stop offset="1" stop-color="#971B1E"/></linearGradient></defs><rect width="64" height="64" fill="url(#t)"/><g transform="translate(20.4 8.2) scale(0.539)"><polygon points="40.4,86.8 2.7,86.8 2.7,45.3" fill="url(#m)"/><polygon points="40.4,1.5 2.7,45.3 2.7,86.8" fill="#D71F27"/><circle cx="35.2" cy="55.5" r="11.3" fill="#D71F27"/></g></svg>'),
  robinhood: svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#CCFF00"/><path transform="translate(14 14) scale(1.5)" d="M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852" fill="#1A1A1A"/></svg>'),
};

/** The plugin icon of a broker adapter (`getBrokerLogo` on the plugin runtime). */
export type BrokerPluginLogo = (brokerType: string) => string | null;

function logoFor(brokerKey: string, pluginIcon: string | null): string | null {
  return pluginIcon ?? SIGNED_IN_BROKER_LOGOS[brokerKey] ?? null;
}

/** A broker in Add Broker's list: the icon of the plugin that connects it on this device, else Gloom's own. */
export function brokerDirectoryLogo(entry: BrokerDirectoryEntry, pluginLogo: BrokerPluginLogo): string | null {
  const device = entry.methods.find((method) => method.kind === "device");
  return logoFor(entry.key, device ? pluginLogo(device.adapter.id) : null);
}

/** A broker profile: its adapter's plugin icon, or the logo of the broker a signed-in profile connects. */
export function brokerProfileLogo(
  instance: BrokerInstanceConfig,
  adapter: BrokerAdapter | null,
  pluginLogo: BrokerPluginLogo,
): string | null {
  const brokerKey = adapter?.portfolioBrokerId?.(instance) || instance.brokerType;
  return logoFor(brokerKey, pluginLogo(instance.brokerType));
}

/**
 * The broker a portfolio's account is at, for its tab: the logo and the name
 * its initial stands in for. Null for a portfolio no broker fills.
 */
export function brokerPortfolioLogo(
  portfolio: Pick<Portfolio, "brokerId" | "brokerInstanceId">,
  instances: readonly BrokerInstanceConfig[],
  getAdapter: (brokerType: string) => BrokerAdapter | null,
  pluginLogo: BrokerPluginLogo,
): { src: string | null; name: string } | null {
  if (!portfolio.brokerInstanceId) return null;
  const instance = instances.find((candidate) => candidate.id === portfolio.brokerInstanceId);
  if (!instance) {
    return portfolio.brokerId ? { src: logoFor(portfolio.brokerId, null), name: portfolio.brokerId } : null;
  }
  const adapter = getAdapter(instance.brokerType);
  const name = adapter?.describeInstance?.(instance).brokerName ?? adapter?.name ?? instance.label;
  return { src: brokerProfileLogo(instance, adapter, pluginLogo), name };
}
