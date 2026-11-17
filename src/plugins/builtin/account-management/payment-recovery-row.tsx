import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { apiClient, type CloudAccountPlan } from "../../../api-client";
import { Button, FieldLabel } from "../../../components";
import { t } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { Box, Text, useRendererHost, type BoxRenderable } from "../../../ui";

/**
 * The Pro tab's read of the account's own subscription (`/account/cloud`): the
 * payment row while a charge failed, and the plan the cancel action reads.
 */
export function usePaymentRecovery(enabled: boolean, sessionMarker: string) {
  const renderer = useRendererHost();
  const [plan, setPlan] = useState<CloudAccountPlan | null>(null);
  const status = plan?.subscription?.status ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const opening = useRef<number | null>(null);
  const refreshSequence = useRef(0);
  const visible = status === "past_due" || status === "unpaid";

  const refresh = useCallback(async (current: number) => {
    if (generation.current !== current) return;
    const sequence = ++refreshSequence.current;
    try {
      const plan = await apiClient.getCloudAccountPlan();
      if (generation.current === current && refreshSequence.current === sequence) setPlan(plan);
    } catch {
      if (generation.current === current && refreshSequence.current === sequence) setMessage(t("Could not refresh your account. Try again."));
    } finally {
      if (generation.current === current && refreshSequence.current === sequence) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    setPlan(null);
    setMessage(null);
    setBusy(false);
    setLoaded(false);
    if (enabled) void refresh(current).catch(() => setMessage(t("Could not refresh your account. Try again.")));
    return () => { generation.current++; };
  }, [enabled, sessionMarker, refresh]);

  useEffect(() => {
    if (!enabled || !visible) return;
    const current = generation.current;
    const timer = setInterval(() => { void refresh(current).catch(() => setMessage(t("Could not refresh your account. Try again."))); }, 5_000);
    return () => clearInterval(timer);
  }, [enabled, visible, refresh]);

  const pay = useCallback(async () => {
    if (opening.current === generation.current || !enabled || !visible) return;
    opening.current = generation.current;
    setBusy(true);
    setMessage(null);
    const current = generation.current;
    try {
      const { url } = await apiClient.createInvoicePayment();
      if (generation.current !== current) return;
      const opened = await renderer.openExternal(url);
      if (generation.current === current) {
        setMessage(opened === false ? t("Could not open invoice payment. Try again.") : t("Invoice opened in your browser."));
      }
    } catch {
      if (generation.current === current) setMessage(t("Could not open invoice payment. Try again."));
    } finally {
      await refresh(current);
      if (opening.current === current) opening.current = null;
      if (generation.current === current) setBusy(false);
    }
  }, [enabled, visible, renderer, refresh]);

  const openPayment = useCallback(() => {
    void pay().catch(() => setMessage(t("Could not open invoice payment. Try again.")));
  }, [pay]);

  const reload = useCallback(() => refresh(generation.current), [refresh]);

  return { visible, busy, message, pay: openPayment, checking: enabled && !loaded, plan, reload };
}

export function PaymentRecoveryRow({ active, busy, message, labelWidth, nodeRef, onPay, onFocus }: {
  active: boolean;
  busy: boolean;
  message: string | null;
  labelWidth: number;
  nodeRef?: Ref<BoxRenderable>;
  onPay: () => void;
  onFocus: () => void;
}) {
  return (
    <Box ref={nodeRef} flexDirection="row" gap={1} onMouseDown={onFocus}>
      <FieldLabel label={t("Payment")} active={active} width={labelWidth} />
      <Box flexDirection="column" flexShrink={1} minWidth={0} gap={1}>
        <Text fg={colors.text} wrapMode="word">{t("Your Pro payment did not go through.")}</Text>
        <Button label={busy ? t("Opening...") : t("Pay invoice")} active={active} disabled={busy} onPress={onPay} />
        {message ? <Text fg={colors.textDim} wrapMode="word">{message}</Text> : null}
      </Box>
    </Box>
  );
}
