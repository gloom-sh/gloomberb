import type { DataProvider } from "../types/data-provider";
import { isNoSourceAnswer } from "../sources/provider-errors";
import { bareListingExchange } from "../tickers/listing-venues";
import { logFailure } from "../utils/log-failure";
import { listingAbroadVenue } from "../utils/sec";
import type { InstrumentRef } from "./request-types";

export async function resolveOptionScreenListings(
  instruments: readonly InstrumentRef[], dataProvider: DataProvider | null,
): Promise<InstrumentRef[]> {
  return Promise.all(instruments.map(async (instrument) => {
    const { symbol, exchange } = instrument;
    if (!dataProvider || exchange || !/^[A-Z0-9]{1,10}$/.test(symbol) || dataProvider.knownUsStock?.(symbol)) return instrument;
    try {
      const quote = await dataProvider.getQuote(symbol, "");
      const venue = listingAbroadVenue(symbol, quote.listingExchangeName || quote.exchangeName);
      return venue ? { ...instrument, exchange: venue } : instrument;
    } catch (error) {
      if (!isNoSourceAnswer(error)) return logFailure("options-listings", "Could not resolve option underlying", instrument)(error);
      const venue = await bareListingExchange(symbol, { dataProvider })
        .catch(logFailure("options-listings", "Could not resolve option underlying", ""));
      return listingAbroadVenue(symbol, venue) ? { ...instrument, exchange: venue } : instrument;
    }
  }));
}
