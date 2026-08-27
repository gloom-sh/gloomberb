import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
  PaneTemplateInstanceConfig,
} from "../../../types/plugin";
import { normalizeTickerInput } from "../../../tickers/search";

export interface TickerSurfacePaneTemplateOptions {
  id: string;
  paneId: string;
  label: string;
  description: string;
  keywords: string[];
  shortcut: string;
  /** Opt in only when this template is available in the hosted browser catalog. */
  publicShare?: boolean;
  titlePrefix?: string;
  viewKey?: string | ((
    symbol: string,
    context: PaneTemplateContext,
    options: PaneTemplateCreateOptions | undefined,
  ) => string | undefined);
  settings?: (
    symbol: string,
    context: PaneTemplateContext,
    options: PaneTemplateCreateOptions | undefined,
  ) => Record<string, unknown>;
  canCreate?: (
    context: PaneTemplateContext,
    options: PaneTemplateCreateOptions | undefined,
    symbol: string,
  ) => boolean;
}

function resolveTickerSurfaceSymbol(
  context: Pick<PaneTemplateContext, "activeTicker">,
  options?: Pick<PaneTemplateCreateOptions, "arg" | "symbol">,
): string | null {
  const explicitSymbol = options?.symbol?.trim().toUpperCase();
  return explicitSymbol || normalizeTickerInput(context.activeTicker, options?.arg);
}

function createTickerSurfacePaneInstance(
  context: Pick<PaneTemplateContext, "activeTicker">,
  options: Pick<PaneTemplateCreateOptions, "arg" | "symbol"> | undefined,
  paneId: string,
  titlePrefix: string,
  settings?: Record<string, unknown>,
  viewKey?: string,
): PaneTemplateInstanceConfig | null {
  const ticker = resolveTickerSurfaceSymbol(context, options);
  return ticker
    ? {
      instanceId: buildTickerSurfaceInstanceId(paneId, ticker, viewKey),
      title: `${titlePrefix} ${ticker}`,
      binding: { kind: "fixed", symbol: ticker },
      placement: "floating",
      settings,
    }
    : null;
}

function normalizeInstanceIdPart(value: string): string {
  return encodeURIComponent(value.trim().toUpperCase()).replace(/%/g, "~");
}

function buildTickerSurfaceInstanceId(paneId: string, symbol: string, viewKey?: string): string {
  const parts = [paneId, normalizeInstanceIdPart(symbol)];
  if (viewKey) parts.push(normalizeInstanceIdPart(viewKey));
  return parts.join(":");
}

function resolveViewKey(
  viewKey: TickerSurfacePaneTemplateOptions["viewKey"],
  symbol: string,
  context: PaneTemplateContext,
  options: PaneTemplateCreateOptions | undefined,
): string | undefined {
  return typeof viewKey === "function" ? viewKey(symbol, context, options) : viewKey;
}

export function createTickerSurfacePaneTemplate(
  templateOptions: TickerSurfacePaneTemplateOptions,
): PaneTemplateDef {
  const titlePrefix = templateOptions.titlePrefix ?? templateOptions.shortcut;
  return {
    id: templateOptions.id,
    paneId: templateOptions.paneId,
    label: templateOptions.label,
    description: templateOptions.description,
    keywords: templateOptions.keywords,
    shortcut: {
      prefix: templateOptions.shortcut,
      argPlaceholder: "ticker",
      argKind: "ticker",
    },
    canCreate: (context, createOptions) => {
      const symbol = resolveTickerSurfaceSymbol(context, createOptions);
      return symbol !== null && (templateOptions.canCreate?.(context, createOptions, symbol) ?? true);
    },
    createInstance: (context, createOptions) => {
      const symbol = resolveTickerSurfaceSymbol(context, createOptions);
      if (!symbol) return null;
      return createTickerSurfacePaneInstance(
        context,
        createOptions,
        templateOptions.paneId,
        titlePrefix,
        templateOptions.settings?.(symbol, context, createOptions),
        resolveViewKey(templateOptions.viewKey, symbol, context, createOptions),
      );
    },
    ...(templateOptions.publicShare ? {
      publicShare: {
        serialize: ({ pane }) => pane.binding?.kind === "fixed" && pane.binding.symbol.trim()
          ? {
            title: pane.title?.trim() || `${titlePrefix} ${pane.binding.symbol}`,
            data: { symbol: pane.binding.symbol.trim().toUpperCase() },
          }
          : null,
        restore: (data) => {
          if (Object.keys(data).length !== 1 || typeof data.symbol !== "string") return null;
          const symbol = data.symbol.trim().toUpperCase();
          return symbol ? { symbol } : null;
        },
      },
    } : {}),
  };
}
