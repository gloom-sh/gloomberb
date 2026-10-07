import { TICKER_RESEARCH_PANE_ID, type PaneInstanceConfig } from "../types/config";
import type { BrokerContractRef } from "../types/instrument";

const PANE_TITLE_MNEMONIC = /^([A-Z][A-Z0-9]{0,7})(?=\s|$)/;
/** One ticker key as a template writes it after the command: "AAPL", "BRK.B", "BTC-USD:CCC", "^SPX". */
const TITLE_TICKER = /^[A-Z0-9^][A-Z0-9.^_/=-]*(?::[A-Z0-9._-]+)?$/;

/** The command a ticker template titled its pane with: "OMON" in "OMON AAPL". */
export function paneTitleMnemonic(title: string | undefined): string | null {
  return title?.trim().match(PANE_TITLE_MNEMONIC)?.[1] ?? null;
}

/**
 * The title a pin gives a follower: a pane linked from its menu keeps only its command ("OMON"),
 * and one linked some other way still names the ticker it opened on ("OMON AAPL"); both name the
 * pinned ticker ("OMON MSFT"). Any other title is the user's or the pane's own and stays.
 */
function pinnedTitle(instance: PaneInstanceConfig, pinned: string): string | null {
  if (instance.paneId === TICKER_RESEARCH_PANE_ID) return null;
  const title = instance.title?.trim();
  const mnemonic = paneTitleMnemonic(title);
  if (!title || !mnemonic) return null;
  const rest = title.slice(mnemonic.length).trim();
  return !rest || TITLE_TICKER.test(rest) ? `${mnemonic} ${pinned}` : null;
}

/**
 * Pins a follower on the symbol it shows (unlink, a closed source, a single-pane share), or
 * unbinds it when nothing resolved, retitled to name that symbol. Ticker Research computes its
 * own title and is never retitled.
 */
export function pinFollowingPane(
  instance: PaneInstanceConfig,
  symbol: string | null | undefined,
  instrument?: BrokerContractRef | null,
): PaneInstanceConfig {
  const pinned = symbol?.trim();
  if (!pinned) return { ...instance, binding: { kind: "none" } };
  const title = pinnedTitle(instance, pinned);
  return {
    ...instance,
    // Only a broker contract is worth keeping: a derived public `null` would stop the pinned pane
    // matching `T AAPL` reuse, which tells null and unspecified contracts apart.
    binding: { kind: "fixed", symbol: pinned, ...(instrument ? { instrument } : {}) },
    ...(title ? { title } : {}),
  };
}
