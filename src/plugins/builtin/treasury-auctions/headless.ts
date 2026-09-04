import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { fetchTreasuryAuctions } from "./client";
import { loadTreasuryAuctions, type TreasuryAuctionsResult } from "./cache";
import {
  auctionSize,
  DEFAULT_AUCTION_SORT,
  indirectPct,
  rateValue,
  visibleAuctions,
  type AuctionFilter,
} from "./model";

const COLUMNS = [
  { key: "auctionDate", header: "Date" },
  { key: "secType", header: "Type" },
  { key: "securityTerm", header: "Term" },
  { key: "rate", header: "Rate", align: "right" as const, format: (value: unknown) => value == null ? "-" : `${Number(value).toFixed(3)}%` },
  { key: "bidToCoverRatio", header: "B/C", align: "right" as const, format: (value: unknown) => value == null ? "-" : Number(value).toFixed(2) },
  { key: "indirectPercent", header: "Indirect", align: "right" as const, format: (value: unknown) => value == null ? "-" : `${Number(value).toFixed(1)}%` },
  { key: "size", header: "Size", align: "right" as const, format: (value: unknown) => value == null ? "-" : `$${formatCompact(Number(value))}` },
  { key: "cusip", header: "CUSIP" },
];

export interface TreasuryAuctionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, historyDays: number): Promise<TreasuryAuctionsResult>;
}

const defaultDependencies: TreasuryAuctionsHeadlessDependencies = {
  load: (_args, historyDays) => loadTreasuryAuctions(false, fetchTreasuryAuctions, historyDays),
};

export function createTreasuryAuctionsHeadless(
  dependencies: TreasuryAuctionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "free-text",
      placeholder: "search",
      description: "Optional security type, term, or auction date filter.",
      optional: true,
    },
    options: [
      {
        key: "historyDays",
        aliases: ["history"],
        settingKey: "historyDays",
        description: "Auction history window in days.",
        type: "enum",
        values: [{ value: "30" }, { value: "90" }, { value: "120" }, { value: "365" }],
        defaultValue: "120",
      },
      {
        key: "filter",
        description: "Security type group.",
        type: "enum",
        values: [{ value: "all" }, { value: "bill" }, { value: "note" }, { value: "bond" }],
        defaultValue: "all",
      },
    ],
    columns: COLUMNS,
    describe: (args) => `Treasury Auctions | ${String(args.options.historyDays)} days | ${String(args.options.filter)}`,
    async load(args) {
      const historyDays = Number(args.options.historyDays);
      const filter = args.options.filter as AuctionFilter;
      const result = await dependencies.load(args, historyDays);
      const query = typeof args.argument === "string" ? args.argument : "";
      const auctions = visibleAuctions(result.auctions, {
        filter,
        query,
        sort: DEFAULT_AUCTION_SORT,
      });
      return {
        rows: auctions.map((auction) => ({
          ...auction,
          rate: rateValue(auction),
          indirectPercent: indirectPct(auction),
          size: auctionSize(auction),
        })),
        metadata: {
          fetchedAt: result.fetchedAt,
          stale: result.stale,
          historyDays,
          filter,
        },
      };
    },
  };
}

export const treasuryAuctionsHeadless = createTreasuryAuctionsHeadless();
