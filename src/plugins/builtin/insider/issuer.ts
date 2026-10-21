import type { DataProvider, SecFilingItem } from "../../../types/data-provider";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { logFailure } from "../../../utils/log-failure";
import { homeInsiderReportsNote, venueHomeCountry } from "../../../utils/sec";
import { parseForm4IssuerCik } from "./insider-data";

/**
 * A company's SEC filing list holds every Form 4 it is named on: its insiders'
 * trades in its shares, and the ones it filed itself as an owner of another
 * company's shares (Banco Santander buying Santander Consumer, Sanofi
 * converting Regeneron notes). Only the form's issuer tells them apart, so a
 * filing is the company's own until its document names another issuer.
 */
export function isOtherIssuerFiling(filing: SecFilingItem, content: string | null | undefined): boolean {
  if (!content) return false;
  const issuer = parseForm4IssuerCik(content);
  const company = filing.cik.trim().replace(/^0+/, "");
  return issuer != null && /^\d+$/.test(company) && issuer !== company;
}

const FOREIGN_PRIVATE_ISSUER_FORM = /^(?:20-F|40-F|6-K)(?:\/A)?$/i;
const DOMESTIC_REPORT_FORM = /^(?:10-KT?|10-QT?|8-K)(?:\/A)?$/i;

function newestFiled(filings: readonly SecFilingItem[], form: RegExp): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const filing of filings) {
    if (!form.test(filing.form.trim())) continue;
    const time = new Date(filing.filingDate).getTime();
    if (Number.isFinite(time) && time > newest) newest = time;
  }
  return newest;
}

/**
 * The company reports as a foreign private issuer: its newest report is a
 * 20-F, 40-F or 6-K rather than a 10-K, 10-Q or 8-K. Such an issuer's insiders
 * file no Form 4, so its list holds only the forms it filed as an owner.
 */
export function filesAsForeignPrivateIssuer(filings: readonly SecFilingItem[]): boolean {
  const foreign = newestFiled(filings, FOREIGN_PRIVATE_ISSUER_FORM);
  return Number.isFinite(foreign) && foreign > newestFiled(filings, DOMESTIC_REPORT_FORM);
}

/**
 * What the pane, `fn INS` and `insider` say when a company has no Form 4 of
 * its own, and beside it, for a company from abroad, that its insiders'
 * reports at home are not covered either (`homeInsiderReportsNote`). Each
 * already names the company above it.
 */
export function insiderEmptyNotice(foreignPrivateIssuer: boolean, home: string | null = null): string {
  const notice = foreignPrivateIssuer
    ? "No Form 4 insiders: foreign private issuers file none."
    : "No Form 4 insider filings.";
  return home ? `${notice} ${home}` : notice;
}

/**
 * `homeInsiderReportsNote` for a listing with no Form 4 of its own, placed by
 * its company's country where the source knows the company (RY in New York
 * is Royal Bank of Canada), else by its venue abroad (RY:TSX). A lookup that
 * fails leaves the venue to say. A US listing of a company filing as a
 * domestic one has no home market to name, and costs no lookup.
 */
export async function loadHomeInsiderReportsNote(
  provider: Pick<DataProvider, "getIssuerListings">,
  key: string,
  exchange: string | undefined,
  foreignPrivateIssuer: boolean,
): Promise<string | null> {
  const parsed = parsePublicTickerKey(key);
  const venue = parsed.exchange ?? exchange ?? "";
  if (!foreignPrivateIssuer && !venueHomeCountry(venue)) return null;
  const { getIssuerListings } = provider;
  const issuer = getIssuerListings
    ? await Promise.resolve().then(() => getIssuerListings.call(provider, parsed.symbol, venue))
      .catch(logFailure("plugins.insider.issuer", "Reading the company's listings failed", null))
    : null;
  return homeInsiderReportsNote({ country: issuer?.country, exchange: venue, foreignPrivateIssuer });
}
