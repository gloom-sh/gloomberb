import { TICKER_RESEARCH_PANE_ID, type PaneInstanceConfig } from "../types/config";
import type { BrokerContractRef } from "../types/instrument";

const PANE_TITLE_MNEMONIC = /^([A-Z][A-Z0-9]{0,7})(?=\s|$)/;

/** The command a ticker template titled its pane with: "OMON" in "OMON AAPL". */
export function paneTitleMnemonic(title: string | undefined): string | null {
  return title?.trim().match(PANE_TITLE_MNEMONIC)?.[1] ?? null;
}

/**
 * Pins a follower on the symbol it shows (unlink, a closed source, a single-pane share), or
 * unbinds it when nothing resolved. A pane linked from its menu keeps only its command as a title
 * ("OMON"), so the pin names the ticker again ("OMON MSFT"). Ticker Research computes its own
 * title and is never retitled.
 */
export function pinFollowingPane(
  instance: PaneInstanceConfig,
  symbol: string | null | undefined,
  instrument?: BrokerContractRef | null,
): PaneInstanceConfig {
  const pinned = symbol?.trim();
  if (!pinned) return { ...instance, binding: { kind: "none" } };
  const title = instance.title?.trim();
  const bareMnemonic = instance.paneId !== TICKER_RESEARCH_PANE_ID && !!title && paneTitleMnemonic(title) === title;
  return {
    ...instance,
    // Only a broker contract is worth keeping: a derived public `null` would stop the pinned pane
    // matching `T AAPL` reuse, which tells null and unspecified contracts apart.
    binding: { kind: "fixed", symbol: pinned, ...(instrument ? { instrument } : {}) },
    ...(bareMnemonic ? { title: `${title} ${pinned}` } : {}),
  };
}
