import type { AppConfig, UpdateChannel, UpdatesConfig } from "../types/config";
import { isRecord } from "../utils/guards";

/** Overrides the saved channel for one run: `GLOOMBERB_UPDATE_CHANNEL=nightly gloomberb`. */
const UPDATE_CHANNEL_ENV = "GLOOMBERB_UPDATE_CHANNEL";

/** What the nightly channel is, in the words the settings and docs use. */
export const NIGHTLY_CHANNEL_SUMMARY = "a daily build of main that gets fixes first and can break";

export function parseUpdateChannel(value: unknown): UpdateChannel | null {
  if (typeof value !== "string") return null;
  const channel = value.trim().toLowerCase();
  return channel === "stable" || channel === "nightly" ? channel : null;
}

/** Only nightly is saved: stable is what an absent setting means. */
export function sanitizeUpdatesConfig(value: unknown): UpdatesConfig | undefined {
  if (!isRecord(value)) return undefined;
  return parseUpdateChannel(value.channel) === "nightly" ? { channel: "nightly" } : undefined;
}

/** The config with `channel` saved, or without the setting when it is stable. */
export function withUpdateChannel(config: AppConfig, channel: UpdateChannel): AppConfig {
  const { updates: _previous, ...rest } = config;
  return channel === "nightly" ? { ...rest, updates: { channel } } : rest;
}

function readChannelOverride(): string | undefined {
  // The browser and desktop views have no process; only the terminal reads it.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[UPDATE_CHANNEL_ENV];
}

/** The channel this run updates on: `GLOOMBERB_UPDATE_CHANNEL` when it names one, else the saved setting, else stable. */
export function resolveUpdateChannel(
  config: Pick<AppConfig, "updates">,
  override: string | undefined = readChannelOverride(),
): UpdateChannel {
  return parseUpdateChannel(override) ?? config.updates?.channel ?? "stable";
}
