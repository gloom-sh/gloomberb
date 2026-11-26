import { parsePublicTickerKey } from "../utils/exchanges";

type CbbcDirection = "bull" | "bear";

export interface HkCbbcContractRow {
  atDate: string;
  cbbcCode: string;
  cbbcName: string;
  underlyingCode: string;
  underlyingName: string | null;
  issuer: string;
  issuerName: string;
  direction: CbbcDirection;
  category: string | null;
  strikeLevel: number;
  callLevel: number;
  entitlementRatio: number;
  issueSize: number;
  streetUnits: number;
  outInMarketPct: number;
  equivUnits: number;
  equivFutures: number | null;
  boughtUnits: number;
  soldUnits: number;
  closingPrice: number | null;
  volume: number;
  turnoverHkd: number;
  listingDate: string | null;
  maturityDate: string | null;
  mceOccurred: boolean;
  delistingDate: string | null;
}

export interface HkCbbcZoneBucket {
  zoneLow: number;
  zoneHigh: number;
  label: string;
  direction: CbbcDirection;
  contractsCount: number;
  streetUnits: number;
  equivUnits: number;
  equivFutures: number | null;
  distancePct: number | null;
  turnoverHkd: number;
  topIssuer: string | null;
  isHeavyZone: boolean;
}

export interface HkCbbcSummary {
  atDate: string;
  underlyingCode: string;
  displaySymbol: string;
  underlyingName: string;
  isIndex: boolean;
  spotLevel: number | null;
  contractsCount: number;
  bullContracts: number;
  bearContracts: number;
  bullEquivUnits: number;
  bearEquivUnits: number;
  bullEquivFutures: number | null;
  bearEquivFutures: number | null;
  bullRatioPct: number | null;
  heavyBullCallLow: number | null;
  heavyBullCallHigh: number | null;
  heavyBullEquiv: number | null;
  heavyBearCallLow: number | null;
  heavyBearCallHigh: number | null;
  heavyBearEquiv: number | null;
  totalTurnoverHkd: number;
  mceCount: number;
}

export interface HkCbbcUnderlyingPayload {
  summary: HkCbbcSummary;
  availableDates: string[];
  zoneStep: number;
  bullZones: HkCbbcZoneBucket[];
  bearZones: HkCbbcZoneBucket[];
  topBullContracts: HkCbbcContractRow[];
  topBearContracts: HkCbbcContractRow[];
  recentMceContracts: HkCbbcContractRow[];
}

export interface HkCbbcOverviewPayload {
  latestDate: string | null;
  availableDates: string[];
  trackedUnderlyings: number;
  totalContracts: number;
  totalTurnoverHkd: number;
  totalMceToday: number;
  hsiSummary: HkCbbcSummary | null;
  hstechSummary: HkCbbcSummary | null;
  topUnderlyings: HkCbbcSummary[];
}

/**
 * Resolves a Hong Kong index (`HSI`, `^HSI`, `HSTECH`, `HSCEI`) or HKEX equity (`0700.HK`, `700:HKEX`)
 * to its HKEX CBBC underlying code. Returns null for non-HK tickers.
 */
export function hkCbbcUnderlying(
  key: string | null | undefined,
  exchange?: string,
): string | null {
  if (!key) return null;
  const clean = key.trim().toUpperCase();
  if (clean === "HSI" || clean === "^HSI" || clean === "HSI.HK" || clean === "HSI:HKEX") {
    return "HSI";
  }
  if (clean === "HSTECH" || clean === "^HSTECH" || clean === "HSTEC" || clean === "HSTECH.HK") {
    return "HSTEC";
  }
  if (clean === "HSCEI" || clean === "^HSCE" || clean === "HSCE") {
    return "HSCEI";
  }
  const directHk = /^0*(\d{1,5})(?:\.HK|:HKEX)$/.exec(clean);
  if (directHk && Number(directHk[1]) > 0) {
    return directHk[1]!.padStart(5, "0");
  }
  const parsed = parsePublicTickerKey(clean);
  const ex = (exchange ?? parsed.exchange ?? "").trim().toUpperCase();
  if ((ex === "HKEX" || ex === "XHKG") && /^\d{1,5}$/.test(parsed.symbol) && Number(parsed.symbol) > 0) {
    return parsed.symbol.padStart(5, "0");
  }
  return null;
}

export function cloudHkCbbcUnderlyingPath(underlying: string, limit = 40): string {
  return `/cloud/hk-cbbc/underlyings/${encodeURIComponent(underlying)}?limit=${limit}`;
}

export function cloudHkCbbcOverviewPath(limit = 40): string {
  return `/cloud/hk-cbbc/overview?limit=${limit}`;
}
