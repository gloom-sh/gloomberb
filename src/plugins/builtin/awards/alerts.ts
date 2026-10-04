import { useEffect } from "react";
import type { AwardRow, AwardsPayload } from "../../../api-client/awards";
import { usePaneSettingValue, usePaneVisible, usePluginAppActions, usePluginPaneState } from "../../../public/react";

interface AlertState { scope: string; seen: string[]; through: string }
export function newAwardAlerts(data: AwardsPayload, previous: AlertState | null, scope: string): { state: AlertState; fresh: AwardRow[] } {
  const seen = new Set(previous?.scope === scope ? previous.seen : []);
  const now = Date.parse(data.generatedAt);
  const fresh = previous?.scope === scope ? data.alerts.filter((row) => !seen.has(row.id)
    && (row.revenueComparison?.percent ?? 0) >= 1
    && Date.parse(row.observedAt) > Date.parse(previous.through)
    && Date.parse(row.awardDate) >= now - 7 * 86_400_000 && Date.parse(row.awardDate) <= now) : [];
  return { state: { scope, seen: [...new Set([...data.alerts.map((row) => row.id), ...seen])].slice(0, 500), through: data.generatedAt }, fresh };
}

export function useAwardAlerts(data: AwardsPayload | undefined, scope: string, openAward: (id: string) => void) {
  const [enabled] = usePaneSettingValue("awardAlerts", false);
  const visible = usePaneVisible();
  const [previous, setPrevious] = usePluginPaneState<AlertState | null>("awards:alerts", null);
  const { notify } = usePluginAppActions();
  useEffect(() => {
    if (!data || !visible) return;
    const key = `${scope}:${enabled}:${data.access}`;
    if (previous?.scope === key && previous.through === data.generatedAt) return;
    const { state, fresh } = newAwardAlerts(data, previous, key);
    setPrevious(state);
    if (!enabled || data.access !== "full" || !fresh.length) return;
    const row = [...fresh].sort((a, b) => (b.revenueComparison?.percent ?? 0) - (a.revenueComparison?.percent ?? 0))[0]!;
    notify({ title: "Government award", body: `${row.entity?.ticker ?? row.recipient.name}: award = ${row.revenueComparison!.percent.toFixed(2)}% of annual revenue${fresh.length > 1 ? ` · ${fresh.length - 1} more new awards` : ""}`,
      desktop: "never", action: { label: "View award", onClick: () => openAward(row.id) } });
  }, [data, scope, enabled, visible, previous, setPrevious, notify, openAward]);
}
