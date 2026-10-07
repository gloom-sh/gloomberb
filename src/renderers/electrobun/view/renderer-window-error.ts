import { isBenignWindowError } from "../../../telemetry/benign-window-error";

export type RendererWindowErrorDecision = "fatal" | "ignore";

export function resolveRendererWindowError(input: {
  error: unknown;
  details?: string;
  source?: string;
  appMounted: boolean;
}): RendererWindowErrorDecision {
  if (isBenignWindowError(input.error) || isBenignWindowError(input.details)) {
    return "ignore";
  }
  if (input.appMounted && input.source === "unhandledrejection") {
    return "ignore";
  }
  return "fatal";
}
