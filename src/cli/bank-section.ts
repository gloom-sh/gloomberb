import type { BankFiguresPayload } from "../api-client/bank-figures";
import type { TickerFinancials } from "../types/financials";
import type { CliReportEntry } from "./report-tables";
import { isForeignIssuerForm, type StatementReportSources } from "./statement-filings";
import { formatCompact, formatPercent } from "../utils/format";
import { logFailure } from "../utils/log-failure";
import { nonUsSecListingVenue } from "../utils/sec";

/**
 * The Bank section of `fundamentals` for a bank holding company: its deposits
 * and their change on the quarter from its own filings, and its lead bank's
 * uninsured share and CRE concentration from the FDIC call report. Every line
 * names the quarter and the filing or report date it is from. Methodology is
 * in docs/usage.md (Statement filings and bank figures).
 */
export interface BankSection {
  /** Label and text, as the report prints them. */
  lines: Array<[string, string]>;
  /** The same figures for --csv and --ndjson. */
  entries: CliReportEntry[];
  /** Muted lines under the section: what is missing and why, and where NIM is. */
  notes: string[];
}

const money = (value: number) => `${formatCompact(value)} USD`;
const share = (value: number) => `${(value * 100).toFixed(1)}%`;
const day = (stamp: string | null) => stamp?.slice(0, 10) ?? null;

/** The screener on one company with its net interest margin, a Pro figure. */
export function nimCommand(symbol: string): string {
  const definition = JSON.stringify({
    version: 1, currency: null, criteria: [{ field: "symbol", op: "in", value: [symbol] }], sort: { field: "symbol", direction: "asc" },
  });
  return `gloom fn EQS --metric kpiNimPercent --definition '${definition}'`;
}

/** Gloom Cloud's note for a company with no US GAAP deposits tag, which reads as if it filed 10-Qs; a foreign issuer files neither. */
const NO_DEPOSITS_TAG_NOTE = "The company's 10-Q and 10-K tag no total deposits.";

export function bankSection(bank: BankFiguresPayload, symbol: string, { latestStatementDate, annualReportForm }: {
  /** The newest statement period, YYYY-MM-DD. */
  latestStatementDate: string | null;
  /** The company's annual report form: a 20-F or 40-F names a foreign group, whose FDIC-insured bank is only its US arm. */
  annualReportForm: string | null;
}): BankSection | null {
  if (!bank.bank) return null;
  const foreignGroup = isForeignIssuerForm(annualReportForm);
  const lines: Array<[string, string]> = [];
  const entries: CliReportEntry[] = [];
  const notes = foreignGroup ? bank.notes.filter((note) => note !== NO_DEPOSITS_TAG_NOTE) : [...bank.notes];
  const { deposits, leadBank, callReport } = bank;

  if (leadBank) {
    const largest = leadBank.otherBanks > 0
      ? `largest of ${leadBank.otherBanks + 1} insured banks by assets${leadBank.reportDate ? ` at ${leadBank.reportDate}` : ""}`
      : null;
    const role = foreignGroup
      ? ["US bank subsidiary only", largest].filter(Boolean).join(", ")
      : !leadBank.holdingCompany ? "the company is the bank" : largest ?? "its insured bank";
    const asOf = day(leadBank.source.datasetAsOf);
    lines.push(["Lead Bank", `${leadBank.name} (FDIC cert ${leadBank.cert}; ${role}${asOf ? `; FDIC data of ${asOf}` : ""})`]);
    entries.push({ label: "Lead Bank", value: leadBank.name }, { label: "Lead Bank FDIC Cert", value: leadBank.cert });
    if (foreignGroup) {
      entries.push({ label: "Lead Bank Scope", value: "US bank subsidiary of a foreign group" });
      notes.push(`${symbol} reports as a foreign issuer (${annualReportForm}): the FDIC figures are those of its US bank subsidiary, ${leadBank.name}, `
        + `not the group's. Group deposits are in its ${annualReportForm} and not read here.`);
    }
  }

  if (deposits) {
    const { latest, previous } = deposits;
    const parts = latest.basis === "sum" ? "; interest-bearing plus noninterest-bearing" : "";
    lines.push(["Deposits", `${money(latest.value)} at ${latest.date} (${latest.form} filed ${latest.filed}${parts})`]);
    entries.push(
      { label: "Deposits", value: latest.value, unit: "USD" },
      { label: "Deposits Date", value: latest.date },
      { label: "Deposits Filing", value: `${latest.form} filed ${latest.filed}` },
    );
    if (previous && previous.value > 0) {
      const depositsChange = latest.value / previous.value - 1;
      lines.push(["Deposits QoQ", `${formatPercent(depositsChange)} from ${money(previous.value)} at ${previous.date} (${previous.form} filed ${previous.filed})`]);
      entries.push({ label: "Deposits QoQ", value: depositsChange * 100, unit: "%" });
    }
    if (latestStatementDate && latest.date < latestStatementDate) {
      notes.push(`Deposits are as of ${latest.date}: the company's later filings do not tag total deposits.`);
    }
  }

  if (callReport) {
    const asOf = day(callReport.source.datasetAsOf);
    const report = `call report ${callReport.reportDate}${asOf ? `, FDIC data of ${asOf}` : ""}`;
    // The FDIC's estimate covers deposits in domestic offices: its uninsured part over insured plus uninsured.
    const { uninsuredShare, uninsuredDeposits, insuredDeposits } = callReport;
    const estimated = uninsuredDeposits != null && insuredDeposits != null ? uninsuredDeposits + insuredDeposits : null;
    lines.push(["Uninsured Deposits", uninsuredShare != null && uninsuredDeposits != null && estimated != null
      ? `${share(uninsuredShare)} of domestic deposits (${formatCompact(uninsuredDeposits)} uninsured of ${money(estimated)} estimated insured plus uninsured; ${report})`
      : `not reported: banks under $1B in assets do not file the estimate (${report})`]);
    if (uninsuredShare != null) entries.push({ label: "Uninsured Share of Domestic Deposits", value: uninsuredShare * 100, unit: "%" });
    if (uninsuredDeposits != null) entries.push({ label: "Uninsured Deposits", value: uninsuredDeposits, unit: "USD" });
    // Deposits in foreign offices are outside the estimate, and FDIC insurance does not cover them.
    const foreignOffices = callReport.totalDeposits != null && callReport.domesticDeposits != null
      ? callReport.totalDeposits - callReport.domesticDeposits
      : 0;
    if (uninsuredShare != null && callReport.totalDeposits && foreignOffices / callReport.totalDeposits >= 0.005) {
      entries.push({ label: "Foreign Office Deposits", value: foreignOffices, unit: "USD" });
      notes.push(`The uninsured share covers domestic offices; another ${money(foreignOffices)} of deposits sits in foreign offices, which FDIC insurance does not cover.`);
    }
    if (callReport.cre && callReport.capital && callReport.creToCapital != null) {
      lines.push(["CRE / Capital", `${share(callReport.creToCapital)}: CRE ${money(callReport.cre.total)} over ${callReport.capital.basis} ${money(callReport.capital.value)} (${report})`]);
      entries.push(
        { label: "CRE / Capital", value: callReport.creToCapital * 100, unit: "%" },
        { label: "CRE Loans", value: callReport.cre.total, unit: "USD" },
      );
    }
    entries.push({ label: "Call Report Date", value: callReport.reportDate });
    if (asOf) entries.push({ label: "FDIC Data As Of", value: asOf });
  }

  notes.push(`NIM is a Pro figure in EQS: ${nimCommand(symbol)}`);
  return { lines, entries, notes };
}

/** The line for a bank whose figures could not be read. */
const BANK_FIGURES_UNAVAILABLE = "Bank figures (deposits, uninsured share, CRE) are unavailable right now.";

/**
 * A US-listed financial company's bank figures, or null: a company outside
 * financial services is never asked about (Gloom Cloud answers a non-bank with
 * `bank: false` anyway). A bank whose figures could not be read gets a one-line
 * `note` in their place.
 */
export async function loadBankFigures(
  sources: StatementReportSources | undefined,
  listing: { symbol: string; exchange?: string },
  financials: Pick<TickerFinancials, "profile">,
): Promise<{ bank: BankFiguresPayload | null; note: string | null }> {
  const profile = `${financials.profile?.sector ?? ""} ${financials.profile?.industry ?? ""}`;
  if (!sources || !/financ|bank/i.test(profile) || nonUsSecListingVenue(listing.symbol, listing.exchange)) return { bank: null, note: null };
  try {
    const bank = await sources.bankFigures(listing.symbol);
    return { bank: bank.bank ? bank : null, note: null };
  } catch (error) {
    logFailure("cli.bank-section", "Reading bank figures failed")(error);
    // Only a bank's report misses them; another financial company's says nothing.
    return { bank: null, note: /bank/i.test(financials.profile?.industry ?? "") ? BANK_FIGURES_UNAVAILABLE : null };
  }
}
