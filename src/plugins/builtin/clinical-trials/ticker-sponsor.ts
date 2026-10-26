import type { DataProvider } from "../../../types/data-provider";
import { shortCompanyName } from "../../../tickers/company-name";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";

/**
 * The company a ticker is, by the name a registry files its studies under:
 * VKTX is "Viking Therapeutics". Read from the listing's quote, which names
 * it; a fund or a contract is no sponsor. Null when no share trades under it.
 */
export async function tickerSponsorName(dataProvider: Pick<DataProvider, "getQuote"> | null, ticker: string): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!dataProvider || !symbol) return null;
  const quote = await dataProvider.getQuote(symbol).catch(() => null);
  const name = quote?.name?.trim();
  const kind = classifyInstrumentKind(quote?.instrumentType);
  return name && kind !== "fund" && kind !== "derivative" ? shortCompanyName(name) : null;
}
