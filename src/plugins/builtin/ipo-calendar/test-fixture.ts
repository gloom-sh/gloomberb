import type { IpoDeal } from "../../../api-client/ipo";

/** A Nasdaq deal with nothing known yet; tests set what they read. */
export function ipoDeal(overrides: Partial<IpoDeal> & Pick<IpoDeal, "id">): IpoDeal {
  return {
    company: overrides.id,
    companyLocal: null,
    symbol: null,
    mic: "XNAS",
    exchange: "NASDAQ",
    venue: "Nasdaq",
    segment: null,
    country: "US",
    region: "us",
    timezone: "America/New_York",
    listingDate: null,
    dateKind: null,
    subscriptionOpen: null,
    subscriptionClose: null,
    currency: "USD",
    priceLow: null,
    priceHigh: null,
    offerPrice: null,
    sharesOffered: null,
    offerSize: null,
    offerSizeUsd: null,
    status: "upcoming",
    listingType: "ipo",
    filedDate: null,
    firstDay: null,
    updatedAt: "2026-09-29T00:00:00Z",
    ...overrides,
  };
}
