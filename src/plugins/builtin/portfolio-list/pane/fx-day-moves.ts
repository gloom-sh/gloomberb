import { useEffect, useState } from "react";
import { fxQuoteRateMove, readFxQuoteRate } from "../../../../cli/fx-quote-rate";
import { heldCurrencyUnit } from "../../../../utils/currency-units";
import { logFailure } from "../../../../utils/log-failure";
import { useAssetData } from "../../../runtime";

/** How often the pairs' moves are read again; the move a book's day holds drifts with the FX market. */
const FX_DAY_MOVE_REFRESH_MS = 5 * 60_000;

const NO_MOVES: ReadonlyMap<string, number> = new Map();

/**
 * Each currency's move on the day against the book's, as a factor (1.001 for
 * +0.1%), read as `fx` reads a pair's from its previous daily close, so the
 * pane's Day's move holds a foreign holding's currency move as `portfolio
 * show` does (`calculatePortfolioSummaryTotals`). A currency whose pair has no
 * close to read against is left out, and moves with its price alone.
 */
export function useFxDayMoves(currencies: readonly string[], totalsCurrency: string): ReadonlyMap<string, number> {
  const dataProvider = useAssetData();
  const [moves, setMoves] = useState<ReadonlyMap<string, number>>(NO_MOVES);
  const key = [...new Set(currencies.filter((currency) => heldCurrencyUnit(currency).currency !== heldCurrencyUnit(totalsCurrency).currency))]
    .sort().join(",");
  useEffect(() => {
    const getQuotesBatch = dataProvider?.getQuotesBatch?.bind(dataProvider);
    if (!getQuotesBatch || !key) {
      setMoves(NO_MOVES);
      return;
    }
    let cancelled = false;
    const read = async () => {
      const into = heldCurrencyUnit(totalsCurrency).currency;
      const read = await Promise.all(key.split(",").map(async (currency) => {
        const rate = await readFxQuoteRate(heldCurrencyUnit(currency).currency, into, getQuotesBatch)
          .catch(logFailure("portfolio-list.fx-day-moves", "Could not read the FX move on the day", null));
        const move = rate && "rate" in rate ? fxQuoteRateMove(rate) : null;
        return move ? [[currency, 1 + move.percent / 100] as const] : [];
      }));
      if (!cancelled) setMoves(new Map(read.flat()));
    };
    void read();
    const timer = setInterval(() => { void read(); }, FX_DAY_MOVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dataProvider, key, totalsCurrency]);
  return moves;
}
