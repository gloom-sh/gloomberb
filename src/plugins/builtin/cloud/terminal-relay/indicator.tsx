import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../../../components/ui/button";
import { t, tf } from "../../../../i18n";
import { getSharedRegistry } from "../../../registry";
import { requestAccountManagementTab } from "../../account-management/navigation";
import type { RelayActivity } from "./engine";

/** An assistant counts as connected for this long after its last call. */
const CONNECTED_FOR_MS = 5 * 60_000;
/** The chip brightens this long after each call. */
const ACTING_FOR_MS = 2_500;

interface ActivityState {
  name: string;
  clientId: string;
  at: number;
}

let current: ActivityState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Fed by the relay engine. */
export function recordRelayActivity(activity: RelayActivity): void {
  if (activity.type === "acted") {
    current = { name: activity.caller.name, clientId: activity.caller.id, at: activity.at };
  } else if (current?.clientId === activity.clientId) {
    current = null;
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A quiet chip in the status bar while a remote assistant drives this
 * terminal: dim while connected, bright for a moment when it acts. It opens
 * Account Management on the Agents tab, where the assistant can be revoked.
 */
export function TerminalRelayStatusWidget() {
  const activity = useSyncExternalStore(subscribe, () => current, () => current);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activity) return;
    setNow(Date.now());
    const acting = setTimeout(() => setNow(Date.now()), ACTING_FOR_MS + 50);
    const connected = setTimeout(() => setNow(Date.now()), CONNECTED_FOR_MS + 50);
    return () => {
      clearTimeout(acting);
      clearTimeout(connected);
    };
  }, [activity]);

  if (!activity || now - activity.at > CONNECTED_FOR_MS) return null;
  const acting = now - activity.at < ACTING_FOR_MS;
  return (
    <Button
      label={acting ? tf("{name} is acting", { name: activity.name }) : tf("{name} connected", { name: activity.name })}
      title={t("A remote assistant controls this terminal. Open Agents to revoke it.")}
      variant="plain"
      active={acting}
      compact
      stopPropagation
      onPress={() => {
        requestAccountManagementTab("agents");
        getSharedRegistry()?.showPane("account-management");
      }}
    />
  );
}
