import { parsePublicTickerKey } from "../utils/exchanges";
import { nonUsSecListingVenue } from "../utils/sec";

export type HkCcassBucket =
  | "southbound"
  | "foreign_custodian"
  | "foreign_broker"
  | "chinese_broker"
  | "retail_broker"
  | "cip"
  | "local_broker";

export const HK_CCASS_BUCKET_SHORT: Readonly<Record<HkCcassBucket, string>> = {
  southbound: "Southbound",
  foreign_custodian: "Custodian",
  foreign_broker: "Global PB",
  chinese_broker: "CN Broker",
  retail_broker: "Retail",
  cip: "CIP",
  local_broker: "Local",
};

const ADR_TO_HK_CODE: Readonly<Record<string, string>> = {
  BABA: "9988",
  JD: "9618",
  NTES: "9999",
  BIDU: "9888",
  LI: "2015",
  XPEV: "9868",
  NIO: "9866",
  BILI: "9626",
  TCOM: "9961",
  BEKE: "2423",
  ZTO: "2057",
  YUMC: "9987",
  GDS: "9698",
  BGNE: "6160",
  ONC: "6160",
  ZLAB: "9688",
  HTHT: "1179",
  MNSO: "9896",
  WB: "9898",
  BZUN: "9991",
  EDU: "9901",
  ATHM: "2518",
  TUYA: "2391",
  TME: "1698",
  QFIN: "3660",
  ZH: "2390",
  BZ: "2076",
  KC: "3896",
  HSBC: "0005",
};

/** Resolve an HKEX listing or linked dual-listed US China ADR to its canonical HK CCASS code. */
export function hkCcassCode(key: string | null | undefined, exchange?: string): { code: string; viaAdr: string | null } | null {
  if (!key) return null;
  const { symbol } = parsePublicTickerKey(key);
  const venue = nonUsSecListingVenue(key, exchange);
  if (venue === "HKEX" || (!venue && /\.HK$/i.test(symbol))) {
    const raw = symbol.replace(/\.HK$/i, "");
    if (/^\d{1,5}$/.test(raw) && Number(raw) > 0) {
      return { code: String(Number(raw)).padStart(4, "0"), viaAdr: null };
    }
  }
  const clean = symbol.trim().toUpperCase();
  const adrCode = ADR_TO_HK_CODE[clean];
  if (adrCode) return { code: adrCode, viaAdr: clean };
  return null;
}

interface HkCcassBucketSummary {
  bucket: HkCcassBucket;
  label: string;
  shares: number;
  pctOfIssued: number | null;
  pctOfCcass: number | null;
  deltaShares: number | null;
  deltaPct: number | null;
  participantCount: number;
}

export interface HkCcassHoldingRow {
  partId: string;
  ccassId: string | null;
  name: string;
  bucket: HkCcassBucket;
  shares: number;
  pct: number | null;
  prevShares: number | null;
  deltaShares: number | null;
  deltaPct: number | null;
  lastChanged: string;
}

export interface HkCcassBigChangeRow {
  date: string;
  code: string;
  symbol: string;
  stockName: string;
  stockNameZh: string | null;
  partId: string;
  ccassId: string | null;
  participantName: string;
  bucket: HkCcassBucket;
  prevShares: number;
  shares: number;
  deltaShares: number;
  deltaPct: number;
  isDeposit: boolean;
  isWithdrawal: boolean;
  observedAt: string;
}

export interface HkCcassConcentrationRow {
  code: string;
  symbol: string;
  stockName: string;
  stockNameZh: string | null;
  date: string;
  issuedShares: number | null;
  ccassShares: number;
  ccassPct: number | null;
  top5Pct: number | null;
  top10Pct: number | null;
  top10PlusNonCcassPct: number | null;
  southboundPct: number | null;
  participants: number;
  ccassDeltaPct: number | null;
}

export interface HkCcassSouthboundRow {
  code: string;
  symbol: string;
  stockName: string;
  stockNameZh: string | null;
  date: string;
  southboundShares: number;
  southboundPct: number | null;
  deltaShares: number | null;
  deltaPct: number | null;
  ccassPct: number | null;
  top10Pct: number | null;
}

interface HkCcassParticipantSummary {
  partId: string;
  ccassId: string | null;
  name: string;
  bucket: HkCcassBucket;
  firstSeen: string;
  lastSeen: string;
  positionsCount: number;
}

export interface HkCcassParticipantHoldingRow {
  code: string;
  symbol: string;
  stockName: string;
  stockNameZh: string | null;
  date: string;
  shares: number;
  pct: number | null;
  prevShares: number | null;
  deltaShares: number | null;
  deltaPct: number | null;
  lastChanged: string;
}

export interface HkCcassStockPayload {
  code: string;
  symbol: string;
  viaAdr: string | null;
  stockName: string;
  stockNameZh: string | null;
  active: boolean;
  indexable: boolean;
  asOfDate: string;
  compareFromDate: string | null;
  daysTracked: number;
  issuedShares: number | null;
  ccassShares: number;
  ccassPct: number | null;
  outsideCcassShares: number | null;
  outsideCcassPct: number | null;
  intermediaryShares: number;
  intermediaryCount: number;
  cipShares: number;
  cipCount: number;
  ncipShares: number;
  ncipCount: number;
  top5Pct: number | null;
  top10Pct: number | null;
  top10PlusNonCcassPct: number | null;
  southboundShares: number;
  southboundPct: number | null;
  ccassDeltaShares: number | null;
  ccassDeltaPct: number | null;
  buckets: HkCcassBucketSummary[];
  holdings: HkCcassHoldingRow[];
  totalHoldings: number;
  bigChanges: HkCcassBigChangeRow[];
  attribution: string;
  observedAt: string | null;
}

export interface HkCcassBigChangesPayload {
  rows: HkCcassBigChangeRow[];
  total: number;
  latestDate: string | null;
}

export interface HkCcassConcentrationPayload {
  rows: HkCcassConcentrationRow[];
  total: number;
  latestDate: string | null;
}

export interface HkCcassSouthboundPayload {
  rows: HkCcassSouthboundRow[];
  total: number;
  latestDate: string | null;
}

export interface HkCcassParticipantPortfolioPayload {
  participant: HkCcassParticipantSummary;
  asOfDate: string | null;
  compareFromDate: string | null;
  holdings: HkCcassParticipantHoldingRow[];
  totalHoldings: number;
  bigChanges: HkCcassBigChangeRow[];
  attribution: string;
}
