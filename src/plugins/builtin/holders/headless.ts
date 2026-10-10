import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { loadHolderSnapshot } from "./client";
import {
  displayDate,
  formatHolderOwnershipPercent,
  formatMaybePercent,
  formatMoneyCompact,
  formatSignedCompact,
  holderValueCurrency,
  resolveHolderOwnershipPercent,
} from "./format";
import { buildRows, sortRows } from "./table-model";
import type { HolderData } from "../../../types/financials";
import type { HolderColumnId } from "./types";
import { SEC_FILINGS } from "../shared/report-freshness";
import {
  holderShareBasisMarker,
  holderShareBasisNote,
  holderValueBasis,
  holdersHeaderLine,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "./report-header";

/** Columns a source fills only when it reports the quarter's change. */
const CHANGE_COLUMN_KEYS = new Set(["changeShares", "changePercent"]);
/** Shown only when some row is held as depositary receipts, as on a home line abroad. */
const BASIS_COLUMN_KEY = "shareBasis";
import type { BeneficialOwnersPayload } from "../../../api-client/beneficial-owners";
import { fetchBeneficialOwners, type BeneficialOwnersRequest } from "./beneficial-client";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import type { BeneficialColumnId } from "./beneficial-model";
import {
  BENEFICIAL_REPORT_COLUMNS,
  beneficialCoverageNotices,
  beneficialListComplete,
  beneficialListFacts,
  beneficialRouteForm,
  buildBeneficialReportRows,
  HOLDER_FORMS,
  parseHolderForm,
} from "./beneficial-report";

const HOLDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Holder" },
  { key: "ownerType", header: "Type" },
  {
    key: "value",
    header: "Mkt value",
    align: "right",
    format: (value, row) => formatMoneyCompact(
      value == null ? undefined : Number(value),
      String(row.currency ?? "USD"),
    ),
  },
  {
    key: "shares",
    header: "Amount",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: BASIS_COLUMN_KEY,
    header: "Basis",
    format: (_value, row) => holderShareBasisMarker(row),
  },
  {
    key: "changeShares",
    header: "Chg",
    align: "right",
    format: (value) => formatSignedCompact(value == null ? undefined : Number(value)),
  },
  {
    key: "changePercent",
    header: "Chg%",
    align: "right",
    format: (value) => formatMaybePercent(value == null ? undefined : Number(value)),
  },
  {
    key: "percentHeld",
    header: "Held",
    align: "right",
    format: (value) => formatHolderOwnershipPercent(value == null ? undefined : Number(value)),
  },
  {
    key: "reportDate",
    header: "Period",
    format: (value) => displayDate(typeof value === "string" ? value : undefined),
  },
];

const SORT_COLUMNS: Record<string, HolderColumnId> = {
  holder: "holder",
  value: "value",
  shares: "shares",
  change: "changeShares",
  "change-percent": "changePercent",
  held: "percentHeld",
  date: "reportDate",
};

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
        values: Object.keys(SORT_COLUMNS).map((value) => ({ value })),
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
    columns: HOLDER_COLUMNS,
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
        const rows = buildBeneficialReportRows(payload, {
          history,
          holders: snapshot?.data ?? null,
          sort: {
            columnId: BENEFICIAL_SORT_COLUMNS[String(args.options.sort)] ?? "percentOfClass",
            direction: args.options.order === "asc" ? "asc" : "desc",
          },
        });
        const limited = rows.slice(0, Number(args.options.limit));
        return {
          columns: BENEFICIAL_REPORT_COLUMNS,
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
            notices: [
              [payload.companyName || symbol, ...beneficialListFacts(payload, form, rows.length, history)].join(" · "),
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
      const sorted = sortRows(buildRows(data), {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "value",
        direction: args.options.order === "asc" ? "asc" : "desc",
      }, marketCap);
      const rows = sorted
        .slice(0, Number(args.options.limit))
        .map((row) => ({
          name: row.name,
          ownerType: row.ownerType,
          value: row.value ?? null,
          shares: row.shares ?? null,
          changeShares: row.changeShares ?? null,
          changePercent: row.changePercent ?? null,
          percentHeld: resolveHolderOwnershipPercent(row, marketCap) ?? null,
          reportDate: row.reportDate ?? null,
          currency: valueCurrency,
          shareBasis: row.shareBasis ?? null,
        }));
      const total = data.summary?.institutionsCount ?? null;
      const changeReported = rows.some((row) => row.changeShares != null || row.changePercent != null);
      const reportDate = sharedReportDate(rows);
      const valueBasis = holderValueBasis(reportDate, data.valueBasis, valueCurrency);
      const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(data.exchange, currency) : null;
      const shareBasisNote = holderShareBasisNote(data, rows);
      const markedRows = rows.some((row) => holderShareBasisMarker(row));
      // The title names the ticker and the closing line carries the as-of date.
      const header = holdersHeaderLine({
        name: data.name,
        symbol: data.symbol && data.symbol !== symbol ? data.symbol : null,
        exchange: data.exchange,
        currency: valueCurrency,
        listingCurrency: data.currency,
        shown: rows.length,
        reported: sorted.length,
        total,
      });
      const basis = rows.length === 0 ? null : [
        `Mkt value = ${valueBasis}.`,
        changeReported ? "" : `Change vs prior quarter: not reported by this source; see fn 13F ${symbol}`,
      ].filter(Boolean).join(" ");
      return {
        // A change column that is empty on every row says nothing; the line above explains it once.
        columns: HOLDER_COLUMNS
          .filter((column) => changeReported || !CHANGE_COLUMN_KEYS.has(column.key))
          .filter((column) => markedRows || column.key !== BASIS_COLUMN_KEY)
          .map((column) => column.key === "value" ? { ...column, header: moneyColumnHeader(column.header, valueCurrency) } : column),
        rows,
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          exchange: data.exchange ?? null,
          currency,
          valueCurrency,
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
          notices: [header, basis, positionsBasis, shareBasisNote].filter((line): line is string => !!line),
        },
      };
    },
  };
}

export const holdersHeadless = createHoldersHeadless();
