import type { PluginRegistry } from "../plugins/registry";
import { paneShowsPersonalData } from "../shares/personal-pane";
import type { AppConfig, PaneInstanceConfig } from "../types/config";
import type { PaneSharePrivateFields } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import type { AskGloomPaneAttachment } from "./pane-request";

/** A handful of the pane's own settings is enough to say how it is set up. */
const MAX_ARGS = 8;
const MAX_ARG_KEY_LENGTH = 32;
const MAX_ARG_VALUE_LENGTH = 48;
/** Layout and view bookkeeping, not what the pane shows. */
const BOOKKEEPING_KEYS = [
  /scroll|width|height|offset|index|expanded|collapsed|focus|hover|sidebar|column|sort|order|version|draft/i,
  // The cursor's position, but not the symbol it is on.
  /^cursor(?!Symbol)/,
  // Timestamps such as `updatedAt`.
  /[a-z]At$/,
];

type ArgSource = Readonly<Record<string, unknown>> | undefined;

function isPrivate(fields: PaneSharePrivateFields | undefined, key: string): boolean {
  return fields === true || (Array.isArray(fields) && fields.includes(key));
}

function scalarArgs(source: ArgSource, privateFields: PaneSharePrivateFields | undefined): Array<[string, string]> {
  if (!source || privateFields === true) return [];
  return Object.entries(source).flatMap(([key, value]): Array<[string, string]> => {
    if (key.length > MAX_ARG_KEY_LENGTH || BOOKKEEPING_KEYS.some((pattern) => pattern.test(key)) || isPrivate(privateFields, key)) return [];
    if (typeof value === "number" && Number.isFinite(value)) return [[key, String(value)]];
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_ARG_VALUE_LENGTH ? [[key, trimmed]] : [];
  });
}

/**
 * The function code a pane is opened by: the one its title starts with when
 * that opens this pane (a chart opened with `GP` stays `GP`), else the first
 * template that opens it.
 */
function functionCode(registry: Pick<PluginRegistry, "paneTemplates">, paneType: string, title: string): string | null {
  const prefixes = [...registry.paneTemplates.values()]
    .filter((template) => template.paneId === paneType && template.shortcut?.prefix)
    .map((template) => template.shortcut!.prefix.toUpperCase());
  const token = title.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (token && prefixes.includes(token)) return token;
  return prefixes[0] ?? null;
}

export interface PaneAttachmentSource {
  registry: Pick<PluginRegistry, "panes" | "paneTemplates" | "brokers" | "getPanePluginId" | "getBrokerPluginId">;
  instance: PaneInstanceConfig;
  /** What the header calls it. */
  title: string;
  symbol: string | null;
  paneState?: Readonly<Record<string, unknown>>;
  config: Pick<AppConfig, "portfolios" | "brokerInstances">;
  tickers?: ReadonlyMap<string, TickerRecord>;
  /** The tab each of its tab strips has open, outermost first. */
  activeTabs?: readonly string[];
  visibleText: string | null;
}

/**
 * What Ask Gloom is told about a pane: its function and arguments as the
 * user set them, and its text as drawn. Fields the pane keeps to itself when
 * shared (`portableShare.private`) stay out of its arguments.
 */
export function buildAskGloomPaneAttachment({
  registry,
  instance,
  title,
  symbol,
  paneState,
  config,
  tickers,
  activeTabs = [],
  visibleText,
}: PaneAttachmentSource): AskGloomPaneAttachment {
  const privateFields = registry.panes.get(instance.paneId)?.portableShare?.private;
  const args: Record<string, string> = {};
  const tabs = activeTabs.map((tab) => tab.trim()).filter(Boolean);
  if (tabs.length > 0) args.tab = tabs.join(" > ").slice(0, MAX_ARG_VALUE_LENGTH);
  for (const [key, value] of [
    ...scalarArgs(instance.params, privateFields?.params),
    ...scalarArgs(instance.settings, privateFields?.settings),
    ...scalarArgs(paneState, privateFields?.state),
  ]) {
    if (Object.keys(args).length >= MAX_ARGS) break;
    if (key in args || value === symbol) continue;
    args[key] = value;
  }
  return {
    paneId: instance.instanceId,
    paneType: instance.paneId,
    title,
    code: functionCode(registry, instance.paneId, title),
    symbol,
    args,
    visibleText,
    personal: showsPersonalData({ registry, instance, paneState, symbol, config, tickers }),
  };
}

/** A pane that cannot be read for it counts as personal: its contents then wait for a yes. */
function showsPersonalData(source: Parameters<typeof paneShowsPersonalData>[0]): boolean {
  try {
    return paneShowsPersonalData(source);
  } catch {
    return true;
  }
}
