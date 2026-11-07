import { useEffect, useRef } from "react";
import { usePaneFooterScopeActive } from "../components/layout/pane/footer/registration";
import type { ResolvedPane } from "../layout/pane-manager";
import { resolveTickerForPane, useOptionalPaneInstanceId, type AppState } from "../state/app/context";
import type { PaneTemplateDef } from "../types/plugin";
import { logFailure } from "../utils/log-failure";
import { shareItem, type ShareItem } from "./item";

/** What a pane, or a part of the kit it is drawn with, says it is on. */
export interface PaneShareItemPart {
  title?: string | null;
  excerpt?: string | null;
}

type PaneShareItemInput = PaneShareItemPart | null | (() => PaneShareItemPart | null);

interface Entry {
  read(): PaneShareItemPart | null;
  /** Said by the kit (a stack's open detail, a reader's text), which a pane's own word outranks. */
  kit: boolean;
  order: number;
}

const entries = new Map<string, Set<Entry>>();
let nextOrder = 0;

/**
 * Says what the pane is on now, for Share to keep with its link: the story
 * it has open, the result it has picked. Pass null when it is on nothing in
 * particular, and a function for an item that takes work to put together:
 * it is read only when a link is made. A tab that is not shown says nothing. `kit` marks the shared components'
 * own guesses (a stack's detail title, a reader's opening), which a pane's
 * own item outranks; they combine, so a stack's title takes its reader's
 * opening as its excerpt.
 */
export function usePaneShareItem(item: PaneShareItemInput, options: { paneId?: string; kit?: boolean } = {}): void {
  const contextPaneId = useOptionalPaneInstanceId();
  const paneId = options.paneId ?? contextPaneId;
  const shown = usePaneFooterScopeActive();
  const latest = useRef(item);
  latest.current = item;
  const kit = options.kit === true;
  useEffect(() => {
    if (!paneId || !shown) return;
    const entry: Entry = {
      read: () => {
        const current = latest.current;
        return typeof current === "function" ? current() : current;
      },
      kit,
      order: ++nextOrder,
    };
    let set = entries.get(paneId);
    if (!set) entries.set(paneId, set = new Set());
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0 && entries.get(paneId) === set) entries.delete(paneId);
    };
  }, [kit, paneId, shown]);
}

function readEntry(entry: Entry): PaneShareItemPart | null {
  try {
    return entry.read();
  } catch (error) {
    logFailure("shares.pane-item", "Reading what a pane is on failed")(error);
    return null;
  }
}

/**
 * What the pane says it is on: the pane's own item first, then the kit's,
 * the one shown last first within each. A title without an excerpt takes the
 * kit's excerpt (a stack's title, its reader's opening).
 */
export function declaredPaneShareItem(paneId: string): PaneShareItemPart | null {
  const said = [...entries.get(paneId) ?? []]
    .sort((a, b) => Number(a.kit) - Number(b.kit) || b.order - a.order)
    .map((entry) => ({ entry, part: readEntry(entry) }))
    .filter((said): said is { entry: Entry; part: PaneShareItemPart } => !!said.part);
  const titled = said.find(({ part }) => part.title?.trim());
  if (!titled) return null;
  const excerpt = titled.part.excerpt?.trim()
    || said.find(({ entry, part }) => entry.kit && entry !== titled.entry && part.excerpt?.trim())?.part.excerpt;
  return { title: titled.part.title, excerpt: excerpt || null };
}

export interface PaneShareItemSource {
  /** The pane's instance id. */
  paneId: string;
  /** The pane's name. */
  paneName: string;
  /** The one ticker the pane shows, with what is known of it; not a list's cursor. */
  ticker?: { symbol: string; name?: string; exchange?: string; sector?: string; industry?: string } | null;
  /** The argument the pane's function was opened with (`NI CRYPTO`), as its option names it. */
  argument?: { label: string; description?: string } | null;
}

/**
 * The item a share keeps: what the pane says it is on, else the ticker it
 * shows, else the argument its function was opened with; null when it is on
 * none of these.
 */
export function resolvePaneShareItem(source: PaneShareItemSource): ShareItem | null {
  const declared = shareItem(source.paneName, declaredPaneShareItem(source.paneId));
  if (declared) return declared;
  const ticker = source.ticker;
  if (ticker?.symbol) {
    const symbol = ticker.symbol.split(":")[0] || ticker.symbol;
    const name = ticker.name?.trim();
    return shareItem(source.paneName, {
      title: name && name !== symbol ? `${name} (${symbol})` : ticker.symbol,
      excerpt: [ticker.exchange, ticker.sector, ticker.industry].filter(Boolean).join(" · "),
    });
  }
  if (source.argument) return shareItem(source.paneName, { title: source.argument.label, excerpt: source.argument.description });
  return null;
}

/**
 * The argument a pane's function was opened with, read from its title as the
 * function wrote it (`NI CRYPTO`), named as the function's options name it. A
 * ticker is not one: the pane's ticker says more.
 */
function functionArgument(
  templates: ReadonlyMap<string, PaneTemplateDef>,
  paneType: string,
  title: string | undefined,
): PaneShareItemSource["argument"] {
  const [code = "", ...words] = (title ?? "").trim().split(/\s+/);
  const argument = words.join(" ");
  if (!argument) return null;
  const opens = (prefix: string) => prefix.toUpperCase() === code.toUpperCase();
  const template = [...templates.values()].find((candidate) => candidate.paneId === paneType
    && !!candidate.shortcut
    && (opens(candidate.shortcut.prefix) || (candidate.shortcut.aliases ?? []).some(opens)));
  const shortcut = template?.shortcut;
  if (!shortcut || shortcut.argKind === "ticker") return null;
  let label: string | undefined;
  try {
    label = shortcut.argOptions?.().find((option) => option.value.toUpperCase() === argument.toUpperCase())?.label;
  } catch (error) {
    logFailure("shares.pane-item", "Reading a function's argument options failed")(error);
  }
  return { label: label ?? argument, description: template.description };
}

/** Fields the pane keeps on the device when shared, so nothing it shows may stand in for them. */
function keepsFieldsPrivate(pane: Pick<ResolvedPane, "def">): boolean {
  const kept = pane.def.portableShare?.private;
  return !!kept && Object.values(kept).some((fields) => fields === true || (Array.isArray(fields) && fields.length > 0));
}

/**
 * The item a public link to the pane keeps, or null. A pane that shows the
 * person's own data, or keeps fields of its own off a share, keeps none: what
 * it is on would say what its settings leave out.
 */
export function paneShareItemFor({ pane, state, templates, personal }: {
  pane: Pick<ResolvedPane, "instance" | "def">;
  state: Pick<AppState, "tickers"> & Parameters<typeof resolveTickerForPane>[0];
  templates: ReadonlyMap<string, PaneTemplateDef>;
  /** Whether the pane shows the person's own data now (personal-pane.ts). */
  personal: boolean;
}): ShareItem | null {
  if (personal || keepsFieldsPrivate(pane)) return null;
  const { instance, def } = pane;
  // A list's cursor is where the list is, not something picked to share.
  const symbol = def.tickerSource ? null : resolveTickerForPane(state, instance.instanceId);
  const metadata = symbol ? state.tickers.get(symbol)?.metadata : undefined;
  return resolvePaneShareItem({
    paneId: instance.instanceId,
    paneName: def.name,
    ticker: symbol ? {
      symbol,
      name: metadata?.name,
      exchange: metadata?.exchange,
      sector: metadata?.sector,
      industry: metadata?.industry,
    } : null,
    argument: functionArgument(templates, instance.paneId, instance.title),
  });
}
