/** What one run of the Windows desktop check writes to results.json. */

export type CheckStatus = "pass" | "fail" | "info" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** What happened, with the numbers. */
  detail: string;
  /** Picture file names under the run's shots folder. */
  shots: string[];
  ms: number;
  data?: unknown;
}

export interface CheckRun {
  /** Which build: "release" or "head". */
  label: string;
  version: string;
  started: string;
  /** The display scale in percent the run saw. */
  scale: number;
  screen: string;
  results: CheckResult[];
  fatal: string | null;
}
