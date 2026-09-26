import { useEffect, useRef } from "react";
import { resolveInstrumentForPane } from "../../core/state/app/instrument";
import type { InstrumentRef } from "../../market-data/request-types";
import { instrumentIdentityKey } from "../../utils/instrument-identity";
import { getDockedPaneIds } from "../../plugins/pane-manager/dock-tree";
import type { AppConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { recordPerfSample } from "../../utils/perf-marks";

/** Enough to cover a couple of saved workspaces without turning startup into a crawl. */
const MAX_WARM_INSTRUMENTS = 12;
/** Spread requests so a layout switch is warm without a burst at startup. */
const WARM_INTERVAL_MS = 150;
const QUIET_SAMPLE_MS = 200;
const QUIET_LAG_MS = 4;
const QUIET_SAMPLES_REQUIRED = 3;
const QUIET_MAX_WAIT_MS = 8_000;

/**
 * The instruments a saved layout would show if switched to, in the order its
 * panes appear, resolved the same way the live layout resolves them.
 */
export function collectSavedLayoutInstruments(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  limit = MAX_WARM_INSTRUMENTS,
): InstrumentRef[] {
  const seen = new Set<string>();
  const instruments: InstrumentRef[] = [];
  config.layouts.forEach((saved, index) => {
    if (index === config.activeLayoutIndex) return;
    const state = { config: { ...config, layout: saved.layout }, paneState: saved.paneState ?? {}, tickers };
    const paneIds = [...getDockedPaneIds(saved.layout), ...saved.layout.floating.map((entry) => entry.instanceId)];
    for (const paneId of paneIds) {
      if (instruments.length >= limit) return;
      const instrument = resolveInstrumentForPane(state, paneId);
      if (!instrument) continue;
      const key = instrumentIdentityKey(instrument);
      if (seen.has(key)) continue;
      seen.add(key);
      instruments.push(instrument);
    }
  });
  return instruments;
}

/** Resolves once the event loop has been responsive for a few samples, or after the cap. */
function whenMainThreadQuiet(signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let quietSamples = 0;
    const sample = () => {
      if (signal.cancelled) return;
      const before = performance.now();
      setTimeout(() => {
        if (signal.cancelled) return;
        const lag = performance.now() - before - QUIET_SAMPLE_MS;
        quietSamples = lag < QUIET_LAG_MS ? quietSamples + 1 : 0;
        if (quietSamples >= QUIET_SAMPLES_REQUIRED || performance.now() - startedAt >= QUIET_MAX_WAIT_MS) {
          resolve();
          return;
        }
        sample();
      }, QUIET_SAMPLE_MS);
    };
    sample();
  });
}

/**
 * After startup settles, warms the snapshot and baseline chart of the
 * instruments the other saved layouts would show, so switching layouts lands
 * on cached data. Runs once per process, only while the app is active, and
 * waits for a quiet main thread first so it never competes with the first
 * paint or the user's first keystrokes.
 */
export function useSavedLayoutWarmup({
  appActive,
  config,
  initialized,
  prefetch,
  tickers,
}: {
  appActive: boolean;
  config: AppConfig;
  initialized: boolean;
  prefetch: (instrument: InstrumentRef) => void;
  tickers: Map<string, TickerRecord>;
}): void {
  const started = useRef(false);
  const latest = useRef({ appActive, config, prefetch, tickers });
  latest.current = { appActive, config, prefetch, tickers };

  useEffect(() => {
    if (!initialized || !appActive || started.current) return;
    started.current = true;
    const signal = { cancelled: false };
    const startedAt = performance.now();
    void (async () => {
      await whenMainThreadQuiet(signal);
      if (signal.cancelled) return;
      // Waiting for a quiet main thread is the point of this effect, so the
      // sample measures the work only. Reporting the wait as elapsed time
      // filed a multi-second entry in the perf log on every launch and buried
      // the sections that really did hold the thread.
      const collectStartedAt = performance.now();
      const { config: currentConfig, tickers: currentTickers } = latest.current;
      const instruments = collectSavedLayoutInstruments(currentConfig, currentTickers);
      recordPerfSample("startup.saved-layout-warmup", performance.now() - collectStartedAt, {
        count: instruments.length,
        waitedMs: Math.round(collectStartedAt - startedAt),
        symbols: instruments.map((instrument) => instrument.symbol),
      });
      for (const instrument of instruments) {
        if (signal.cancelled || !latest.current.appActive) return;
        latest.current.prefetch(instrument);
        await new Promise((resolve) => setTimeout(resolve, WARM_INTERVAL_MS));
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [appActive, initialized]);
}
