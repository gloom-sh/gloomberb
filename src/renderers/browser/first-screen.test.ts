import { describe, expect, test } from "bun:test";
import { exposeExperiment, type ExperimentAnswer, type WebExperimentEnvironment } from "../../api-client/web-experiments";
import type { DesktopDeepLink } from "../../types/desktop-deeplink";
import { createBrowserResearchLayout } from "./config-host";
import {
  exposeFirstScreen,
  FIRST_SCREEN_EXPERIMENT,
  noteFirstScreenTicker,
  observeLandingLinks,
  watchFirstScreenEngagement,
} from "./first-screen";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const visit = { savedLayout: false, handoff: false };

describe("choosing the first screen", () => {
  test("a saved workspace or a shared link keeps today's screen without asking", async () => {
    let asked = 0;
    const expose = async () => {
      asked += 1;
      return "calm";
    };
    expect(await exposeFirstScreen({ ...visit, savedLayout: true, expose })).toBeNull();
    expect(await exposeFirstScreen({ ...visit, handoff: true, expose })).toBeNull();
    expect(asked).toBe(0);
  });

  test("opens the arm the API counted the visitor in", async () => {
    expect(await exposeFirstScreen({ ...visit, expose: async () => "calm" })).toBe("calm");
    expect(await exposeFirstScreen({ ...visit, expose: async () => "control" })).toBe("control");
  });

  test("shows the control and drops the request when the API is slow", async () => {
    let signal: AbortSignal | undefined;
    const started = performance.now();
    const screen = await exposeFirstScreen({
      ...visit,
      deadlineMs: 20,
      // An API that never answers, and a request that ignores the abort.
      expose: (next) => {
        signal = next;
        return new Promise<string | null>(() => {});
      },
    });
    expect(screen).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  // The real exposure, with each visitor the terminal never asks.
  function realExposure(
    answer: () => Promise<ExperimentAnswer>,
    overrides: Partial<WebExperimentEnvironment> = {},
  ) {
    const asked: string[] = [];
    const env: WebExperimentEnvironment = {
      anonymousId: "0f1e2d3c-4b5a-4968-8776-655443322110",
      signedIn: false,
      automated: false,
      local: memoryStorage(),
      session: memoryStorage(),
      ask: (request) => {
        asked.push(request.experiment);
        return answer();
      },
      ...overrides,
    };
    return { asked, expose: () => exposeExperiment(FIRST_SCREEN_EXPERIMENT, env) };
  }

  test("a failed request, or a visitor the API leaves out, gets the control and is not counted", async () => {
    for (const answer of [
      () => Promise.reject(new Error("offline")),
      async () => ({ accepted: false }),
    ]) {
      const { asked, expose } = realExposure(answer);
      expect(await exposeFirstScreen({ ...visit, expose })).toBeNull();
      expect(asked).toEqual([FIRST_SCREEN_EXPERIMENT]);
    }
  });

  test("never asks for signed-in, Do Not Track or Global Privacy Control, or automated browsers", async () => {
    for (const overrides of [
      { signedIn: true },
      // Do Not Track and Global Privacy Control leave the terminal without an id.
      { anonymousId: undefined },
      { automated: true },
    ] satisfies Partial<WebExperimentEnvironment>[]) {
      const { asked, expose } = realExposure(async () => ({ accepted: true, variant: "calm" }), overrides);
      expect(await exposeFirstScreen({ ...visit, expose })).toBeNull();
      expect(asked).toEqual([]);
    }
  });
});

describe("the first action", () => {
  function sources() {
    const opens = new Set<() => void>();
    const queries = new Set<(query: string) => void>();
    return {
      open: () => { for (const listener of opens) listener(); },
      type: (query: string) => { for (const listener of queries) listener(query); },
      sources: {
        subscribeFunctionOpens: (listener: () => void) => {
          opens.add(listener);
          return () => opens.delete(listener);
        },
        subscribeCommandBarQuery: (listener: (query: string) => void) => {
          queries.add(listener);
          return () => queries.delete(listener);
        },
      },
    };
  }

  function watch(counted: boolean, session = memoryStorage()) {
    const feed = sources();
    let recorded = 0;
    const stop = watchFirstScreenEngagement({
      counted,
      session,
      layout: createBrowserResearchLayout("7203:TSE"),
      record: () => { recorded += 1; },
      sources: feed.sources,
    });
    return { ...feed, session, stop, recorded: () => recorded };
  }

  test("is sent once, on the first function opened", () => {
    const first = watch(true);
    first.open();
    first.open();
    first.type("aapl");
    noteFirstScreenTicker("AAPL", "7203:TSE");
    expect(first.recorded()).toBe(1);
  });

  test("counts typing in the command bar, not opening it", () => {
    const first = watch(true);
    first.type("");
    first.type("  ");
    expect(first.recorded()).toBe(0);
    first.type("a");
    expect(first.recorded()).toBe(1);
    first.stop();
  });

  test("counts a new ticker, not moving focus between panes or a link's listing settling", () => {
    const first = watch(true);
    noteFirstScreenTicker(null, "7203:TSE");
    noteFirstScreenTicker("7203:TSE", null);
    noteFirstScreenTicker("7203:JPX", "7203:TSE");
    expect(first.recorded()).toBe(0);
    noteFirstScreenTicker("AAPL", "7203:JPX");
    expect(first.recorded()).toBe(1);
  });

  test("the address the terminal opened on is not the visitor's action", () => {
    const first = watch(true);
    let deliver: ((link: DesktopDeepLink) => void) | null = null;
    const bridge = observeLandingLinks({
      subscribe: (listener) => {
        deliver = listener;
        return () => {};
      },
    });
    bridge.subscribe(() => first.open());
    deliver!({ url: "gloomberb://ticker/AAPL?tab=overview" });
    expect(first.recorded()).toBe(0);
    first.open();
    expect(first.recorded()).toBe(1);
  });

  test("resumes after a reload in the first session, and never watches a visit that was not counted", () => {
    const session = memoryStorage();
    const first = watch(true, session);
    first.stop();
    const reloaded = watch(false, session);
    reloaded.open();
    expect(reloaded.recorded()).toBe(1);
    // Sent already: a later reload in the same session sends nothing.
    const again = watch(false, session);
    again.open();
    expect(again.recorded()).toBe(0);

    const notCounted = watch(false);
    notCounted.open();
    notCounted.type("aapl");
    noteFirstScreenTicker("AAPL", null);
    expect(notCounted.recorded()).toBe(0);
  });
});
