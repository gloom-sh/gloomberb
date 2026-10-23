import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { DATE_OPTION_EXAMPLES, isoDateOption } from "../../../utils/calendar-date";
import { formatCompact, formatNumber } from "../../../utils/format";
import type { ShortInterestResult } from "./client";
import {
  buildRows,
  sortRows,
  type SortPreference,
} from "./model";
import { shortInterestFreshness, shortInterestPublished } from "./schedule";
import type { ShortInterestRecord } from "./types";
import { loadShortInterestWithFloat } from "./watch-client";
import { REPORT_ROWS, REPORT_SORT } from "../shared/headless-options";

const SHORT_INTEREST_COLUMNS: HeadlessPaneColumn[] = [
  { key: "settlementDate", header: "Date" },
  // When FINRA published the settlement: what a trader could see that day.
  { key: "publishedDate", header: "Published" },
  {
    key: "sharesShort",
    header: "Shares Short",
    align: "right",
    format: (value) => formatCompact(Number(value)),
  },
  {
    key: "daysToCover",
    header: "Days to cover",
    align: "right",
    format: (value) => value == null ? "-" : formatNumber(Number(value), 2),
  },
  {
    key: "averageDailyVolume",
    header: "Avg Daily Vol",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: "shortPercentFloat",
    header: "% Float",
    align: "right",
    format: (value) => value == null ? "-" : `${formatNumber(Number(value), 2)}%`,
  },
  // The day of the share count the float is held within.
  { key: "floatAsOf", header: "Float As Of", align: "right" },
];

export interface ShortInterestHeadlessDependencies {
  loadRecords(
    symbol: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<ShortInterestRecord[] | ShortInterestResult>;
}

const defaultDependencies: ShortInterestHeadlessDependencies = {
  loadRecords: (symbol, args, ctx) => loadShortInterestWithFloat(symbol, {
    marketData: ctx.marketData,
    client: ctx.apiClient,
    pointInTime: typeof args.options.asOf === "string" && args.options.asOf !== "",
  }),
};

export function createShortInterestHeadless(
  dependencies: ShortInterestHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    // Settled twice a month and published about a week later; a month without one has missed it.
    freshness: { source: "FINRA", status: "not-a-feed", basis: "twice-monthly settlement", observedKey: "settlementDate", oldest: null, maxAgeMinutes: 30 * 24 * 60 },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "US equity ticker.",
    },
    discovery: {
      limitations: [
        "Borrow fee, utilization and locate availability are not available: FINRA short interest counts shares short, not what they cost to borrow.",
        "Percent of float is each settlement's shares short over the float of its day: the 10-K or 10-Q share count known when FINRA published it, at the part of today's count that floats; the latest is over the current float. A settlement no count was known for stays blank.",
      ],
    },
    usListingsOnly: "FINRA short interest",
    options: [
      {
        key: "order",
        shot: REPORT_SORT,
        description: "Settlement date order.",
        type: "enum",
        values: [{ value: "newest" }, { value: "oldest" }],
        defaultValue: "newest",
      },
      {
        key: "asOf",
        type: "string",
        placeholder: "date",
        description: `Only the settlements FINRA had published by this date, as ${DATE_OPTION_EXAMPLES}, each on the share count known then.`,
        normalize: (value) => isoDateOption(value, "as-of"),
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        aliases: ["count", "rows"],
        description: "Maximum settlement rows.",
        type: "integer",
        defaultValue: 24,
        minimum: 1,
        maximum: 100,
      },
    ],
    columns: SHORT_INTEREST_COLUMNS,
    describe: (args) => `Short Interest | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const loaded = await dependencies.loadRecords(symbol, args, ctx);
      const { records, source, cloudSessionRequired } = Array.isArray(loaded)
        ? { records: loaded, source: undefined, cloudSessionRequired: false }
        : loaded;
      const latestSettlements = source === "gloom" && records.length > 0;
      const preference: SortPreference = {
        columnId: "settlementDate",
        direction: args.options.order === "oldest" ? "asc" : "desc",
      };
      const limit = Number(args.options.limit);
      const asOf = typeof args.options.asOf === "string" && args.options.asOf ? args.options.asOf : null;
      // A settlement published after the date was not known on it.
      const published = asOf ? buildRows(records).filter((row) => row.publishedDate !== "-" && row.publishedDate <= asOf) : buildRows(records);
      const rows = sortRows(published, preference)
        .slice(0, limit)
        .map((row) => ({
          settlementDate: row.settlementDate,
          publishedDate: row.publishedDate === "-" ? null : row.publishedDate,
          sharesShort: row.record.sharesShort,
          daysToCover: row.record.shortRatio,
          averageDailyVolume: row.record.averageDailyVolume,
          shortPercentFloat: row.record.shortPercentFloat,
          floatAsOf: row.floatAsOf === "-" ? null : row.floatAsOf,
        }));
      const schedule = shortInterestFreshness(rows.map((row) => row.settlementDate).sort().at(-1));
      // A cut at a past date is as current as that date allowed, not stale by today's clock.
      const freshness = schedule && asOf ? { ...schedule, maxAgeMinutes: Number.POSITIVE_INFINITY } : schedule;
      // A date before the history held: say where it starts rather than show nothing.
      const first = records.map((record) => record.settlementDate.toISOString().slice(0, 10)).sort()[0];
      const errors = [
        ...(asOf && first && rows.length === 0
          ? [`No ${symbol} settlement held was published by ${asOf}: the history starts ${first}, published ${shortInterestPublished(first) ?? "later"}.`]
          : []),
        ...(latestSettlements ? [cloudSessionRequired
          ? "Full history needs a Gloom Cloud sign-in; showing the latest two settlements."
          : "Full history unavailable; showing the latest two settlements."] : []),
      ];
      return {
        rows,
        ...(freshness ? { freshness } : {}),
        ...(latestSettlements ? { complete: false } : {}),
        ...(errors.length ? { errors } : {}),
        metadata: { symbol, order: args.options.order, ...(asOf ? { asOf } : {}), ...(source ? { source } : {}) },
      };
    },
  };
}

export const shortInterestHeadless = createShortInterestHeadless();
