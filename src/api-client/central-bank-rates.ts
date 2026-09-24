import type { MoneyMarketObservation, MoneyMarketPercentile } from "./money-markets";

export interface CentralBankRow {
  id: string
  label: string
  countryCodes: string[]
  centralBank: string | null
  instrument: string
  source: "fred" | "bis" | null
  sourceUrl: string | null
  sourceSeriesIds: string[]
  unit: "percent"
  publicationFrequency: "daily" | "weekly" | null
  value: number | null
  range: { lower: number; upper: number } | null
  asOf: string | null
  lagDays: number | null
  fetchedAt: string | null
  changeBps: number | null
  lastChangeDate: string | null
  previousValue: number | null
  previousAsOf: string | null
  direction: "hike" | "cut" | "unchanged" | "unavailable"
  percentile: MoneyMarketPercentile
  history: MoneyMarketObservation[]
  status: "available" | "stale" | "unavailable"
  unavailableReason: "source-unavailable" | "metadata-mismatch" | "metadata-unavailable" | "no-observations" | "no-policy-rate" | "no-unified-rate" | null
  notes: string[]
  /** When the bank's own site last showed the same level as a lagging BIS observation. */
  confirmedAt?: string | null
  confirmationSourceUrl?: string | null
  nextMeeting: { date: string; sourceUrl: string; verifiedAt: string } | null
}

export interface CentralBankRatesPayload {
  generatedAt: string
  status: "available" | "partial" | "unavailable"
  rows: CentralBankRow[]
  gaps: string[]
}
