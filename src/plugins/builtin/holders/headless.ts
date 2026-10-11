import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { loadHolderSnapshot } from "./client";
import { holderValueCurrency } from "./format";
import type { HolderData } from "../../../types/financials";
import { SEC_FILINGS } from "../shared/report-freshness";
import type { BeneficialOwnersPayload } from "../../../api-client/beneficial-owners";
import { fetchBeneficialOwners, type BeneficialOwnersRequest } from "./beneficial-client";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
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
  holderReportRows,
  holderReportUnits,
} from "./report-rows";

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
        aliases: ["count", "rows"],
        description: "Maximum holder rows.",
        type: "integer",
        defaultValue: 25,
        minimum: 1,
        maximum: 200,
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
        description: "Rows: 13f for institutional holders, 13d or 13g for beneficial owners over 5% of the class (activists, crowding into large stakes), all for both kinds.",
        type: "enum",
        values: HOLDER_FORMS.map((value) => ({ value })),
        defaultValue: "13f",
      },
      {
        key: "history",
        description: "With a 13d, 13g or all form, every report newest first instead of the latest per filer.",
        type: "boolean",
        defaultValue: false,
      },
    ],
    columns: HOLDER_REPORT_COLUMNS,
    describe: (args) => `Holders | ${args.symbols[0]}`,
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
          dependencies.loadSnapshot(symbol, args, ctx).catch(() => null),
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
        const legend = beneficialReportLegend(limited, sharesOutstanding);
        return {
          columns: beneficialReportColumns(limited),
          rows: limited,
          // Reports that could not be read this time are missing from the rows.
          complete: beneficialListComplete(payload),
          freshness: { ...SEC_FILINGS, basis: "13D/13G filings", observedKey: "filingDate" },
          metadata: {
            symbol: payload.ticker || symbol,
            name: payload.companyName || null,
            cik: payload.cik || null,
            form,
            history,
            asOf: payload.asOf,
            coverage: payload.coverage,
            sharesOutstanding,
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
      const { data, marketCap } = await dependencies.loadSnapshot(symbol, args, ctx);
      const currency = data.currency ?? "USD";
      // A London line's values can be dollars from the 13F filings; they are labelled and formatted as such.
      const valueCurrency = holderValueCurrency(data, currency)!;
      const sorted = holderReportRows(data, {
        marketCap,
        sort: {
          columnId: HOLDER_SORT_KEYS[String(args.options.sort)] ?? "value",
          direction: args.options.order === "asc" ? "asc" : "desc",
        },
      });
      const rows = sorted.slice(0, Number(args.options.limit));
      const total = data.summary?.institutionsCount ?? null;
      const { notices, valueBasis, positionsBasis, changeReported } = holderReportNotices({
        data, requested: symbol, shown: rows, reported: sorted.length, total,
      });
      return {
        // A change column that is empty on every row says nothing; the notices explain it once.
        columns: holderReportColumns(rows, valueCurrency),
        rows,
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
