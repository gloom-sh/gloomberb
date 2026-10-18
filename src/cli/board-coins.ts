import { apiClient } from "../api-client";
import type { CryptoMarketAsset } from "../api-client/crypto-markets";
import { logFailure } from "../utils/log-failure";

/** A coin on the crypto board as a hint names it: its one symbol and its name. */
export interface BoardCoin {
  symbol: string;
  name: string;
}

type BoardEntry = Pick<CryptoMarketAsset, "symbol" | "code" | "name" | "marketCap">;

/** How long a hint waits for the board; a slow board leaves the plain search hint. */
const BOARD_TIMEOUT_MS = 4_000;
const BARE_NOT_A_TICKER = /Not a ticker: ([A-Za-z0-9]+)\./;

let board: readonly BoardEntry[] | null = null;
let loading: Promise<void> | null = null;

/**
 * Reads the crypto board once, when some text says a bare word is not a
 * ticker, so `boardCoinFor` can name the coin it may be. Never throws; a
 * board that fails or is slow leaves the hints as they were.
 */
export async function primeBoardCoins(
  texts: ReadonlyArray<string | null | undefined>,
  load: () => Promise<{ assets: readonly BoardEntry[] }> = () => apiClient.getCloudCryptoMarkets(),
): Promise<void> {
  if (board || !texts.some((text) => !!text && BARE_NOT_A_TICKER.test(text))) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  loading ??= Promise.race([
    load().then((data) => { board = boardEntries(data.assets); }),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, BOARD_TIMEOUT_MS); }),
  ]).catch(logFailure("cli.board-coins", "Read the crypto board for a coin hint failed")).finally(() => clearTimeout(timer));
  await loading;
}

/** The board's coins a hint can name: a symbol, a code and a name each. */
function boardEntries(assets: unknown): BoardEntry[] {
  return (Array.isArray(assets) ? assets : []).filter((asset): asset is BoardEntry => !!asset
    && typeof asset.symbol === "string" && /^[A-Z0-9]+-USD$/.test(asset.symbol)
    && typeof asset.code === "string" && !!asset.code && typeof asset.name === "string");
}

const compact = (text: string) => text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The board coin a bare word that is no ticker most likely means: its code
 * (USDT, USDS, USDE) or its name (TETHER for Tether USDt, BITCOIN), the
 * largest by market cap when several answer. Null before the board is read,
 * and for anything else.
 */
export function boardCoinFor(typed: string): BoardCoin | null {
  const id = typed.trim().replace(/^\$/, "").toUpperCase();
  if (!board || !/^[A-Z0-9]+$/.test(id)) return null;
  const byCode = board.filter((coin) => coin.code.toUpperCase() === id);
  const byName = byCode.length ? [] : board.filter((coin) => {
    const name = compact(coin.name);
    const first = compact(coin.name.split(/\s+/)[0] ?? "");
    return name === id || (id.length >= 5 && first === id);
  });
  const best = [...byCode.length ? byCode : byName].sort((left, right) => (right.marketCap ?? 0) - (left.marketCap ?? 0))[0];
  return best ? { symbol: best.symbol, name: best.name } : null;
}

/** For tests: forget the board read. */
export function resetBoardCoins(entries: readonly BoardEntry[] | null = null): void {
  board = entries;
  loading = null;
}
