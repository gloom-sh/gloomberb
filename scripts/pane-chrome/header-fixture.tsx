/** @jsxImportSource react */
/**
 * The `header` scenario for the header checks (header-checks.ts): the app's top
 * bar over an empty workspace, as the desktop app draws it on macOS
 * (`platform=darwin`, the default), Windows (`platform=win32`, with caption
 * buttons) and Linux, or as the web app does (`host=browser`); `font=20`
 * sets the largest text size the settings offer. SPY is
 * pre-market and the page's clock reads 04:00 in New York, so the market
 * summary takes its widest form ("PRE-MKT · 5h 30m"). The checks put the
 * header in each update state and window mode from the page
 * (`__paneChrome.header`) and count what Help and Restart were pressed for.
 * Nothing is fetched: SPY comes from an invented source.
 */
import { useLayoutEffect } from "react";
import { Header } from "../../src/components/layout/header";
import { setWindowFullscreen } from "../../src/components/layout/window-fullscreen";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../src/market-data/coordinator";
import { useAppDispatch } from "../../src/state/app/context";
import { createTestDataProvider, createTestQuote } from "../../src/test-support/data-provider";
import { Box } from "../../src/ui";
import type { ReleaseInfo, UpdateProgress } from "../../src/updater";

/** 04:00 in New York on a summer weekday: pre-market, five and a half hours before the open. */
const HEADER_CLOCK = Date.parse("2026-07-08T08:00:00Z");

const RELEASE: ReleaseInfo = {
  version: "0.17.2",
  tagName: "v0.17.2",
  downloadUrl: "",
  publishedAt: "2026-07-07T00:00:00Z",
  updateAction: { kind: "desktop" },
};

interface HeaderUpdateState {
  updateAvailable?: ReleaseInfo;
  updateProgress?: UpdateProgress;
  updateCheckInProgress?: boolean;
  updateNotice?: string;
}

/** Every state the header's update slot can be in, by the name the checks give it. */
export const HEADER_UPDATE_STATES: Record<string, HeaderUpdateState> = {
  none: {},
  checking: { updateCheckInProgress: true },
  available: { updateAvailable: RELEASE },
  "available through a package manager": { updateAvailable: { ...RELEASE, updateAction: { kind: "managed", reason: "nix store" } } },
  downloading: { updateAvailable: RELEASE, updateProgress: { phase: "downloading", percent: 42 } },
  installing: { updateAvailable: RELEASE, updateProgress: { phase: "replacing" } },
  ready: { updateAvailable: RELEASE, updateProgress: { phase: "ready", canRestart: true } },
  // The reason in a few words; the whole error stays in the command bar.
  failed: {
    updateAvailable: RELEASE,
    updateProgress: {
      phase: "error",
      error: "Desktop update did not finish downloading.",
      failure: { phase: "download", code: "interrupted" },
    },
  },
  // An error from a desktop process older than the reasons: the error itself, cut to its room.
  "failed without a reason": {
    updateAvailable: RELEASE,
    updateProgress: { phase: "error", error: "the download stopped at 61% (connection reset by peer)" },
  },
  notice: { updateNotice: "Update check failed: no connection" },
};

export interface HeaderFixtureHandle {
  /** Puts the update slot in one of HEADER_UPDATE_STATES. */
  show(state: string): void;
  fullscreen(on: boolean): void;
  /** Opens or closes the command bar, whose input the prompt then hosts. */
  commandBar(open: boolean): void;
  helpOpens: number;
  restarts: number;
}

/**
 * The OS the page says it runs on, as the desktop window reports it: the bar
 * keeps the traffic lights' columns free from what the navigator says.
 */
export function installHeaderPlatform(platform: string): void {
  const [name, agent] = platform === "win32" ? ["Win32", "Windows NT 10.0; Win64; x64"]
    : platform === "darwin" ? ["MacIntel", "Macintosh; Intel Mac OS X 10_15_7"]
    : ["Linux x86_64", "X11; Linux x86_64"];
  // WebKit under test says it is a Mac whatever it runs on, in its user agent too.
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => name });
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => `Mozilla/5.0 (${agent})` });
  Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => undefined });
}

/** Runs the page's clock from HEADER_CLOCK (still ticking), so the countdown always reads the same. */
export function installHeaderClock(): void {
  const offset = HEADER_CLOCK - Date.now();
  window.Date = new Proxy(Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [target.now() + offset], newTarget),
    get: (target, key) => (key === "now" ? () => target.now() + offset : Reflect.get(target, key)),
  });
}

/** SPY pre-market, from a source that answers at once. */
export function installHeaderMarketData(): void {
  const spy = createTestQuote({
    symbol: "SPY",
    price: 690.84,
    change: 4.21,
    changePercent: 0.61,
    marketState: "PRE",
    preMarketPrice: 687.18,
    preMarketChange: -3.66,
    preMarketChangePercent: -0.53,
    lastUpdated: HEADER_CLOCK,
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    id: "header-fixture",
    name: "Header fixture",
    getQuote: async () => spy,
  })));
}

/** The top bar over an empty workspace; `handle` is where the checks drive it from. */
export function HeaderFixture({ handle }: { handle: HeaderFixtureHandle }) {
  const dispatch = useAppDispatch();
  useLayoutEffect(() => {
    handle.show = (name) => {
      const state = HEADER_UPDATE_STATES[name];
      if (!state) throw new Error(`no header update state "${name}"`);
      dispatch({ type: "SET_UPDATE_PROGRESS", progress: null });
      dispatch({ type: "SET_UPDATE_AVAILABLE", release: state.updateAvailable ?? null });
      dispatch({ type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: state.updateCheckInProgress ?? false });
      dispatch({ type: "SET_UPDATE_PROGRESS", progress: state.updateProgress ?? null });
      dispatch({ type: "SET_UPDATE_NOTICE", notice: state.updateNotice ?? null });
    };
    handle.fullscreen = setWindowFullscreen;
    handle.commandBar = (open) => dispatch({ type: "SET_COMMAND_BAR", open, query: "" });
  }, [dispatch, handle]);
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header
        onOpenHelp={() => { handle.helpOpens += 1; }}
        onRestartForUpdate={() => { handle.restarts += 1; }}
      />
      <Box flexGrow={1} />
    </Box>
  );
}
