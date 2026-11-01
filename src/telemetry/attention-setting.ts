import type { TelemetryConfig } from "../types/config";

/**
 * The Attention Counts setting, apart from the collector. It is on by
 * default: `telemetry.attention: false` turns it off and `true` is an
 * explicit on. While it is unset, an account counts only after this
 * installation has drawn the one-time notice for it; an explicit choice
 * either way never needs the notice. While signed in, an off is the
 * account's: cloud sync carries it to the account's other devices
 * (`mergedAttentionTelemetry` in sync/core-contributors.ts).
 */

/** What switching off says, from the notice or the command bar: counting stops, published totals stay. */
export const ATTENTION_OFF_MESSAGE = "Attention Counts is off. Totals already published can't be withdrawn.";

/** How many accounts an installation remembers showing the notice to. */
export const ATTENTION_NOTICE_ACCOUNTS = 20;

export function attentionNoticeShown(telemetry: TelemetryConfig | undefined, account: string | null): boolean {
  return account !== null && (telemetry?.attentionNoticeShownTo?.includes(account) ?? false);
}

/** Whether `account` is waiting for the notice: the setting is untouched and this installation never showed it. */
export function attentionNoticeDue(telemetry: TelemetryConfig | undefined, account: string | null): boolean {
  return account !== null && telemetry?.attention === undefined && !attentionNoticeShown(telemetry, account);
}

/** Records that the notice was drawn for `account`. The same object when it already was. */
export function withAttentionNoticeShown(telemetry: TelemetryConfig | undefined, account: string): TelemetryConfig | undefined {
  if (attentionNoticeShown(telemetry, account)) return telemetry;
  const accounts = [...(telemetry?.attentionNoticeShownTo ?? []), account].slice(-ATTENTION_NOTICE_ACCOUNTS);
  return { ...telemetry, attentionNoticeShownTo: accounts };
}
