import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import {
  apiClient,
  yearlyRefusalCode,
  type CloudYearlyOffer,
  type CloudYearlyPlanStatus,
  type CloudYearlyResult,
  type CloudYearlyReview,
} from "../../../api-client";
import { Button, FieldLabel, KeyValueRow } from "../../../components";
import { t, tf } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes, useRendererHost, type BoxRenderable } from "../../../ui";
import { formatDetailDate, formatShortDate } from "../../../utils/datetime-format";

/**
 * The Pro tab's offer to move a monthly Pro subscription to yearly billing:
 * the offer, the exact review of the charge, and the outcome, all inline.
 * The server decides who may switch and what it costs; the row never says a
 * switch is done before the server reports it paid.
 */

/** Exact cents, as on an invoice: $567.29, $630.00. */
function formatExactUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Whole dollars when exact, for the offer line: $630, $210. */
function formatOfferUsd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatExactUsd(cents);
}

function yearlyOfferText(offer: CloudYearlyOffer): string {
  return tf("Yearly is {yearly} a year, {savings} less than twelve monthly payments of {monthly} ({twelve}).", {
    yearly: formatOfferUsd(offer.yearlyAmount),
    savings: formatOfferUsd(offer.savingsAmount),
    monthly: formatOfferUsd(offer.monthlyAmount),
    twelve: formatOfferUsd(offer.twelveMonthlyAmount),
  });
}

/** What the server's refusals mean here, in the app's language. */
function refusalMessage(code: string | null): string {
  switch (code) {
    case "review_changed": return t("The total changed since you reviewed it. Review it again.");
    case "review_expired": return t("This total has expired. Review it again.");
    case "review_invalid": return t("This review is no longer valid. Review the switch again.");
    case "busy": return t("Your switch is already going through. Refresh in a moment.");
    case "pending": return t("Your switch to yearly is waiting for its payment.");
    case "unavailable": return t("Yearly billing can't be set up for this plan here. Your plan is unchanged.");
    case "failed": return t("The switch didn't go through and your plan is unchanged. Try again in a minute.");
    default: return t("We couldn't confirm the switch. Refresh your account before trying again.");
  }
}

export type YearlyPlanView =
  | { kind: "hidden" }
  | { kind: "offer"; offer: CloudYearlyOffer }
  | { kind: "review"; review: CloudYearlyReview }
  | { kind: "pending"; invoiceUrl: string | null; expiresAt: string | null }
  | { kind: "result"; result: CloudYearlyResult };

/**
 * `onReviewOpened` runs in the same update that shows the review, so the
 * caller can move the keyboard to Not Now before any render has the payment
 * active.
 */
export function useYearlyPlan(enabled: boolean, sessionMarker: string, onSwitched: () => void, onReviewOpened: () => void) {
  const renderer = useRendererHost();
  const [status, setStatus] = useState<CloudYearlyPlanStatus | null>(null);
  const [review, setReview] = useState<CloudYearlyReview | null>(null);
  const [result, setResult] = useState<CloudYearlyResult | null>(null);
  const [busy, setBusy] = useState<"review" | "confirm" | "invoice" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  // One confirmation at a time, whatever presses arrive while it is out.
  const confirming = useRef(false);

  const load = useCallback(async (current: number) => {
    try {
      const next = await apiClient.getCloudYearlyPlan();
      if (generation.current !== current) return;
      setStatus(next);
      // A payment the row was waiting on is now the server's status to tell.
      setResult((shown) => shown?.state === "switched" ? shown : null);
    } catch {
      // Intentional ignore: without an answer the row stays hidden; the plan is unchanged.
      if (generation.current === current) setStatus(null);
    }
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setReview(null);
    setBusy(null);
    setMessage(null);
    if (enabled) void load(current).catch(() => setStatus(null));
    else setResult((shown) => shown?.state === "switched" ? shown : null);
    return () => { generation.current++; };
  }, [enabled, sessionMarker, load]);

  const openReview = useCallback(async () => {
    if (busy) return;
    const current = generation.current;
    setBusy("review");
    setMessage(null);
    try {
      const next = await apiClient.previewCloudYearlyPlan();
      if (generation.current === current) {
        // One batched update: a key held down never finds Pay active on open.
        setReview(next);
        onReviewOpened();
      }
    } catch (error) {
      if (generation.current !== current) return;
      const code = yearlyRefusalCode(error);
      setMessage(code ? refusalMessage(code) : t("Couldn't work out the yearly total. Try again in a minute."));
      if (code) await load(current);
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }, [busy, load, onReviewOpened]);

  const confirm = useCallback(async () => {
    if (!review || confirming.current) return;
    confirming.current = true;
    const current = generation.current;
    setBusy("confirm");
    setMessage(null);
    try {
      const answer = await apiClient.confirmCloudYearlyPlan(review.token);
      if (generation.current !== current) return;
      setReview(null);
      setResult(answer);
      if (answer.state === "switched") onSwitched();
    } catch (error) {
      if (generation.current !== current) return;
      const code = yearlyRefusalCode(error);
      setMessage(refusalMessage(code));
      // A total that moved or ran out: show the new one, never charge the old.
      if (code !== "busy") {
        setReview(null);
        await load(current);
      }
    } finally {
      confirming.current = false;
      if (generation.current === current) setBusy(null);
    }
  }, [load, onSwitched, review]);

  const dismiss = useCallback(() => {
    if (busy === "confirm") return;
    setReview(null);
    setMessage(null);
  }, [busy]);

  const pendingUrl = result?.state === "payment_required"
    ? result.invoiceUrl
    : status?.state === "pending" ? status.invoiceUrl : null;
  const openInvoice = useCallback(async () => {
    if (!pendingUrl || busy) return;
    const current = generation.current;
    setBusy("invoice");
    try {
      const opened = await renderer.openExternal(pendingUrl);
      if (generation.current === current) {
        setMessage(opened === false ? t("Could not open invoice payment. Try again.") : t("Invoice opened in your browser."));
      }
    } catch {
      if (generation.current === current) setMessage(t("Could not open invoice payment. Try again."));
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }, [busy, pendingUrl, renderer]);

  let view: YearlyPlanView = { kind: "hidden" };
  if (result) view = { kind: "result", result };
  else if (review) view = { kind: "review", review };
  else if (status?.state === "pending") view = { kind: "pending", invoiceUrl: status.invoiceUrl, expiresAt: status.expiresAt };
  else if (status?.state === "available") view = { kind: "offer", offer: status.offer };
  if (!enabled && view.kind !== "result") view = { kind: "hidden" };

  /** What Enter on the row's first action does now, if anything. */
  const primary = view.kind === "offer"
    ? () => { void openReview().catch(() => setMessage(t("Couldn't work out the yearly total. Try again in a minute."))); }
    : view.kind === "review"
      ? () => { void confirm().catch(() => setMessage(refusalMessage(null))); }
      : pendingUrl && (view.kind === "pending" || view.kind === "result")
        ? () => { void openInvoice().catch(() => setMessage(t("Could not open invoice payment. Try again."))); }
        : null;

  return { view, busy, message, primary, dismiss, reviewing: view.kind === "review" };
}

function ReviewLines({ review, width }: { review: CloudYearlyReview; width: number }) {
  const lineWidth = Math.max(24, Math.min(width, 56));
  return (
    <Box flexDirection="column" width={lineWidth}>
      <KeyValueRow
        label={tf("Yearly Pro, today to {date}", { date: formatShortDate(review.renewsAt) })}
        value={formatExactUsd(review.yearlyAmount)}
        width={lineWidth}
        align="right"
        emphasis={false}
      />
      <KeyValueRow
        label={t("Credit for the rest of this month")}
        value={review.credit > 0 ? `-${formatExactUsd(review.credit)}` : formatExactUsd(0)}
        width={lineWidth}
        align="right"
        emphasis={false}
      />
      {review.tax > 0 ? (
        <KeyValueRow label={t("Tax")} value={formatExactUsd(review.tax)} width={lineWidth} align="right" emphasis={false} />
      ) : null}
      {review.balanceApplied > 0 ? (
        <KeyValueRow label={t("Account credit")} value={`-${formatExactUsd(review.balanceApplied)}`} width={lineWidth} align="right" emphasis={false} />
      ) : null}
      <KeyValueRow label={t("Due today")} value={formatExactUsd(review.amountDue)} width={lineWidth} align="right" />
    </Box>
  );
}

function renewalText(review: CloudYearlyReview): string {
  const params = { amount: formatExactUsd(review.renewalAmount), date: formatShortDate(review.renewsAt) };
  return review.renewalTaxed
    ? tf("Then {amount} a year plus tax, renewing {date}.", params)
    : tf("Then {amount} a year, renewing {date}.", params);
}

function PaymentNeeded({ expiresAt }: { expiresAt: string | null }) {
  return (
    <Text fg={colors.text} wrapMode="word">
      {[
        t("Your switch to yearly needs the payment confirmed. You stay on monthly billing until it is paid."),
        expiresAt ? tf("Unpaid by {date}, the switch is dropped.", { date: formatDetailDate(expiresAt) }) : "",
      ].filter(Boolean).join(" ")}
    </Text>
  );
}

function resultText(result: Extract<CloudYearlyResult, { state: "switched" | "processing" }>): string {
  if (result.state === "processing") return t("Your payment is processing. You move to yearly billing once it clears.");
  return [
    t("You're on yearly billing."),
    result.amountPaid !== null ? tf("Paid {amount} today.", { amount: formatExactUsd(result.amountPaid) }) : "",
    result.renewsAt ? tf("Renews {date} at {amount}.", { date: formatShortDate(result.renewsAt), amount: formatExactUsd(result.renewalAmount) }) : "",
  ].filter(Boolean).join(" ");
}

/**
 * The row as it draws for one state. Two actions while reviewing: the
 * payment, and Not Now, which the keyboard lands on first so a second Enter
 * never pays by itself.
 */
export function YearlyPlanRow({
  view,
  busy,
  message,
  width,
  labelWidth,
  primaryActive,
  dismissActive,
  primaryRef,
  dismissRef,
  onPrimary,
  onDismiss,
  onFocusPrimary,
  onFocusDismiss,
}: {
  view: YearlyPlanView;
  busy: "review" | "confirm" | "invoice" | null;
  message: string | null;
  width: number;
  labelWidth: number;
  primaryActive: boolean;
  dismissActive: boolean;
  primaryRef?: Ref<BoxRenderable>;
  dismissRef?: Ref<BoxRenderable>;
  onPrimary: (() => void) | null;
  onDismiss: () => void;
  onFocusPrimary: () => void;
  onFocusDismiss: () => void;
}) {
  if (view.kind === "hidden" && !message) return null;
  const bodyWidth = Math.max(20, width - labelWidth - 1);
  const pendingUrl = view.kind === "pending"
    ? view.invoiceUrl
    : view.kind === "result" && view.result.state === "payment_required" ? view.result.invoiceUrl : null;
  return (
    <Box flexDirection="row" gap={1}>
      <FieldLabel label={t("Yearly")} active={primaryActive || dismissActive} width={labelWidth} />
      <Box flexDirection="column" flexShrink={1} minWidth={0} gap={1} width={bodyWidth}>
        {view.kind === "offer" ? (
          <>
            <Text fg={colors.text} wrapMode="word">{yearlyOfferText(view.offer)}</Text>
            <Box ref={primaryRef} flexDirection="row" onMouseDown={onFocusPrimary}>
              <Button
                label={busy === "review" ? t("Loading...") : t("Review Yearly")}
                active={primaryActive}
                disabled={!!busy}
                onPress={() => onPrimary?.()}
              />
            </Box>
          </>
        ) : null}
        {view.kind === "review" ? (
          <>
            <Text fg={colors.text} attributes={TextAttributes.BOLD}>{t("Switch to yearly billing")}</Text>
            <ReviewLines review={view.review} width={bodyWidth} />
            <Text fg={colors.textDim} wrapMode="word">
              {`${renewalText(view.review)} ${t("Your saved payment method is charged today, and your plan stays monthly until it is paid.")}`}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Box ref={primaryRef} flexDirection="row" onMouseDown={onFocusPrimary}>
                <Button
                  label={busy === "confirm"
                    ? t("Switching...")
                    : view.review.amountDue > 0
                      ? tf("Pay {amount} and Switch", { amount: formatExactUsd(view.review.amountDue) })
                      : t("Switch to Yearly")}
                  variant="primary"
                  active={primaryActive}
                  disabled={!!busy}
                  onPress={() => onPrimary?.()}
                />
              </Box>
              <Box ref={dismissRef} flexDirection="row" onMouseDown={onFocusDismiss}>
                <Button
                  label={t("Not Now")}
                  active={dismissActive}
                  disabled={busy === "confirm"}
                  onPress={onDismiss}
                />
              </Box>
            </Box>
          </>
        ) : null}
        {view.kind === "pending" ? <PaymentNeeded expiresAt={view.expiresAt} /> : null}
        {view.kind === "result" && view.result.state === "payment_required" ? <PaymentNeeded expiresAt={view.result.expiresAt} /> : null}
        {view.kind === "result" && view.result.state !== "payment_required" ? (
          <Text fg={colors.text} wrapMode="word">{resultText(view.result)}</Text>
        ) : null}
        {pendingUrl ? (
          <Box ref={primaryRef} flexDirection="row" onMouseDown={onFocusPrimary}>
            <Button
              label={busy === "invoice" ? t("Opening...") : t("Confirm Payment")}
              active={primaryActive}
              disabled={!!busy}
              onPress={() => onPrimary?.()}
            />
          </Box>
        ) : null}
        {message ? <Text fg={colors.textDim} wrapMode="word">{message}</Text> : null}
      </Box>
    </Box>
  );
}
