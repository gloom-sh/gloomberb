import { useMemo, useState, useSyncExternalStore } from "react";
import { EmptyState, usePaneFooter, type PaneHint } from "../../../../components";
import { ListView, type ListViewItem } from "../../../../components/ui/list-view";
import { t, tf } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { useShortcut } from "../../../../react/input";
import { Box } from "../../../../ui";
import { formatTimeAgo } from "../../../../utils/datetime-format";
import { isPlainKey } from "../../../../utils/keyboard";
import { type AssistantGrant, terminalRelayGrants } from "./grants";
import { recordRelayActivity } from "./indicator";

const EMPTY: AssistantGrant[] = [];

function decisionText(grant: AssistantGrant): string {
  if (grant.decision === "deny") return t("Denied");
  return grant.decision === "always" ? t("Always allowed") : t("Allowed this session");
}

/**
 * The Agents tab of the account pane: the remote assistants that asked to
 * control this terminal, and what was decided. `r` revokes the selected one,
 * so its next call asks again; revoking a key or disconnecting a client in
 * Cloud settings does the same from the web.
 */
export function AgentsAccountTab({ focused, width }: { focused: boolean; width: number }) {
  const language = useAppLanguage();
  const grants = useSyncExternalStore(
    (listener) => terminalRelayGrants.subscribe(listener),
    () => terminalRelayGrants.list(),
    () => EMPTY,
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = useMemo<ListViewItem[]>(() => grants.map((grant) => ({
    id: grant.clientId,
    label: grant.name,
    description: grant.lastUsedAt
      ? tf("{decision} · last acted {ago}", { decision: decisionText(grant), ago: formatTimeAgo(new Date(grant.lastUsedAt)) })
      : decisionText(grant),
    right: grant.decision === "deny" ? t("denied") : grant.decision === "always" ? t("always") : t("session"),
  })), [grants, language]);
  const index = Math.min(selectedIndex, Math.max(0, items.length - 1));
  const selected = grants[index];

  const revoke = (grant: AssistantGrant | undefined) => {
    if (!grant) return;
    terminalRelayGrants.forget(grant.clientId);
    recordRelayActivity({ type: "revoked", clientId: grant.clientId });
  };

  useShortcut((event) => {
    if (!focused || event.targetEditable || items.length === 0) return;
    if (isPlainKey(event, "down", "j")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex(Math.min(items.length - 1, index + 1));
    } else if (isPlainKey(event, "up", "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex(Math.max(0, index - 1));
    }
  });

  const hints = useMemo<PaneHint[]>(() => selected
    ? [{ id: "revoke", key: "r", label: "evoke", title: t("Revoke"), onPress: () => revoke(selected) }]
    : [], [selected, language]);
  usePaneFooter("account-management:agents", () => ({ info: [], hints }), [hints]);

  if (items.length === 0) {
    return (
      <EmptyState
        title={t("No assistant has asked to control this terminal.")}
        hint={t("Connect one to the Gloom Cloud MCP with Terminal control.")}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <ListView
        items={items}
        selectedIndex={index}
        onSelect={setSelectedIndex}
        showSelectedDescription
        surface="plain"
      />
    </Box>
  );
}
