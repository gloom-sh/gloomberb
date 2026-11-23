import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type CloudAccountPlan } from "../../api-client";
import { usePlanAccess } from "../../api-client/plan-access";
import { getPaneTemplateDisplayLabel } from "../../components/command-bar/pane-templates/items";
import type { AppPluginStateStorePort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import { recordFunctionOpen } from "../../telemetry/usage-counts";
import { logFailure } from "../../utils/log-failure";
import {
  openedFunctions,
  ownTickers,
  pickProWelcomeChips,
  proWelcomeEligible,
  type ProWelcomeChip,
} from "./model";

/**
 * Whether the row was dismissed lives in the app's local state store (SQLite
 * in the terminal and the desktop app, browser storage on the web), for this
 * machine, never in config.json, cloud sync or anything sent anywhere.
 */
const STATE_OWNER = "core.pro-welcome";
const DISMISSED_KEY = "dismissed";

export interface ProWelcome {
  /** The functions the row names while it shows; null otherwise. */
  chips: ProWelcomeChip[] | null;
  /** Opens a function on its ticker, as the command bar would run it. */
  open(chip: ProWelcomeChip): void;
  /** Puts the row away for good on this machine. */
  dismiss(): void;
}

interface UseProWelcomeOptions {
  /** This window shows the row: the main window, with no setup or sign-in in front of the workspace. */
  active: boolean;
  pluginState: Pick<AppPluginStateStorePort, "get" | "set">;
  pluginRegistry: Pick<PluginRegistry, "paneTemplates" | "createPaneFromTemplateAsync">;
  /** Settles once every plugin has registered: the functions and the account are known by then. */
  pluginsReady?: Promise<unknown>;
  /** Defaults to the Cloud API client's `/account/cloud`. */
  loadPlan?: () => Promise<CloudAccountPlan>;
}

function readDismissed(pluginState: Pick<AppPluginStateStorePort, "get">): boolean {
  try {
    return pluginState.get<boolean>(STATE_OWNER, DISMISSED_KEY)?.value === true;
  } catch (error) {
    logFailure("pro-welcome", "Reading whether the Pro row was dismissed failed")(error);
    return false;
  }
}

/**
 * The first-weeks Pro row's session (see `./model.ts` for who sees it and
 * what it names). The account's plan is asked for once a session, and only
 * for an account on a trial or paying for Pro that has not dismissed the row.
 */
export function useProWelcome({
  active,
  pluginState,
  pluginRegistry,
  pluginsReady,
  loadPlan = () => apiClient.getCloudAccountPlan(),
}: UseProWelcomeOptions): ProWelcome {
  const dispatch = useAppDispatch();
  const initialized = useAppSelector((state) => state.initialized);
  const layout = useAppSelector((state) => state.config.layout);
  const layouts = useAppSelector((state) => state.config.layouts);
  const recentCommands = useAppSelector((state) => state.config.recentCommands);
  const portfolios = useAppSelector((state) => state.config.portfolios);
  const watchlists = useAppSelector((state) => state.config.watchlists);
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);
  const tickers = useAppSelector((state) => state.tickers);
  const recentTickers = useAppSelector((state) => state.recentTickers);
  const access = usePlanAccess();
  const accountId = access.signedIn ? apiClient.getCurrentUser()?.id ?? null : null;

  const [ready, setReady] = useState(!pluginsReady);
  useEffect(() => {
    if (!pluginsReady) return;
    let live = true;
    const done = () => {
      if (live) setReady(true);
    };
    pluginsReady.then(done, done);
    return () => {
      live = false;
    };
  }, [pluginsReady]);

  const [dismissed, setDismissed] = useState(() => readDismissed(pluginState));
  const [plan, setPlan] = useState<{ accountId: string; plan: CloudAccountPlan } | null>(null);
  const asked = useRef(new Set<string>());
  const loadPlanRef = useRef(loadPlan);
  loadPlanRef.current = loadPlan;
  const wanted = active && initialized && ready && !dismissed && (access.isPayingPro || access.isTrialActive) && !!accountId;

  useEffect(() => {
    if (!wanted || !accountId || asked.current.has(accountId)) return;
    asked.current.add(accountId);
    // Kept under the account it is for: one that signed in since never reads it.
    loadPlanRef.current().then(
      (next) => setPlan({ accountId, plan: next }),
      // The row is a nicety: without an answer it stays away until the next launch.
      logFailure("pro-welcome", "Loading the account's plan failed"),
    );
  }, [accountId, wanted]);

  const eligible = wanted && plan?.accountId === accountId && proWelcomeEligible({
    access,
    plan: plan.plan,
    dismissed,
    now: Date.now(),
  });

  const chips = useMemo(() => {
    if (!eligible) return null;
    const paneIdOf = (templateId: string) => pluginRegistry.paneTemplates.get(templateId)?.paneId ?? null;
    const opened = openedFunctions({ layout, layouts, recentCommands }, paneIdOf);
    const own = ownTickers({ portfolios, watchlists }, tickers, recentTickers);
    const picked = pickProWelcomeChips(own, opened, (templateId) => pluginRegistry.paneTemplates.has(templateId));
    return picked.length > 0 ? picked : null;
    // The templates follow the plugins turned on and off.
  }, [disabledPlugins, eligible, layout, layouts, pluginRegistry, portfolios, recentCommands, recentTickers, tickers, watchlists]);

  const open = useCallback((chip: ProWelcomeChip) => {
    const template = pluginRegistry.paneTemplates.get(chip.fn.templateId);
    if (!template) return;
    // Kept as the command bar keeps its runs, so the row stops naming it.
    dispatch({
      type: "RECORD_COMMAND",
      id: `pane-template:${template.id}`,
      label: getPaneTemplateDisplayLabel(template),
      arg: chip.symbol,
    });
    recordFunctionOpen({ shortcut: chip.fn.shortcut, externalPluginId: null });
    pluginRegistry.createPaneFromTemplateAsync(template.id, {
      arg: chip.symbol,
      symbol: chip.symbol,
      ...(chip.ticker ? { ticker: chip.ticker } : {}),
    }).catch(logFailure("pro-welcome", "Opening a Pro function from the row failed"));
  }, [dispatch, pluginRegistry]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      pluginState.set(STATE_OWNER, DISMISSED_KEY, true);
    } catch (error) {
      logFailure("pro-welcome", "Saving the Pro row's dismissal failed")(error);
    }
  }, [pluginState]);

  return useMemo(() => ({ chips, open, dismiss }), [chips, dismiss, open]);
}
