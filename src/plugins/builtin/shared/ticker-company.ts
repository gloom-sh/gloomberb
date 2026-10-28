import { logFailure } from "../../../utils/log-failure";
import type { DataProvider } from "../../../types/data-provider";
import { shortCompanyName } from "../../../tickers/company-name";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";

/**
 * A search typed as a ticker (`TRIAL VKTX`, `FDA AZN`): one to five letters,
 * with a share class. Registries know companies by name, so a symbol no record
 * mentions is looked up as its company.
 */
export function looksLikeTicker(term: string): boolean {
  return /^[A-Za-z]{1,5}(?:[.-][A-Za-z])?$/.test(term.trim());
}

/**
 * The company a ticker is, by the name a registry files its records under:
 * VKTX is "Viking Therapeutics", AZN "AstraZeneca". Read from the listing's
 * quote, which names it; a fund or a contract is no company. Null when no
 * share trades under it.
 */
export async function tickerCompanyName(dataProvider: Pick<DataProvider, "getQuote"> | null, ticker: string): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!dataProvider || !symbol) return null;
  const quote = await dataProvider.getQuote(symbol).catch(logFailure("shared.ticker-company", "Read company name quote failed", null));
  const name = quote?.name?.trim();
  const kind = classifyInstrumentKind(quote?.instrumentType);
  return name && kind !== "fund" && kind !== "derivative" ? shortCompanyName(name) : null;
}
