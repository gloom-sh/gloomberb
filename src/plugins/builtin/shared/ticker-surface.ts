import { publicTickerBindingSymbol } from "../../../tickers/selection";
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
  /** Other mnemonics that open the same view without a separate command-bar row. */
  shortcutAliases?: readonly string[];
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
  ) => Record<string, unknown> | undefined;
  canCreate?: (
    context: PaneTemplateContext,
    options: PaneTemplateCreateOptions | undefined,
    symbol: string,
  ) => boolean;
  /**
   * Opens the pane on no ticker when none is typed or active, titled this,
   * instead of asking for one (INS alone is the market's insider buying).
   * With a ticker typed or active the pane opens on it as before.
   */
  withoutTickerTitle?: string;
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

/** `short-interest:AAPL`, `ticker-research:GGAL:ADR`: the one window a function keeps for a listing. */
export function buildTickerSurfaceInstanceId(paneId: string, symbol: string, viewKey?: string): string {
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

function tickerPublicShare(titlePrefix: string) {
  return {
    serialize: ({ pane }: { pane: { binding?: { kind: string; symbol?: string }; title?: string } }) => (
      pane.binding?.kind === "fixed" && publicTickerBindingSymbol(pane.binding as Parameters<typeof publicTickerBindingSymbol>[0])
        ? {
          title: pane.title?.trim() || `${titlePrefix} ${pane.binding.symbol}`,
          data: { symbol: publicTickerBindingSymbol(pane.binding as Parameters<typeof publicTickerBindingSymbol>[0])! },
        }
        : null
    ),
    restore: (data: Record<string, unknown>) => {
      if (Object.keys(data).length !== 1 || typeof data.symbol !== "string") return null;
      const symbol = data.symbol.trim().toUpperCase();
      return symbol ? { symbol, instrument: null } : null;
    },
  };
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
      ...(templateOptions.shortcutAliases?.length ? { aliases: templateOptions.shortcutAliases } : {}),
      argPlaceholder: "ticker",
      argKind: "ticker",
      ...(templateOptions.withoutTickerTitle ? { openWithoutArg: true } : {}),
    },
    canCreate: (context, createOptions) => {
      const symbol = resolveTickerSurfaceSymbol(context, createOptions);
      if (symbol === null) return !!templateOptions.withoutTickerTitle;
      return templateOptions.canCreate?.(context, createOptions, symbol) ?? true;
    },
    createInstance: (context, createOptions) => {
      const symbol = resolveTickerSurfaceSymbol(context, createOptions);
      if (!symbol) {
        // One window per function: no id or settings, so opening it again
        // finds it. Bound to nothing, so it does not follow the focused list.
        return templateOptions.withoutTickerTitle
          ? { title: templateOptions.withoutTickerTitle, binding: { kind: "none" }, placement: "floating" }
          : null;
      }
      return createTickerSurfacePaneInstance(
        context,
        createOptions,
        templateOptions.paneId,
        titlePrefix,
        templateOptions.settings?.(symbol, context, createOptions),
        resolveViewKey(templateOptions.viewKey, symbol, context, createOptions),
      );
    },
    ...(templateOptions.publicShare ? { publicShare: tickerPublicShare(titlePrefix) } : {}),
  };
}

export interface QueryPaneTemplateOptions {
  id: string;
  paneId: string;
  label: string;
  description: string;
  keywords: string[];
  shortcut: string;
  argPlaceholder: string;
  instancePrefix: string;
  defaultTitle: string;
  titlePrefix: string;
  includeSymbol?: boolean;
  extraSettings?: (options?: PaneTemplateCreateOptions) => Record<string, unknown>;
}

/** Floating search pane opened with an optional free-text query (`CLTR`, `FDA`, `TRIAL`). */
export function createQueryPaneTemplate(options: QueryPaneTemplateOptions): PaneTemplateDef {
  return {
    id: options.id,
    paneId: options.paneId,
    label: options.label,
    description: options.description,
    keywords: options.keywords,
    shortcut: {
      prefix: options.shortcut,
      argPlaceholder: options.argPlaceholder,
      argKind: "text",
      argOnlySelects: true,
      argOptional: true,
    },
    createInstance: (_context, createOptions) => {
      const raw = options.includeSymbol
        ? (createOptions?.arg ?? createOptions?.symbol ?? createOptions?.values?.query ?? "")
        : (createOptions?.arg ?? createOptions?.values?.query ?? "");
      const query = String(raw).trim();
      const encoded = encodeURIComponent(query).replace(/%/g, "~");
      return {
        instanceId: query ? `${options.instancePrefix}:${encoded}` : `${options.instancePrefix}:latest`,
        title: query ? `${options.titlePrefix} ${query}` : options.defaultTitle,
        placement: "floating",
        binding: { kind: "none" },
        settings: { query, ...options.extraSettings?.(createOptions) },
      };
    },
  };
}

export interface OptionalTickerPaneTemplateOptions {
  id: string;
  paneId: string;
  label: string;
  description: string;
  keywords: string[];
  shortcut: string;
  instancePrefix?: string;
  emptyInstance?: PaneTemplateInstanceConfig;
  headless?: PaneTemplateDef["headless"];
  publicShare?: boolean;
}

/** Floating pane where an explicit ticker opens a fixed window, and bare invocation opens the market/home view. */
export function createOptionalTickerPaneTemplate(options: OptionalTickerPaneTemplateOptions): PaneTemplateDef {
  const prefix = options.instancePrefix ?? options.paneId;
  return {
    id: options.id,
    paneId: options.paneId,
    label: options.label,
    description: options.description,
    keywords: options.keywords,
    shortcut: { prefix: options.shortcut, argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
    ...(options.headless ? { headless: options.headless } : {}),
    createInstance: (_context, createOptions) => {
      const symbol = (createOptions?.symbol ?? createOptions?.arg ?? "").trim().toUpperCase();
      if (!symbol) return options.emptyInstance ?? { placement: "floating" };
      return {
        instanceId: `${prefix}:${encodeURIComponent(symbol).replace(/%/g, "~")}`,
        title: `${options.shortcut} ${symbol}`,
        binding: { kind: "fixed", symbol },
        placement: "floating",
      };
    },
    ...(options.publicShare ? { publicShare: tickerPublicShare(options.shortcut) } : {}),
  };
}
