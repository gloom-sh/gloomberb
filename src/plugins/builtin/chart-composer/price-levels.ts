import { publicTickerKey } from "../../../utils/exchanges";
import { futuresGenericListing } from "../../../utils/futures-generic";
import { isFiniteNumber } from "../../../utils/guards";

/**
 * Horizontal price levels drawn on a ticker. They live in the synced plugin
 * config keyed by listing, not in a pane, so every chart of the ticker shows
 * them and they follow the account to other machines.
 */
export const PRICE_LEVELS_KEY = "priceLevels";
export const DEFAULT_LEVEL_COLOR = "#f5a524";
const MAX_LEVELS_PER_TICKER = 24;
const MAX_TICKERS = 400;

interface PriceLevel {
  id: string;
  price: number;
  color: string;
}

export type PriceLevelStore = Record<string, PriceLevel[]>;

export type PriceLevelEdit =
  | { kind: "add"; id: string; price: number }
  | { kind: "move"; id: string; price: number }
  | { kind: "remove"; id: string };

/**
 * The key levels are kept under. Pass the exchange the chart resolved, so every
 * chart of a listing agrees. A generic future is keyed by its root and position
 * alone: its venue follows from the root, and a typed G CL1 carries none while
 * the research tab carries the ticker's, and the Roll and Adjust controls
 * rewrite the ticker (CL1F5R) without changing what the levels mark.
 */
export function priceLevelTickerKey(symbol: string, exchange?: string): string {
  const generic = futuresGenericListing(symbol, exchange);
  return generic ? `${generic.root}${generic.position}` : publicTickerKey(symbol, exchange);
}

function parseLevel(value: unknown): PriceLevel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, price, color } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || id.length > 80 || !isFiniteNumber(price)) return null;
  return {
    id,
    price,
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_LEVEL_COLOR,
  };
}

/**
 * The stored levels, dropping anything malformed rather than the whole store.
 * An edit moves its listing to the end, so past the cap the listings edited
 * longest ago go, never the one just drawn on.
 */
export function parsePriceLevels(value: unknown): PriceLevelStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const store: PriceLevelStore = {};
  for (const [key, entries] of Object.entries(value as Record<string, unknown>).slice(-MAX_TICKERS)) {
    if (!key || !Array.isArray(entries)) continue;
    const levels = entries.flatMap((entry) => parseLevel(entry) ?? []).slice(0, MAX_LEVELS_PER_TICKER);
    if (levels.length > 0) store[key] = levels;
  }
  return store;
}

export function editPriceLevels(store: PriceLevelStore, key: string, edit: PriceLevelEdit): PriceLevelStore {
  const current = store[key] ?? [];
  // A second Enter at the same cursor would stack an identical level that
  // Backspace then seems unable to delete.
  if (edit.kind === "add" && current.some((level) => level.price === edit.price && level.id !== edit.id)) return store;
  const next = edit.kind === "add"
    ? [...current.filter((level) => level.id !== edit.id), { id: edit.id, price: edit.price, color: DEFAULT_LEVEL_COLOR }]
      .slice(-MAX_LEVELS_PER_TICKER)
    : edit.kind === "move"
      ? current.map((level) => level.id === edit.id ? { ...level, price: edit.price } : level)
      : current.filter((level) => level.id !== edit.id);
  const { [key]: _previous, ...rest } = store;
  return next.length > 0 ? { ...rest, [key]: next } : rest;
}
