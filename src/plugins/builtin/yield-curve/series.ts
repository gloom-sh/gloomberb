import { apiClient } from "../../../api-client";
import type { CloudCurveId } from "../../../api-client/yield-curves";
import { fredSeriesUrl } from "../../../sources/gloomberb-cloud/fred-series";
import type { SeriesDefinition } from "../../../series/types";
import { unavailableOnServer } from "../shared/cloud-resource";
import { TREASURY_MATURITIES } from "./treasury-data";

/** Each Treasury constant maturity the curve draws, as `UST:10Y`. */
export const TREASURY_SERIES: readonly SeriesDefinition[] = TREASURY_MATURITIES.map((entry) => ({
  id: `ust:${entry.maturity}`,
  name: `${entry.maturity} Treasury yield`,
  unit: "%",
  frequency: "daily",
  group: "Rates",
  tags: ["treasury", "yield curve", entry.seriesId],
  publisher: "FRED",
  url: fredSeriesUrl(entry.seriesId),
  expression: `UST:${entry.maturity}`,
}));

/** The government curves stored beside the Treasury's, with the tenors each publisher prints. */
const CURVES: ReadonlyArray<{
  curve: CloudCurveId;
  name: (tenor: string) => string;
  publisher: string;
  tags: readonly string[];
  tenors: readonly string[];
}> = [
  {
    curve: "de", publisher: "Bundesbank", tags: ["Germany", "Bund", "euro"],
    name: (tenor) => `Germany ${tenor} Bund yield`,
    tenors: ["1Y", "2Y", "3Y", "4Y", "5Y", "6Y", "7Y", "8Y", "9Y", "10Y", "15Y", "20Y", "25Y", "30Y"],
  },
  {
    curve: "gb", publisher: "Bank of England", tags: ["UK", "gilt", "sterling", "zero coupon"],
    name: (tenor) => `UK ${tenor} gilt yield (zero coupon)`,
    tenors: ["6M", "1Y", "2Y", "3Y", "4Y", "5Y", "7Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"],
  },
  {
    curve: "jp", publisher: "Japan Ministry of Finance", tags: ["Japan", "JGB", "yen"],
    name: (tenor) => `Japan ${tenor} JGB yield`,
    tenors: ["1Y", "2Y", "3Y", "4Y", "5Y", "6Y", "7Y", "8Y", "9Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"],
  },
  {
    curve: "ca", publisher: "Bank of Canada", tags: ["Canada", "benchmark"],
    name: (tenor) => `Canada ${tenor} benchmark yield`,
    tenors: ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "30Y"],
  },
  {
    curve: "eu-aaa", publisher: "ECB", tags: ["euro area", "AAA", "euro"],
    name: (tenor) => `Euro area AAA ${tenor} yield`,
    tenors: ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
  },
  {
    // FRED lists the 5Y and 10Y; the curve has the rest.
    curve: "us-real", publisher: "U.S. Treasury", tags: ["TIPS", "real yield", "treasury"],
    name: (tenor) => `${tenor} TIPS real yield`,
    tenors: ["7Y", "20Y", "30Y"],
  },
  {
    curve: "us-breakeven", publisher: "U.S. Treasury", tags: ["breakeven", "inflation expectations", "treasury"],
    name: (tenor) => `${tenor} breakeven inflation (nominal less TIPS)`,
    tenors: ["7Y", "20Y", "30Y"],
  },
];

/** Each tenor of each government curve the yield curve pane draws, over time. */
export const GOVERNMENT_BOND_SERIES: readonly SeriesDefinition[] = CURVES.flatMap(({ curve, name, publisher, tags, tenors }) => (
  tenors.map((tenor): SeriesDefinition => ({
    id: `bond-yield:${curve}-${tenor.toLowerCase()}`,
    name: name(tenor),
    unit: "%",
    frequency: "daily",
    group: "Rates",
    tags: [...tags, "government bond", "yield curve", tenor],
    publisher,
    load: async ({ start }) => {
      try {
        const history = await apiClient.getCloudCurveHistory(curve, tenor, start?.toISOString().slice(0, 10));
        return history.points;
      } catch (error) {
        throw unavailableOnServer(error, `${name(tenor)} history is not available yet.`);
      }
    },
  }))
));
