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
  /** The bank's next decision from its own published calendar, or China's next 1-year LPR fixing (`kind`). */
  nextMeeting: { date: string; sourceUrl: string; verifiedAt: string; kind?: "decision" | "fixing" } | null
  /** Why `nextMeeting` is null; older servers leave it out, and a null meeting then reads as not published. */
  nextMeetingStatus?: "scheduled" | "not-published" | "not-verified" | "no-policy-rate"
  /** The BIS series definition and breaks, also in `notes`: history a citation of the latest rate leaves out. */
  seriesNotes?: string[]
}

export interface CentralBankRatesPayload {
  generatedAt: string
  status: "available" | "partial" | "unavailable"
  rows: CentralBankRow[]
  gaps: string[]
}
