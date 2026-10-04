import type { SupplyEvidenceItem, SupplyOptions, SupplyRow, SupplyTier, SupplyTierFilter } from "../../../api-client/supply-chain";

export const TIER_OPTIONS: { value: SupplyTierFilter; label: string }[] = [
  { value: "sec", label: "SEC" }, { value: "company", label: "Company" }, { value: "call", label: "Call" },
  { value: "reported", label: "Reported" }, { value: "unconfirmed", label: "Unconfirmed" },
];
const DEFAULT_TIERS: SupplyTierFilter[] = ["sec", "company", "call"];
export function supplyOptions(tiers: unknown = DEFAULT_TIERS): Required<SupplyOptions> {
  const values = typeof tiers === "string" ? tiers.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) : tiers;
  if (!Array.isArray(values) || values.some((value) => !TIER_OPTIONS.some((option) => option.value === value))) {
    throw new Error("Evidence tiers must be sec, company, call, reported or unconfirmed.");
  }
  // Clearing the filter returns to primary evidence; leads always need an explicit opt-in.
  const selected = TIER_OPTIONS.filter((option) => (values.length ? values : DEFAULT_TIERS).includes(option.value)).map((option) => option.value);
  return { tiers: selected, includeLeads: selected.includes("unconfirmed") };
}
export const trustTier = (row: SupplyRow): SupplyTier => row.tier ?? (row.sourceKind === "xbrl" || row.sourceKind === "filing_text" ? 1
  : row.sourceKind === "press_release" ? 2 : row.sourceKind === "call" ? 3 : row.sourceKind === "news" ? 4 : 6);
export const isUnconfirmed = (row: SupplyRow) => row.leadStatus === "lead" || row.claimType === "rumored" || trustTier(row) === 6;
export const tierLabel = (tier: SupplyTier) => tier === 1 ? "SEC" : tier === 2 ? "Company" : tier === 3 ? "Call" : tier === 5 ? "Reported (trade)" : tier === 4 ? "Reported" : "Unconfirmed";
export const evidenceLabel = (row: SupplyRow) => isUnconfirmed(row) ? "Unconfirmed" : tierLabel(trustTier(row));
export const activeRelationship = (row: SupplyRow) => row.leadStatus !== "rejected" && row.leadStatus !== "stale";
export function matchesSupplyOptions(row: SupplyRow, options: Required<SupplyOptions>): boolean {
  if (!activeRelationship(row)) return false;
  if (isUnconfirmed(row)) return options.includeLeads && options.tiers.includes("unconfirmed");
  const tier = trustTier(row);
  return options.tiers.includes(tier === 1 ? "sec" : tier === 2 ? "company" : tier === 3 ? "call" : "reported");
}
export const canShowQuote = (item: SupplyEvidenceItem) => item.quoteRights !== "link_only" && item.textOrigin !== "snippet";
export function publicEvidence(item: SupplyEvidenceItem): SupplyEvidenceItem {
  return canShowQuote(item) ? item : { ...item, quote: null, englishGloss: null };
}
export const corroborationLabel = (row: SupplyRow) => (row.corroboration ?? 1) <= 1 ? "Single source" : `${row.corroboration} independent origins`;
export const evidenceDate = (row: SupplyRow) => row.evidence?.find((item) => item.status === "active")?.publishedAt.slice(0, 10) ?? row.filedDate ?? row.asOf;
