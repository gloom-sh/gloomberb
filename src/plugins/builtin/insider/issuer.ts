import type { SecFilingItem } from "../../../types/data-provider";
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
 * its own. Each already names the company above it.
 */
export function insiderEmptyNotice(foreignPrivateIssuer: boolean): string {
  return foreignPrivateIssuer
    ? "No Form 4 insiders: foreign private issuers file none."
    : "No Form 4 insider filings.";
}
