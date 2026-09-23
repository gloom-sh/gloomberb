import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../../../api-client";
import { Button, EmptyState, QueryBar, usePaneFooter } from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { usePaneTicker } from "../../../../state/app/context";
import { colors } from "../../../../theme/colors";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import { Box } from "../../../../ui";
import { useDialog } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePluginAppActions, usePluginPaneState } from "../../../runtime";
import { SignInWall } from "../auth-actions";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { usePlanAccess } from "../../shared/plan-access";
import { teamStore } from "../team/store";
import { ThesisDetail } from "./detail";
import * as flows from "./flows";
import { thesesCovering } from "./model";
import { promptChoice } from "./prompts";
import { thesisStore } from "./store";

/**
 * The Thesis tab on a ticker: the theses that hold it, or the first question
 * when there is none. Sits next to Notes, and is where most theses start.
 */
export function ThesisTickerTab({ focused, width, height }: TickerResearchTabProps) {
  const { ticker } = usePaneTicker();
  const dialog = useDialog();
  const { notify } = usePluginAppActions();
  const plan = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const snapshot = useSyncExternalStore((onChange) => thesisStore.subscribe(onChange), () => thesisStore.getSnapshot());
  const teams = useSyncExternalStore((onChange) => teamStore.subscribe(onChange), () => teamStore.getSnapshot()).teams;
  const signedIn = useSyncExternalStore((onChange) => apiClient.subscribeCurrentUser(onChange), () => apiClient.isVerified());
  const [activeId, setActiveId] = usePluginPaneState<string | null>("activeThesisId", null);
  const [busy, setBusy] = useState(false);

  const symbol = ticker?.metadata.ticker ?? null;
  const covering = useMemo(() => thesesCovering(snapshot.theses, symbol), [snapshot.theses, symbol]);
  const active = covering.find((thesis) => thesis.id === activeId) ?? covering[0] ?? null;

  // A restored thesis survives the first run; only a later ticker change clears it.
  const seenSymbolRef = useRef(true);
  useEffect(() => {
    if (seenSymbolRef.current) {
      seenSymbolRef.current = false;
      return;
    }
    setActiveId(null);
  }, [symbol]);

  const ctx = useMemo<flows.FlowContext>(() => ({ dialog, notify, hasProAccess: plan.hasProAccess, openUpgrade }), [dialog, notify, openUpgrade, plan.hasProAccess]);

  const start = useCallback(async () => {
    if (!ticker || busy) return;
    setBusy(true);
    try {
      let scope: { scope: "user" } | { scope: "team"; teamId: string } = { scope: "user" };
      if (teams.length > 0) {
        const owner = await promptChoice(dialog, "Whose thesis?", [
          { id: "user", label: "Mine" },
          ...teams.map((team) => ({ id: team.id, label: team.name, description: "Shared with the team; teammates can challenge it." })),
        ], teamStore.getDefaultTeamId() ?? "user");
        if (!owner) return;
        if (owner !== "user") scope = { scope: "team", teamId: owner };
      }
      const held = ticker.metadata.positions.some((position) => position.shares !== 0);
      const note = await apiClient.listCloudNotes({ scope: "user" })
        .then((notes) => notes.find((entry) => entry.kind === "ticker" && entry.key === ticker.metadata.ticker.toUpperCase()))
        .then((summary) => (summary ? apiClient.getCloudNote(summary.id) : null))
        .then((full) => full?.content ?? null)
        .catch(() => null);
      const thesis = await flows.startThesis(ctx, {
        instruments: [{ symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange }],
        scope,
        held,
        note,
      });
      if (thesis) setActiveId(thesis.id);
    } finally {
      setBusy(false);
    }
  }, [busy, ctx, dialog, teams, ticker]);

  useShortcut((event) => {
    if (!focused || active || !signedIn) return;
    if (isPlainKey(event, "n", "return", "enter")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      void start();
    }
  });

  usePaneFooter("ticker-thesis-empty", () => (active || !signedIn ? null : {
    hints: [{ id: "start", key: "n", label: "ew thesis", onPress: () => void start() }],
  }), [active, signedIn, start]);

  if (!ticker) return <EmptyState title="No ticker selected." hint="Select a ticker to see its thesis." />;
  if (!signedIn) {
    return <SignInWall action="keep a thesis on this ticker" hint="Theses are stored in Gloom Cloud so they follow you and your team." />;
  }
  if (!active) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <EmptyState
          title={`No thesis on ${ticker.metadata.ticker} yet.`}
          message={plan.hasProAccess
            ? "Say why you own it. Pillars, kill conditions, and catalysts are drafted from that and the company data; you edit from there."
            : "Say why you own it, then add the claims that must stay true and what would make you sell. Pro drafts them for you and reviews them against news."}
          actions={<Button label={busy ? "Starting…" : "Start a thesis"} variant="primary" disabled={busy} onPress={() => void start()} />}
        />
      </Box>
    );
  }
  const barRows = covering.length > 1 ? 1 : 0;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {covering.length > 1 && (
        <QueryBar
          width={width}
          filters={[{
            id: "thesis",
            label: "Thesis",
            value: active.id,
            options: covering.map((thesis) => ({ label: thesis.title, value: thesis.id })),
            onChange: setActiveId,
          }]}
        />
      )}
      <ThesisDetail
        thesis={active}
        width={width}
        height={height - barRows}
        focused={focused}
        footerId="ticker-thesis"
        onDeleted={() => setActiveId(null)}
      />
    </Box>
  );
}
