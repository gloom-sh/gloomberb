import type {
  HeadlessBundleResult,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessPaneRow,
} from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { US_FUND_FACTS_ONLY } from "../../../utils/sec";
import type { SecFilingItem } from "../../../types/data-provider";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import { errorMessage } from "../../../utils/errors";
import { loadSecFilings } from "./client";
import { ETF_FILING_FORMS, filingFormMatches, filterFilingsByForms, fundSeriesFilings, SEC_FILING_FETCH_LIMIT } from "./forms";
import { hiddenFilingsNote, loadLatestFilings } from "../../../utils/sec-filings";
import { buildSecFilingRows, secFilingIssuers, SEC_ACCEPTANCE_NOTE } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { fetchFundFacts, fundFactEntries, fundFactPublishers, fundFactsEmpty, fundFactsErrorText, fundFactsStaleNote, listNames } from "./fund-facts";
import { REPORT_ROWS } from "../shared/headless-options";
import { fundAbroadProfile, venueAbroad, type FundAbroadProfile } from "./fund-abroad";
import { listingAnnouncementsPage } from "../../../utils/exchange-announcements";

const SEC_COLUMNS: HeadlessPaneColumn[] = [
  {
    key: "filedAt",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  { key: "acceptanceReported", header: "SEC-reported acceptance" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Issuer" },
  { key: "filing", header: "Filing" },
  { key: "items", header: "Items" },
  { key: "accessionNumber", header: "Accession" },
];

/** Some row has 8-K item codes; a column every row leaves `-` takes no room in the text table (exports keep it). */
const hasItems = (rows: readonly HeadlessPaneRow[]) => rows.some((row) => typeof row.items === "string" && row.items !== "");

function secTextColumns(rows: readonly HeadlessPaneRow[]): HeadlessPaneColumn[] {
  return hasItems(rows) ? SEC_COLUMNS : SEC_COLUMNS.filter((column) => column.key !== "items");
}

/**
 * A fund's filings as the text report prints them. Filed, Form and what the
 * filing is stay in a narrow table: below 100 columns the acceptance time is
 * left out. Every row is the fund's registrant's (its trust), so no Issuer
 * column repeats it, as the pane's list names a filer only when there are
 * several; exports keep it.
 */
function fundFilingTextColumns(rows: readonly HeadlessPaneRow[]): HeadlessPaneColumn[] {
  const issuers = new Set(rows.map((row) => row.cik));
  return secTextColumns(rows)
    .filter((column) => column.key !== "companyName" || issuers.size > 1)
    .map((column) => column.key === "acceptanceReported" ? { ...column, minTableWidth: 100 } : column);
}

export interface SecHeadlessDependencies {
  loadFilings(
    symbol: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<SecFilingItem[]>;
}

const defaultDependencies: SecHeadlessDependencies = {
  loadFilings: (symbol, limit, _args, ctx) => loadSecFilings(ctx.marketData, symbol, limit),
};

/**
 * The fund filings list's empty text: a fund that files none of the fund
 * forms, such as a grantor trust (IBIT, GLD) filing 10-Ks and 10-Qs, says so
 * and where its filings are.
 */
export function fundFilingsEmpty(symbol: string, searched: { count: number; complete: boolean }): string {
  if (searched.count === 0) return `No SEC filings found for ${symbol}.`;
  const forms = "prospectus, shareholder reports, N-CEN, N-PORT";
  const none = searched.complete
    ? `${symbol} files none of the fund forms ETF lists (${forms}).`
    : `None of ${symbol}'s latest ${searched.count} SEC filings is a fund form ETF lists (${forms}).`;
  return `${none} Its other filings: fn SEC ${symbol}.`;
}

export function createSecHeadless(dependencies: SecHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { ...SEC_FILINGS, observedKey: "acceptedAt" },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "US equity ticker.",
    },
    options: [
      {
        key: "limit",
        shot: REPORT_ROWS,
        aliases: ["count", "rows"],
        description: "Maximum recent filings.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
      {
        key: "form",
        shot: { reportOnly: "picks the report's rows by form; the pane's Form filter picks a group of forms" },
        description: "Only this form and its amendments, such as 8-K, 10-K or 13D, from every filing listed for the issuer.",
        type: "string",
        placeholder: "form",
        example: "--form 8-K",
      },
      {
        key: "all",
        description: "Also list the pricing supplements and term sheets (424B2, FWP, and a 424B3 filed among them) a bank files for each structured note, which are left out by default.",
        type: "boolean",
        defaultValue: false,
        pluginState: { pluginId: "ticker-research", key: "pricingSupplements" },
      },
    ],
    columns: SEC_COLUMNS,
    describe: (args) => `SEC Filings | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const limit = Number(args.options.limit);
      const form = typeof args.options.form === "string" ? args.options.form.trim() : "";
      const load = (count: number) => dependencies.loadFilings(symbol, count, args, ctx);
      // A form filter searches every filing listed for the issuer, as `filings --form` does, and keeps
      // the supplements it names; without one, a bank's pricing supplements stay out unless --all.
      const { filings, hidden } = form
        ? { filings: (await load(SEC_FILING_FETCH_LIMIT)).filter((filing) => filingFormMatches(filing.form, form)).slice(0, limit), hidden: null }
        : args.options.all === true
          ? { filings: (await load(limit)).slice(0, limit), hidden: null }
          : await loadLatestFilings(load, limit);
      const note = hidden && hiddenFilingsNote(hidden);
      const rows = buildSecFilingRows(filings);
      // A listing abroad whose company files nothing with the SEC says where its exchange publishes its announcements.
      const page = !form && filings.length === 0 ? listingAnnouncementsPage(symbol) : null;
      return {
        rows,
        textColumns: secTextColumns(rows),
        ...(note ? { notes: [note] } : {}),
        ...(form ? { empty: `No ${form} filings found for ${symbol}.` }
          : page ? { empty: `${symbol} files no SEC reports. ${page.name}: ${page.url}` } : {}),
        metadata: {
          acceptanceNote: SEC_ACCEPTANCE_NOTE,
          symbol,
          returned: filings.length,
          issuers: secFilingIssuers(filings),
          ...(form ? { form } : {}),
          pricingSupplementsHidden: hidden?.pricingSupplements ?? 0,
        },
      };
    },
  };
}

export const secHeadless = createSecHeadless();

export interface FundHeadlessDependencies extends SecHeadlessDependencies {
  loadFacts(symbol: string, ctx: HeadlessPaneContext): Promise<FundFactsPayload>;
  loadAbroadProfile?(key: string, ctx: HeadlessPaneContext): Promise<FundAbroadProfile | null>;
}

const defaultFundDependencies = {
  ...defaultDependencies,
  loadFacts: (symbol: string, ctx: HeadlessPaneContext) => fetchFundFacts(symbol, ctx.apiClient),
  async loadAbroadProfile(key: string, ctx: HeadlessPaneContext): Promise<FundAbroadProfile | null> {
    const { symbol, exchange } = parsePublicTickerKey(key);
    return fundAbroadProfile(await ctx.marketData.getTickerFinancials(symbol, exchange));
  },
};

/**
 * ETF for a fund listed abroad (3042:HKEX): what `ticker` says, that the
 * facts cover US-listed funds only, and the fund's page at its issuer where
 * the profile has one. No SEC request: the SEC knows no listing abroad, and
 * its "Unknown ticker" said nothing of the fund.
 */
function fundAbroadResult(symbol: string, venue: string, profile: FundAbroadProfile | null): HeadlessBundleResult {
  const entries = [
    ...profile?.name ? [{ label: "Name", value: profile.name }] : [],
    ...profile?.page ? [{ label: "Issuer page", value: profile.page }] : [],
    ...profile?.descriptionSource
      ? [{ label: "Description from", value: `${profile.descriptionSource.publisher}: ${profile.descriptionSource.url}` }]
      : [],
  ];
  return {
    sections: [
      { title: "Fund facts", rows: [], empty: US_FUND_FACTS_ONLY },
      ...entries.length ? [{ title: "Fund", entries }] : [],
    ],
    complete: true,
    freshness: { source: profile?.page ? "Fund issuer" : "Gloom", status: "not-a-feed", basis: "published fund data" },
    metadata: { symbol, venue, usListedOnly: true, issuerPage: profile?.page ?? null },
  };
}

/**
 * ETF: a US-listed fund's facts (fee, NAV, premium or discount, net assets,
 * sponsor, inception, index) as its sponsor publishes them, then its fund
 * filings. Either part can fail or be empty without taking the other with it:
 * signed out, the facts still load and the filings say why they do not.
 */
export function createFundHeadless(dependencies: FundHeadlessDependencies = defaultFundDependencies): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { source: "Fund sponsors and SEC EDGAR", status: "not-a-feed", basis: "published fund data" },
    argument: { kind: "ticker", placeholder: "ticker", description: "US-listed fund ticker. A fund listed abroad gets its issuer's page." },
    options: [{
      key: "limit",
      shot: REPORT_ROWS,
      aliases: ["count", "rows"],
      description: "Maximum recent fund filings.",
      type: "integer",
      defaultValue: 50,
      minimum: 1,
      maximum: 200,
    }],
    discovery: { limitations: ["Fund facts cover the sponsors Gloom collects; other funds point to their SEC filings."] },
    describe: (args) => `ETF | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const abroad = venueAbroad(symbol);
      if (abroad) {
        try {
          const profile = await (dependencies.loadAbroadProfile ?? defaultFundDependencies.loadAbroadProfile)(symbol, ctx);
          return fundAbroadResult(symbol, abroad, profile);
        } catch (error) {
          return {
            ...fundAbroadResult(symbol, abroad, null),
            complete: false,
            errors: [`Fund profile unavailable: ${errorMessage(error)}`],
          };
        }
      }
      const limit = Number(args.options.limit);
      const [factsResult, filingsResult] = await Promise.allSettled([
        dependencies.loadFacts(symbol, ctx),
        dependencies.loadFilings(symbol, SEC_FILING_FETCH_LIMIT, args, ctx),
      ]);
      if (factsResult.status === "rejected" && filingsResult.status === "rejected") throw filingsResult.reason;
      const facts = factsResult.status === "fulfilled" ? factsResult.value : null;
      const issuerFilings = filingsResult.status === "fulfilled" ? filingsResult.value : [];
      // A trust's list holds every fund it runs; the fund's own series is the view.
      const filings = filterFilingsByForms(fundSeriesFilings(issuerFilings), ETF_FILING_FORMS).slice(0, limit);
      const searchedAll = issuerFilings.length < SEC_FILING_FETCH_LIMIT;
      const filingsEmpty = filingsResult.status === "rejected"
        ? `Fund filings unavailable: ${errorMessage(filingsResult.reason)}`
        : fundFilingsEmpty(symbol, { count: issuerFilings.length, complete: searchedAll });
      // The filings line already sends a fund without fund forms to SEC; the facts line does not say it twice.
      const filingsPointToSec = filingsResult.status === "fulfilled" && filings.length === 0 && issuerFilings.length > 0;
      const factsSection = facts?.covered
        ? { title: "Fund facts", entries: fundFactEntries(facts) }
        : { title: "Fund facts", rows: [], empty: factsResult.status === "rejected"
          ? fundFactsErrorText(factsResult.reason)
          : fundFactsEmpty(symbol, facts, !filingsPointToSec) };
      const publishers = facts?.covered ? fundFactPublishers(facts) : [];
      const filingRows = buildSecFilingRows(filings);
      return {
        sections: [
          factsSection,
          { title: "Fund filings", columns: SEC_COLUMNS, textColumns: fundFilingTextColumns(filingRows), rows: filingRows, ...(filings.length === 0 ? { empty: filingsEmpty } : {}) },
        ],
        complete: !!facts?.covered && filingsResult.status === "fulfilled" && searchedAll,
        errors: [
          ...(factsResult.status === "rejected" ? [fundFactsErrorText(factsResult.reason)] : []),
          ...(filingsResult.status === "rejected" ? [`Fund filings: ${errorMessage(filingsResult.reason)}`] : []),
        ],
        // A stale NAV says since when; a covered fund without one says why, as the server words it.
        notes: facts ? [fundFactsStaleNote(symbol, facts), facts.covered && !facts.nav ? facts.navReason : null].filter((note): note is string => !!note) : [],
        // The facts' publisher is the source, named the same way for every fund; without facts it is the SEC.
        freshness: {
          source: listNames(publishers) || "SEC EDGAR",
          ...(publishers.length ? { publisher: listNames(publishers) } : {}),
          status: "not-a-feed",
          basis: publishers.length ? "published fund data" : "filed data",
          ...(facts?.nav?.asOf ? { asOf: facts.nav.asOf } : {}),
        },
        metadata: {
          symbol,
          fundFacts: facts,
          acceptanceNote: SEC_ACCEPTANCE_NOTE,
          returned: filings.length,
          forms: [...ETF_FILING_FORMS],
          searchedFilings: issuerFilings.length,
          issuers: secFilingIssuers(filings),
        },
      };
    },
  };
}

export const fundHeadless = createFundHeadless();
