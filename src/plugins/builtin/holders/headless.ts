import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { loadHolderSnapshot } from "./client";
import { holderValueCurrency } from "./format";
import { logFailure } from "../../../utils/log-failure";
import type { HolderData } from "../../../types/financials";
import { SEC_FILING_ROWS, SEC_FILINGS } from "../shared/report-freshness";
import type { BeneficialOwnersPayload } from "../../../api-client/beneficial-owners";
import { fetchBeneficialOwners, type BeneficialOwnersRequest } from "./beneficial-client";
import { resolveHeadlessInstrument, resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import type { BeneficialColumnId } from "./beneficial-model";
import {
  beneficialCoverageNotices,
  beneficialListComplete,
  beneficialListFacts,
  beneficialReportColumns,
  beneficialReportLegend,
  beneficialRouteForm,
  buildBeneficialReportRows,
  HOLDER_FORMS,
  parseHolderForm,
} from "./beneficial-report";
import {
  HOLDER_REPORT_COLUMNS,
  HOLDER_SORT_KEYS,
  holderReportColumns,
  holderReportNotices,
  holderReportDates,
  holderReportRows,
  holderReportUnits,
} from "./report-rows";
import { REPORT_ROWS } from "../shared/headless-options";
import { fundHoldersAnswer } from "./fund-holders";
import {
  HOLDER_ROWS_MAX,
  indexedHoldersPartialNote,
  indexedHolderUnits,
  indexHolderTicker,
  loadIndexedHolders,
  withIndexedHolders,
  type IndexedHolderList,
} from "./index-holders";

/** The same sort keys order the 13D/13G rows; `value` and `held` are the percent of class. */
const BENEFICIAL_SORT_COLUMNS: Record<string, BeneficialColumnId> = {
  holder: "filer",
  value: "percentOfClass",
  shares: "shares",
  change: "change",
  "change-percent": "thirteenF",
  held: "percentOfClass",
  date: "filingDate",
};

interface HolderSnapshot {
  data: HolderData;
  marketCap?: number;
  /** Today's shares outstanding, which a 13D/13G percent of class is set against. */
  sharesOutstanding?: number | null;
  sharesOutstandingAsOf?: string | null;
  /** The latest price, which values the index's holders when the source's rows give none. */
  price?: number;
}

export interface HoldersHeadlessDependencies {
  loadSnapshot(
    symbol: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<HolderSnapshot>;
  loadBeneficialOwners(
    symbol: string,
    request: BeneficialOwnersRequest,
    ctx: HeadlessPaneContext,
  ): Promise<BeneficialOwnersPayload>;
  /** A US listing's largest `limit` 13F holders from the SEC holder index, as `fn 13F` pages them. */
  loadIndexedHolders(
    ticker: string,
    limit: number,
    ctx: HeadlessPaneContext,
  ): Promise<IndexedHolderList>;
}

const defaultDependencies: HoldersHeadlessDependencies = {
  loadSnapshot: (symbol, _args, ctx) => loadHolderSnapshot(ctx.marketData, symbol),
  // A listing abroad names its venue and company, so it never reads a US namesake's owners.
  loadBeneficialOwners: async (symbol, request, ctx) => fetchBeneficialOwners(symbol, {
    ...request,
    listing: await resolveHeadlessIssuerListing(ctx, symbol),
  }, {
    client: ctx.apiClient,
    signal: ctx.signal,
  }),
  loadIndexedHolders: (ticker, limit, ctx) => loadIndexedHolders(ticker, limit, ctx.signal, ctx.apiClient),
};

export function createHoldersHeadless(
  overrides: Partial<HoldersHeadlessDependencies> = {},
): HeadlessPaneDefinition<"rows"> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    shape: "rows",
    freshness: { ...SEC_FILINGS, basis: "13F filings" },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Ticker whose institutional holders should be loaded.",
    },
    options: [
      {
        key: "sort",
        description: "Column used to sort holder rows.",
        type: "enum",
        values: Object.keys(HOLDER_SORT_KEYS).map((value) => ({ value })),
        defaultValue: "value",
      },
      {
        key: "order",
        description: "Sort direction.",
        type: "enum",
        values: [{ value: "desc" }, { value: "asc" }],
        defaultValue: "desc",
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        aliases: ["count", "rows"],
        description: "Maximum holder rows, largest first. A US listing's 13F holders are every filer fn 13F lists; a listing abroad has only the source's largest few.",
        type: "integer",
        defaultValue: 25,
        minimum: 1,
        maximum: HOLDER_ROWS_MAX,
      },
      {
        key: "view",
        description: "Rendered pane view: the holder table, the ownership treemap or the 13D/13G beneficial owners.",
        type: "enum",
        values: [{ value: "table" }, { value: "chart" }, { value: "13dg", aliases: ["beneficial"] }],
        defaultValue: "table",
        pluginState: { pluginId: "ticker-research", key: "viewMode" },
      },
      {
        key: "form",
        shot: { reportOnly: "picks the text report's rows; the pane shows 13D/13G owners with --view 13dg" },
        description: "Rows: 13f for institutional holders, 13d or 13g for beneficial owners over 5% of the class (activists, crowding into large stakes), all for both kinds.",
        type: "enum",
        values: HOLDER_FORMS.map((value) => ({ value })),
        defaultValue: "13f",
      },
      {
        key: "history",
        shot: { reportOnly: "lists every 13D/13G report in the text report" },
        description: "With a 13d, 13g or all form, every report newest first instead of the latest per filer.",
        type: "boolean",
        defaultValue: false,
      },
    ],
    columns: HOLDER_REPORT_COLUMNS,
    describe: (args) => `Holders | ${args.symbols[0]}`,
    // The table's sort, or the 13D/13G list's on that view, as the report orders its rows.
    shotState: (args, _load, given) => {
      if (!given.has("sort") && !given.has("order")) return {};
      const direction = args.options.order === "asc" ? "asc" : "desc";
      return { pluginState: { "ticker-research": args.options.view === "13dg"
        ? { beneficialSort: { columnId: BENEFICIAL_SORT_COLUMNS[String(args.options.sort)] ?? "percentOfClass", direction } }
        : { sortPreference: { columnId: HOLDER_SORT_KEYS[String(args.options.sort)] ?? "value", direction } } } };
    },
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const requestedForm = parseHolderForm(args.options.form) ?? "13f";
      // The 13D/G view reports what it shows when no form is asked for.
      const form = requestedForm === "13f" && args.options.view === "13dg" ? "all" : requestedForm;
      if (form !== "13f") {
        const history = args.options.history === true;
        const [payload, snapshot] = await Promise.all([
          dependencies.loadBeneficialOwners(symbol, { form: beneficialRouteForm(form), history }, ctx),
          // The 13F column is a join; the 13D/13G rows stand without it.
          dependencies.loadSnapshot(symbol, args, ctx).catch(logFailure("holders.headless", "Load holder snapshot for filing comparison failed", null)),
        ]);
        const sharesOutstanding = snapshot?.sharesOutstanding ?? null;
        const rows = buildBeneficialReportRows(payload, {
          history,
          holders: snapshot?.data ?? null,
          sort: {
            columnId: BENEFICIAL_SORT_COLUMNS[String(args.options.sort)] ?? "percentOfClass",
            direction: args.options.order === "asc" ? "asc" : "desc",
          },
          sharesOutstanding,
        });
        const limited = rows.slice(0, Number(args.options.limit));
        const legend = beneficialReportLegend(limited, sharesOutstanding, snapshot?.sharesOutstandingAsOf);
        return {
          columns: beneficialReportColumns(limited),
          rows: limited,
          // Reports that could not be read this time are missing from the rows.
          complete: beneficialListComplete(payload),
          freshness: { ...SEC_FILING_ROWS, basis: "13D/13G filings" },
          metadata: {
            symbol: payload.ticker || symbol,
            name: payload.companyName || null,
            cik: payload.cik || null,
            form,
            history,
            asOf: payload.asOf,
            coverage: payload.coverage,
            sharesOutstanding,
            ...(snapshot?.sharesOutstandingAsOf ? { sharesOutstandingAsOf: snapshot.sharesOutstandingAsOf } : {}),
            notices: [
              [payload.companyName || symbol, ...beneficialListFacts(payload, form, rows.length, history)].join(" · "),
              ...(legend ? [legend] : []),
              ...beneficialCoverageNotices(payload.coverage),
            ],
            returned: limited.length,
            total: rows.length,
          },
        };
      }
      const limit = Number(args.options.limit);
      // Asked beside the source's list; a listing abroad (named in the key or saved with the ticker),
      // or an index that cannot be read, keeps that list.
      const exchange = (await resolveHeadlessInstrument(ctx, symbol)
        .catch(logFailure("holders.headless", "Resolve the listing's venue for the 13F holder index failed", null)))?.exchange ?? "";
      const indexTicker = indexHolderTicker(symbol, exchange);
      const [snapshot, index] = await Promise.all([
        dependencies.loadSnapshot(symbol, args, ctx).catch(async (error: unknown) => {
          const quote = await ctx.marketData.getQuote(symbol)
            .catch(logFailure("holders.headless", "Read the quote of a listing with no holders failed", null));
          const fund = await fundHoldersAnswer(symbol, error, quote, ctx.apiClient);
          if (fund) return fund;
          throw error;
        }),
        indexTicker
          ? dependencies.loadIndexedHolders(indexTicker, limit, ctx).catch(logFailure("holders.headless", "Load 13F holder index failed", null))
          : null,
      ]);
      // A fund has no ownership breakdown: the report says so in place of rows, with what reads it, and fails as no data.
      if ("message" in snapshot) {
        return {
          columns: HOLDER_REPORT_COLUMNS,
          rows: [],
          empty: [snapshot.message, ...snapshot.details].join("\n"),
          unavailableSymbols: [symbol],
          metadata: { symbol },
        };
      }
      const { marketCap } = snapshot;
      const indexed = !!index?.rows.length && indexHolderTicker(symbol, exchange, snapshot.data) != null;
      const partialNote = indexed ? indexedHoldersPartialNote(index, limit) : null;
      // Pages hold 25; another order ranks the largest `limit`, not whatever the last page held past them.
      const data = indexed
        ? withIndexedHolders(snapshot.data, indexTicker!, { ...index!, rows: index!.rows.slice(0, limit) }, indexedHolderUnits(snapshot.data, snapshot.price))
        : snapshot.data;
      const currency = data.currency ?? "USD";
      // A London line's values can be dollars from the 13F filings; they are labelled and formatted as such.
      const valueCurrency = holderValueCurrency(data, currency)!;
      const sort = {
        columnId: HOLDER_SORT_KEYS[String(args.options.sort)] ?? "value",
        direction: args.options.order === "asc" ? "asc" as const : "desc" as const,
      };
      const sorted = holderReportRows(data, { marketCap, sort });
      const rows = sorted.slice(0, limit);
      const total = data.summary?.institutionsCount ?? null;
      const { notices, valueBasis, positionsBasis, changeReported } = holderReportNotices({
        data, requested: symbol, shown: rows, reported: sorted.length, total, sort, indexed,
      });
      return {
        // A change column that is empty on every row says nothing; the notices explain it once.
        columns: holderReportColumns(rows, valueCurrency),
        rows,
        ...(partialNote ? { complete: false, warnings: [partialNote] } : {}),
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          exchange: data.exchange ?? null,
          currency,
          valueCurrency,
          units: holderReportUnits(valueCurrency),
          ...(data.isDepositaryReceipt != null ? { isDepositaryReceipt: data.isDepositaryReceipt } : {}),
          ...(data.shareBasis ? { shareBasis: data.shareBasis } : {}),
          ...(data.adrRatio != null ? { adrRatio: data.adrRatio } : {}),
          asOf: data.asOf ?? null,
          // Each holder's latest period; several when the list mixes quarters.
          reportDates: holderReportDates(rows),
          summary: data.summary ?? null,
          shown: rows.length,
          reported: sorted.length,
          total,
          truncated: rows.length < (total ?? sorted.length),
          valueBasis,
          changeReported,
          positionsBasis,
          notices,
        },
      };
    },
  };
}

export const holdersHeadless = createHoldersHeadless();
