export interface ShortInterestRecord {
  settlementDate: Date;
  sharesShort: number;
  shortRatio: number | null;
  averageDailyVolume: number | null;
  shortPercentFloat: number | null;
}
