import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../api-client";
import type { AppPluginStateStorePort } from "../../core/app-service-ports";
import { t } from "../../i18n";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import type { InstrumentRef } from "../../market-data/request-types";
import { buildQuoteKey, resolveEntryData } from "../../market-data/selectors";
import { useAppActive, useAppVisible } from "../../state/app/activity";
import { useAppDispatch, useAppGetState, useAppSelector } from "../../state/app/context";
import { scheduleConfigSave } from "../../state/config-save-scheduler";
import { useInlineTickerOpener } from "../../state/hooks/inline-tickers";
import { recordFunctionOpen, recordFunctionShown } from "../../telemetry/usage-counts";
import type { AppNotificationRequest } from "../../types/plugin";
import { logFailure } from "../../utils/log-failure";
import {
  MIN_AWAY_MS,
  observeQuote,
  recapSince,
  trackedListings,
  visitScope,
  type TrackedListing,
  type VisitMove,
  type VisitObservation,
  type VisitRecap,
} from "./model";
import { createVisitBaselineStore, VisitTracker } from "./visit-tracker";

/** How long the return waits for its quotes before it compares what it has. */
const COMPARE_WAIT_MS = 10_000;
/** Quotes ticking in batches are read once they settle, not on every tick. */
const SWEEP_DELAY_MS = 2_000;

/**
 * Usage counts, by the strip's own names: never which tickers. Showing is not
 * the user opening anything, so it counts as on screen at launch (`restored`);
 * opening a move and turning the strip off are opens.
 */
const SHOWN_FUNCTION = "LASTVISIT";
const OPENED_FUNCTION = "LASTVISIT-OPEN";
const OFF_FUNCTION = "LASTVISIT-OFF";

const SINCE_LAST_VISIT_OFF_MESSAGE = "Since Last Visit is off. Turn it on again from the command bar: Since Last Visit.";

/** Who is signed in, as the visit is kept for: the API client unless a test says otherwise. */
export interface VisitAccountSource {
  subscribe(listener: () => void): () => void;
  currentId(): string | null;
}

const apiAccount: VisitAccountSource = {
  subscribe: (listener) => apiClient.subscribeCurrentUser(listener),
  currentId: () => apiClient.getCurrentUser()?.id ?? null,
};

export interface SinceLastVisitMove {
  move: VisitMove;
  instrument: InstrumentRef;
}

export interface SinceLastVisit {
  /** The last visit and what moved since, while the strip has something to show; null otherwise. */
  recap: { seenAt: number; moves: SinceLastVisitMove[] } | null;
  /** Hides the strip for this session. */
  hide(): void;
  /** Turns the strip off on this machine, with a toast that can undo it. */
  turnOff(): void;
  /** Opens a moved ticker's research. */
  open(move: VisitMove): void;
  /** The strip is on screen: counted once per session. */
  noteShown(): void;
}

interface UseSinceLastVisitOptions {
  /** This window shows the strip: the main window, with no setup or sign-in in front of the workspace. */
  active: boolean;
  marketData: Pick<MarketDataCoordinator, "getQuoteEntry" | "loadQuotesBatch" | "subscribeKeys">;
  pluginState: Pick<AppPluginStateStorePort, "get" | "set" | "delete" | "keys">;
  /** Settles once every plugin has registered: the signed-in account is known by then. */
  pluginsReady?: Promise<unknown>;
  notify(request: AppNotificationRequest): void;
  account?: VisitAccountSource;
}

function usePromiseSettled(promise: Promise<unknown> | undefined): boolean {
  const [settled, setSettled] = useState(!promise);
  useEffect(() => {
    if (!promise) {
      setSettled(true);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setSettled(true);
    };
    promise.then(done, done);
    return () => {
      live = false;
    };
  }, [promise]);
  return settled;
}

function currentObservations(
  listings: readonly TrackedListing[],
  marketData: Pick<MarketDataCoordinator, "getQuoteEntry">,
  now: number,
): Map<string, VisitObservation> {
  const current = new Map<string, VisitObservation>();
  for (const listing of listings) {
    const observation = observeQuote(listing.symbol, resolveEntryData(marketData.getQuoteEntry(listing.instrument)), now);
    if (observation) current.set(listing.key, observation);
  }
  return current;
}

/**
 * The returning-user strip's session: which account's last visit to read,
 * the one comparison of each account's return with it, and the prices this
 * visit keeps for the next one. See `./model.ts` for what counts as a move
 * and `./visit-tracker.ts` for when the visit is written.
 */
export function useSinceLastVisit({
  active,
  marketData,
  pluginState,
  pluginsReady,
  notify,
  account = apiAccount,
}: UseSinceLastVisitOptions): SinceLastVisit {
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const enabled = useAppSelector((state) => state.config.sinceLastVisit !== false);
  const initialized = useAppSelector((state) => state.initialized);
  const portfolios = useAppSelector((state) => state.config.portfolios);
  const watchlists = useAppSelector((state) => state.config.watchlists);
  const tickers = useAppSelector((state) => state.tickers);
  const allTracked = useMemo(() => trackedListings({ portfolios, watchlists }, tickers), [portfolios, tickers, watchlists]);
  const trackedKey = allTracked.map((listing) => listing.key).join("\n");
  // A ticker refresh replaces the map without changing which listings are tracked.
  const tracked = useMemo(() => allTracked, [trackedKey]);
  const trackedRef = useRef(tracked);
  trackedRef.current = tracked;

  const pluginsSettled = usePromiseSettled(pluginsReady);
  const scope = useSyncExternalStore(account.subscribe, () => visitScope(account.currentId()), () => visitScope(account.currentId()));
  const visible = useAppVisible();
  const focused = useAppActive();
  // In the app and looking at it: a hidden window, or a terminal in the
  // background, keeps ticking prices nobody saw.
  const present = visible && focused;
  const running = enabled && active && initialized && pluginsSettled;

  const store = useMemo(() => createVisitBaselineStore(pluginState), [pluginState]);
  const tracker = useMemo(() => new VisitTracker(store), [store]);
  useEffect(() => () => tracker.stop(), [tracker]);

  /** Each account's return is compared once per session; a re-enable or a flip back reuses it. */
  const compared = useRef(new Map<string, VisitRecap | null>());
  const [shown, setShown] = useState<{ scope: string; recap: VisitRecap } | null>(null);
  const [hidden, setHidden] = useState(false);
  const countedShown = useRef(false);

  // Off forgets every stored visit; on again starts a new one.
  useEffect(() => {
    if (!enabled) tracker.forget();
  }, [enabled, tracker]);

  useEffect(() => {
    tracker.setPresent(running && present);
  }, [present, running, tracker]);

  // The return: the last visit read once for this account, compared with the
  // quotes this session loads for it, before this visit may be written over it.
  useEffect(() => {
    if (!running) return;
    const baseline = tracker.begin(scope);
    if (compared.current.has(scope)) {
      tracker.allowSaving();
      return;
    }
    const listings = trackedRef.current;
    const due = !!baseline && Date.now() - baseline.seenAt >= MIN_AWAY_MS
      && listings.some((listing) => !!baseline.observations[listing.key]);
    if (!due) {
      compared.current.set(scope, null);
      tracker.allowSaving();
      return;
    }
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const now = Date.now();
      const recap = recapSince(baseline, trackedRef.current, currentObservations(trackedRef.current, marketData, now), now);
      compared.current.set(scope, recap);
      if (recap) setShown({ scope, recap });
      tracker.allowSaving();
    };
    const timer = setTimeout(settle, COMPARE_WAIT_MS);
    marketData.loadQuotesBatch(listings.map((listing) => listing.instrument)).then(settle, (error: unknown) => {
      logFailure("since-last-visit", "Loading the return's quotes failed")(error);
      settle();
    });
    return () => {
      // A result that lands after this (another account, turned off, gone) is not this return's.
      if (done) return;
      done = true;
      clearTimeout(timer);
    };
  }, [marketData, running, scope, tracker]);

  // This visit's prices: whatever quotes the app has for the tracked listings,
  // read when they change while the user is in the app.
  useEffect(() => {
    if (!running) return;
    tracker.begin(scope);
    tracker.retain(new Set(tracked.map((listing) => listing.key)));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sweep = () => {
      timer = null;
      for (const [key, observation] of currentObservations(tracked, marketData, Date.now())) tracker.observe(key, observation);
    };
    sweep();
    const unsubscribe = marketData.subscribeKeys(tracked.map((listing) => buildQuoteKey(listing.instrument)), () => {
      timer ??= setTimeout(sweep, SWEEP_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer == null) return;
      clearTimeout(timer);
      sweep();
    };
  }, [marketData, present, running, scope, tracked, tracker]);

  const recap = useMemo(() => {
    // Not over setup or the sign-in gate, which can open in front of a strip already shown.
    if (!enabled || !active || hidden || !shown || shown.scope !== scope) return null;
    const instruments = new Map(tracked.map((listing) => [listing.key, listing.instrument] as const));
    // A ticker taken out of the collections leaves the strip with it.
    const moves = shown.recap.moves.flatMap((move) => {
      const instrument = instruments.get(move.key);
      return instrument ? [{ move, instrument }] : [];
    });
    return moves.length > 0 ? { seenAt: shown.recap.seenAt, moves } : null;
  }, [active, enabled, hidden, scope, shown, tracked]);

  const setEnabled = useCallback((on: boolean) => {
    const current = getState().config;
    if ((current.sinceLastVisit !== false) === on) return;
    const { sinceLastVisit: _previous, ...rest } = current;
    dispatch({ type: "SET_CONFIG", config: on ? rest : { ...rest, sinceLastVisit: false } });
    // Assembled when the write fires, recent tickers included, as the app's own saves are.
    scheduleConfigSave(() => {
      const state = getState();
      return { ...state.config, recentTickers: state.recentTickers };
    });
  }, [dispatch, getState]);

  const hide = useCallback(() => {
    setHidden(true);
    // Seen: a restart now compares with this visit, not the one before.
    tracker.flush();
  }, [tracker]);

  const turnOff = useCallback(() => {
    setEnabled(false);
    recordFunctionOpen({ shortcut: OFF_FUNCTION, externalPluginId: null });
    notify({
      body: t(SINCE_LAST_VISIT_OFF_MESSAGE),
      type: "info",
      action: { label: t("Undo"), onClick: () => setEnabled(true) },
    });
  }, [notify, setEnabled]);

  const openTicker = useInlineTickerOpener();
  const open = useCallback((move: VisitMove) => {
    recordFunctionOpen({ shortcut: OPENED_FUNCTION, externalPluginId: null });
    openTicker(move.symbol);
  }, [openTicker]);

  const noteShown = useCallback(() => {
    if (countedShown.current) return;
    countedShown.current = true;
    recordFunctionShown({ shortcut: SHOWN_FUNCTION, externalPluginId: null });
  }, []);

  return useMemo(() => ({ recap, hide, turnOff, open, noteShown }), [hide, noteShown, open, recap, turnOff]);
}
