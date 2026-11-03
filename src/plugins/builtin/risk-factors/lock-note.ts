import { getWallSummary, type WallSummary } from "../../../api-client/wall-summary";
import type { PaneLock } from "../../../types/plugin";
import { filesForm } from "../shared/free-routes";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { proLockNote, type FreeRoute } from "../shared/pro-lock-note";

type ReadSummary = (wall: string, symbol: string, exchange?: string) => Promise<WallSummary | null>;

/**
 * The company's risk factor page on gloom.sh, which needs no account: each
 * 10-K's risks with what was added, dropped or reworded. It is there for a
 * company RISK has read a 10-K of, which the public wall summary counts.
 */
function webRoute(readSummary: ReadSummary): FreeRoute {
  return {
    text: (ticker, company) => `gloom.sh/stocks/${ticker.toLowerCase()}/risk-factors has ${company}'s risk factors from each 10-K, with what was added, dropped or reworded since the year before.`,
    answers: async (symbol, context) => {
      const { symbol: ticker, exchange } = await resolveHeadlessInstrument(context, symbol);
      const summary = await readSummary("risk-wall", ticker, exchange);
      return summary?.items.some((item) => item.label === "risk_count" && Number(item.value) > 0) ?? false;
    },
  };
}

/**
 * RISK is Pro whole (`useProFeatureWall`). Its reports are open on gloom.sh,
 * one page per company, and the 10-Ks it reads are in the SEC filing list,
 * which needs no account either: `filings` lists them with a link to each,
 * where Item 1A is the risk factors as written. A foreign issuer files a 20-F
 * instead (ASML), whose Item 3.D holds them. A company that files neither
 * (IAG on LSE) has nothing in RISK either, and the note says so.
 */
export function riskFactorsLockNote(lock: PaneLock, readSummary: ReadSummary = getWallSummary): Promise<string> {
  return proLockNote(lock, {
    token: "RISK",
    does: "it groups a 10-K's risk factors by theme and shows what was added, dropped or reworded since the year before",
    shows: "it",
    free: [webRoute(readSummary), {
      text: (ticker, company) => `gloom filings ${ticker} --form 10-K lists ${company}'s annual reports, each with its filing date and a link to the filing, whose Item 1A holds the risk factors as written.`,
      answers: (symbol, context) => filesForm(symbol, "10-K", context),
    }, {
      text: (ticker, company) => `gloom filings ${ticker} --form 20-F lists ${company}'s annual reports, each with its filing date and a link to the filing, whose Item 3.D holds the risk factors as written.`,
      answers: (symbol, context) => filesForm(symbol, "20-F", context),
    }],
    noneFor: (ticker) => `${ticker}'s company files no 10-K or 20-F with the SEC, so RISK has no risk factors for it.`,
  });
}
