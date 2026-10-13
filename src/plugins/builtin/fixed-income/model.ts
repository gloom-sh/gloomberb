export const FIXED_INCOME_PANE_ID = "fixed-income";
export const FIXED_INCOME_HOSTS = [
  "services-dynarep.ddwa.finra.org",
  "api.fiscaldata.treasury.gov",
  "markets.newyorkfed.org",
] as const;

export type FixedIncomeSection = "credit" | "issuer-debt" | "bonds" | "treasury";

export const FIXED_INCOME_SECTIONS: { value: FixedIncomeSection; label: string }[] = [
  { value: "credit", label: "Credit" },
  { value: "issuer-debt", label: "Issuer Debt" },
  { value: "bonds", label: "Bonds" },
  { value: "treasury", label: "Treasury" },
];

/** Pane-state namespaces that keep embedded views independent within one pane instance. */
export const FIXED_INCOME_VIEW_STATE = {
  cds: "fixed-income:cds",
  creditBoards: "fixed-income:credit-boards",
  creditConditions: "fixed-income:credit-conditions",
  bondCalculator: "fixed-income:bond-calculator",
  treasuryAuctions: "fixed-income:treasury-auctions",
  traceBonds: "fixed-income:trace-bonds",
  treasuryDaily: "fixed-income:treasury-daily",
  primaryDealers: "fixed-income:primary-dealers",
} as const;
