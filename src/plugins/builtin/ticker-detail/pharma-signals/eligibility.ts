import type { CompanyProfile } from "../../../../types/financials";
import type { TickerInstrumentKind } from "../../../../types/instrument";

/** The Signals tab's id: what `?tab=`, `--tab` and a saved layout name it by. */
export const PHARMA_SIGNALS_TAB_ID = "pharma-signals";

/** The profile's industries of drug developers: Biotechnology, Drug Manufacturers - General, - Specialty & Generic. */
const DRUG_INDUSTRY = /^(?:biotechnology|drug manufacturers\b.*)$/i;

/**
 * SEC codes of drug makers, for a US filer whose profile names no industry:
 * medicinal chemicals (2833), pharmaceutical preparations (2834) and
 * biological products (2836). Diagnostic substances (2835) are not drugs.
 */
const DRUG_SIC = new Set(["2833", "2834", "2836"]);

/**
 * Whether a listing gets the Signals tab: a company share whose profile says
 * it develops or makes drugs. Other healthcare (devices, services, insurers,
 * tools), funds such as a biotech ETF, and a listing whose profile has not
 * loaded do not: the tab shows once the profile says so, never on a guess
 * from the name.
 */
export function isPharmaSignalsListing(
  instrumentKind: TickerInstrumentKind,
  profile: Pick<CompanyProfile, "industry" | "sic"> | null | undefined,
): boolean {
  if (instrumentKind !== "equity" || !profile) return false;
  const industry = profile.industry?.trim();
  if (industry) return DRUG_INDUSTRY.test(industry);
  return DRUG_SIC.has(profile.sic?.trim() ?? "");
}
