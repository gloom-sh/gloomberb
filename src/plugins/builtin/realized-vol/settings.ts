import { REALIZED_VOLATILITY_WINDOWS, type RealizedVolatilityEstimator } from "../shared/volatility";

export const ESTIMATOR_OPTIONS: { value: RealizedVolatilityEstimator; label: string }[] = [
  { value: "close-to-close", label: "Close to close" },
  { value: "parkinson", label: "Parkinson" },
  { value: "garman-klass", label: "Garman-Klass" },
  { value: "rogers-satchell", label: "Rogers-Satchell" },
  { value: "yang-zhang", label: "Yang-Zhang" },
];
export const WINDOW_OPTIONS = REALIZED_VOLATILITY_WINDOWS.map((value) => ({ value: String(value), label: `${value} sessions` }));
export const DEFAULT_WINDOWS = ["10", "30", "90"];

export function selectedWindows(value: unknown): number[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : DEFAULT_WINDOWS;
  return [...new Set(values.map(Number).filter((window) => (REALIZED_VOLATILITY_WINDOWS as readonly number[]).includes(window)))].sort((a, b) => a - b);
}
