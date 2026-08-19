import type { PredictionColumnDef } from "./types";

export const PREDICTION_COLUMN_DEFS: PredictionColumnDef[] = [
  {
    id: "watch",
    label: "★",
    width: 2,
    align: "left",
    description: "Star a market for the prediction watchlist.",
  },
  {
    id: "market",
    label: "MARKET",
    width: 34,
    align: "left",
    description: "Event or primary question.",
  },
  {
    id: "target",
    label: "TARGET",
    width: 18,
    align: "left",
    description: "Selected contract or top target for grouped events.",
  },
  {
    id: "venue",
    label: "VENUE",
    width: 9,
    align: "left",
    description: "Prediction venue.",
  },
  {
    id: "yes",
    label: "TOP ODDS",
    width: 20,
    align: "left",
    description:
      "Implied probability, with the leading target shown inline for grouped events.",
  },
  {
    id: "spread",
    label: "SPR",
    width: 7,
    align: "right",
    description: "Best spread.",
  },
  {
    id: "vol_24h",
    label: "VOL24H",
    width: 11,
    align: "right",
    description: "24-hour venue-native volume.",
  },
  {
    id: "open_interest",
    // One cell wider than the value needs: OI is right aligned and ENDS is left
    // aligned, so without the slack the two headers read as one "OI ENDS" word.
    label: "OI",
    width: 11,
    align: "right",
    description: "Open interest.",
  },
  {
    id: "ends",
    label: "ENDS",
    width: 15,
    align: "left",
    description: "Market close time.",
  },
  {
    id: "status",
    label: "STATUS",
    width: 8,
    align: "left",
    description: "Market status.",
  },
  {
    id: "event",
    label: "EVENT",
    width: 28,
    align: "left",
    description: "Parent event or series.",
  },
  {
    id: "category",
    label: "CAT",
    width: 12,
    align: "left",
    description: "Venue category.",
  },
  {
    id: "vol_total",
    label: "TOTALVOL",
    width: 11,
    align: "right",
    description: "Total venue-native volume.",
  },
  {
    id: "liquidity",
    label: "LIQ",
    width: 11,
    align: "right",
    description: "Available liquidity.",
  },
  {
    id: "updated",
    label: "UPDATED",
    width: 10,
    align: "left",
    description: "Last upstream update age.",
  },
  {
    id: "market_id",
    label: "ID",
    width: 20,
    align: "left",
    description: "Venue market identifier.",
  },
];

export const DEFAULT_PREDICTION_COLUMN_IDS = [
  "watch",
  "market",
  "venue",
  "yes",
  "spread",
  "vol_24h",
  "open_interest",
  "ends",
];

export const PREDICTION_COLUMNS_BY_ID = new Map(
  PREDICTION_COLUMN_DEFS.map((column) => [column.id, column]),
);
