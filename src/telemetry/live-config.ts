import type { TelemetryConfig } from "../types/config";

/**
 * The telemetry switches as the running app has them. A renderer reads its
 * config once at launch; the app reports every change here, so a switch
 * turned off in the command bar takes effect at once, not at the next launch.
 */
let reported: { telemetry?: TelemetryConfig } | null = null;

export function reportTelemetryConfig(telemetry: TelemetryConfig | undefined): void {
  reported = { telemetry };
}

/** The switches the app last reported, or the config read at launch until it has. */
export function currentTelemetryConfig(
  launch: { telemetry?: TelemetryConfig } | null | undefined,
): { telemetry?: TelemetryConfig } | null | undefined {
  return reported ?? launch;
}
