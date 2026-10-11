import type { SeriesDefinition } from "../../../series/types";
import { loadShortInterest } from "./client";

/** A ticker's twice-monthly short interest and its days to cover, as reported at each settlement. */
export const SHORT_INTEREST_SERIES: readonly SeriesDefinition[] = [
  {
    id: "short-interest:shares",
    name: "Short interest",
    unit: "shares",
    frequency: "irregular",
    group: "Positioning",
    tags: ["short interest", "shorts", "settlement"],
    publisher: "FINRA",
    input: "ticker",
    style: "step",
    load: async ({ ticker }) => {
      const { records } = await loadShortInterest(ticker!);
      return records.map((record) => ({ date: record.settlementDate, value: record.sharesShort }));
    },
  },
  {
    id: "short-interest:days-to-cover",
    name: "Short interest days to cover",
    unit: "days",
    frequency: "irregular",
    group: "Positioning",
    tags: ["short interest", "short ratio", "days to cover"],
    publisher: "FINRA",
    input: "ticker",
    style: "step",
    load: async ({ ticker }) => {
      const { records } = await loadShortInterest(ticker!);
      return records.map((record) => ({ date: record.settlementDate, value: record.shortRatio }));
    },
  },
];
