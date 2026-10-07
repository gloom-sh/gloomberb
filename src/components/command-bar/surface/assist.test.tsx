import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type { AppAction, AppContextStoreValue } from "../../../state/app/context";
import { runAutomated } from "../../../telemetry/usage-counts";
import { VERSION } from "../../../version";
import { CommandBarHarness, createCommandBarTestControls, settleFrame } from "./test-harness";

const tui = createOpenTuiTestHarness();
const originalWebSocket = globalThis.WebSocket;
/** The environment switches that turn every report off; a developer's shell may set one. */
const OPT_OUT_ENV = ["GLOOMBERB_NO_TELEMETRY", "DO_NOT_TRACK"] as const;
const originalOptOutEnv = OPT_OUT_ENV.map((name) => process.env[name]);

beforeEach(() => {
  for (const name of OPT_OUT_ENV) delete process.env[name];
  apiClient.dispose();
  // The header subscribes to SPY. A real socket rejects this test's fake token
  // and can mark the account unverified before the assist debounce completes.
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
    readyState = 0;
    close() { this.readyState = 3; }
  } as unknown as typeof WebSocket;
});

afterEach(async () => {
  // A report the bar sends as it closes lands in the test that closed it.
  await Bun.sleep(5);
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  apiClient.dispose();
  globalThis.WebSocket = originalWebSocket;
  OPT_OUT_ENV.forEach((name, index) => {
    const value = originalOptOutEnv[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

const { waitForFrameToContain } = createCommandBarTestControls(() => tui.setup());

function signInVerified(emailVerified = true): void {
  apiClient.setSessionToken("assist-test-token");
  apiClient.restoreCachedUser({
    id: "user-1",
    name: "Tester",
    email: "tester@example.com",
    username: "tester",
    emailVerified,
    plan: "free",
  } as never);
}

/** Types into whichever input has focus, one key at a time, then renders. */
async function typeKeys(keys: string[]): Promise<void> {
  await act(async () => {
    for (const key of keys) tui.setup().mockInput.pressKey(key);
    await tui.setup().renderOnce();
  });
}

/**
 * Answers `/assist/command` locally and returns the asks that were made, and
 * collects search reports into `reports`. Other cloud calls are refused:
 * ambient client traffic (a session refresh) must never be mistaken for the
 * bar asking a question.
 */
function mockAssistTransport(
  respond: (body: unknown) => Response | Promise<Response>,
  reports: unknown[] = [],
): string[] {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/assist/searches")) {
      reports.push(body);
      return new Response(null, { status: 204 });
    }
    if (!url.endsWith("/assist/command")) {
      throw new Error(`unexpected cloud request: ${url}`);
    }
    requests.push(url);
    return await respond(body);
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records pane creations and registers "ERN", an argless pane shortcut. */
function configureEarningsRegistry(
  created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }>,
) {
  return (pluginRegistry: PluginRegistry) => {
    pluginRegistry.paneTemplates.set("earnings-calendar-pane", {
      id: "earnings-calendar-pane",
      paneId: "portfolio-list",
      label: "Earnings Calendar",
      description: "Upcoming earnings dates and estimates",
      shortcut: { prefix: "ERN" },
    } as never);
    (pluginRegistry as unknown as {
      createPaneFromTemplateAsync: (templateId: string, options?: PaneTemplateCreateOptions) => Promise<void>;
    }).createPaneFromTemplateAsync = async (templateId, options) => {
      created.push({ templateId, options });
    };
  };
}

/** Wide enough to cover the ask debounce plus the round trip. */
const ASSIST_WAIT_ATTEMPTS = 40;

async function waitForRequest(requests: unknown[], count = 1): Promise<void> {
  for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS; attempt++) {
    if (requests.length >= count) return;
    await settleFrame(tui.setup());
  }
  throw new Error("Timed out waiting for the assist request.");
}

async function waitForReports(reports: unknown[], count = 1): Promise<void> {
  for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS; attempt++) {
    if (reports.length >= count) return;
    await settleFrame(tui.setup());
  }
  throw new Error("Timed out waiting for the search report.");
}

async function waitForFrameWithout(text: string): Promise<string> {
  for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS; attempt++) {
    const frame = tui.frame();
    if (!frame.includes(text)) return frame;
    await settleFrame(tui.setup());
  }
  throw new Error(`Timed out waiting for "${text}" to disappear.`);
}

describe("CommandBar AI assist", () => {
  test("asks on its own, with no Enter, and leads the list with the answer", async () => {
    signInVerified();
    let sentCommandCount = 0;
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async (body) => {
      sentCommandCount = (body as { commands: unknown[] }).commands.length;
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      // Wide enough for the answer's label and its title to share one row.
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Thinking…");
    // Nobody pressed Enter; the debounce fires the one request by itself.
    await waitForRequest(requests);
    expect(requests).toHaveLength(1);
    expect(sentCommandCount).toBeGreaterThan(0);

    releaseResponse();
    const answered = await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(answered).not.toContain("Thinking…");
    expect(requests).toHaveLength(1);
    // Above the local matches, laid out like any other row with the prefix in
    // the badge column, and holding the selection an untouched query never
    // moved: plain Enter runs the AI's best guess.
    expect(answered.indexOf("Ask AI")).toBeLessThan(answered.indexOf("Panes"));
    expect(answered).toMatch(/CHAT\s+#general · Open the general channel/);

    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
  });

  test("keeps the row the user picked when an answer lands above it", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [
          { input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 },
          { input: "CHAT #random", title: "Open the random channel", prefix: "CHAT", confidence: 0.4 },
        ],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      // Wide enough for the answers' labels and titles to share one row.
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    await waitForRequest(requests);
    // Down lands on the local match while a single "Thinking…" row sits above.
    await tui.emitKeypress({ name: "down" });
    releaseResponse();
    await waitForFrameToContain("#random · Open the random channel", ASSIST_WAIT_ATTEMPTS);

    // Two answers replaced that one row, so the chosen row moved down by one;
    // Enter still runs it rather than whatever now sits at its old index.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: undefined }]);
  });

  test("runs an argless prefix candidate that still carries an argument", async () => {
    signInVerified();
    // Unclamped on purpose: "ERN" takes no argument, so the client has to fall
    // back to the bare prefix instead of dropping the text into the input.
    mockAssistTransport(() => jsonResponse({
      candidates: [{ input: "ERN NVDA", title: "Earnings Calendar for NVDA", prefix: "ERN", confidence: 0.8 }],
    }));
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="nvda earnings"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    await waitForFrameToContain("NVDA · Earnings Calendar", ASSIST_WAIT_ATTEMPTS);

    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "earnings-calendar-pane", options: undefined }]);
  });

  test("claims the answer still in flight when Enter lands on the thinking row", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const reports: unknown[] = [];
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
        searchId: "search-claimed",
      });
    }, reports);
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Thinking…");

    // Enter on "Thinking…" is a promise, not a dead key: there is nothing to
    // run yet, so the ask is claimed and its answer runs when it arrives.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([]);

    releaseResponse();
    for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS && created.length === 0; attempt++) {
      await settleFrame(tui.setup());
    }
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
    expect(requests).toHaveLength(1);
    // Enter on "Thinking…" picked nothing yet; the answer that ran is the pick.
    await waitForReports(reports);
    expect(reports).toEqual([expect.objectContaining({
      query: "new chat pane",
      searchId: "search-claimed",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "assist", input: "CHAT #general", rank: 0, fromAssist: true }),
    })]);
  });

  test("does not restart an ask when Enter repeats before loading renders", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });

    await tui.render(
      <CommandBarHarness query="new chat pane" />,
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Thinking…");

    await tui.emitKeypress([
      { name: "return", sequence: "\r" },
      { name: "return", sequence: "\r", repeated: true },
    ]);

    expect(requests).toHaveLength(1);
    releaseResponse();
    await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
  });

  test("asks once for a question retyped with other spacing, again when recased", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });
    const editQuery = async (keys: string[]) => {
      await act(async () => {
        for (const key of keys) tui.setup().mockInput.pressKey(key);
        await tui.setup().renderOnce();
      });
    };

    await tui.render(
      <CommandBarHarness query="new chat pane" />,
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    await waitForRequest(requests);

    // A second space while the ask is out: the answer lands on the text now in
    // the bar instead of leaving it thinking.
    await editQuery(["ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT", " "]);
    releaseResponse();
    let frame = await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(frame).toContain("new chat  pane");

    // Taking the space back out keeps the answer on screen.
    await editQuery(["BACKSPACE"]);
    frame = await waitForFrameToContain("new chat pane");
    expect(frame).toContain("#general · Open the general channel");

    expect(requests).toHaveLength(1);

    // Recased, it is a new question: casing can name a ticker ("ON").
    await editQuery(["DELETE", "P"]);
    await waitForFrameToContain("new chat Pane");
    await waitForRequest(requests, 2);
    expect(requests).toHaveLength(2);
  });

  test("drops the section when a background ask fails", async () => {
    signInVerified();
    const requests = mockAssistTransport(() => jsonResponse({ error: "assist-unavailable" }, 503));

    await tui.render(
      <CommandBarHarness query="show me the newest filings" />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Ask AI");

    const frame = await waitForFrameWithout("Ask AI");
    expect(requests).toHaveLength(1);
    expect(frame).not.toContain("unavailable");
  });

  test("sends signed-out users to sign up instead of the endpoint", async () => {
    const requests = mockAssistTransport(() => jsonResponse({ candidates: [] }));
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Ask AI — sign up to enable");

    await settleFrame(tui.setup(), 700);
    expect(requests).toEqual([]);

    // The offer sits under the list and never takes the Enter that belongs to
    // the local match the user was already looking at.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: undefined }]);
  });
});

describe("CommandBar search report", () => {
  const generalAnswer = {
    candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
  };

  /** Lets a deferred report, or one the bar should not have sent, reach the transport. */
  async function closeAndSettle(): Promise<void> {
    await tui.destroy();
    await Bun.sleep(20);
  }

  test("reports the AI candidate the user ran with the answer's search id, once per visit", async () => {
    signInVerified();
    const reports: unknown[] = [];
    const asks: unknown[] = [];
    mockAssistTransport((body) => {
      asks.push(body);
      return jsonResponse({ ...generalAnswer, searchId: "search-1" });
    }, reports);
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    // With the Usage setting on, the ask opts in to being kept.
    expect(asks).toEqual([expect.objectContaining({ query: "new chat pane", log: true })]);

    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
    await waitForReports(reports);
    expect(reports).toEqual([{
      query: "new chat pane",
      searchId: "search-1",
      outcome: "chosen",
      choice: {
        kind: "assist",
        label: "#general · Open the general channel",
        input: "CHAT #general",
        rank: 0,
        category: "Ask AI",
        fromAssist: true,
      },
      appVersion: VERSION,
    }]);

    // The bar stays open in this harness: running again, pressing Esc and
    // finally closing it add nothing to the one report.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await tui.emitKeypress({ name: "escape" });
    await closeAndSettle();
    expect(reports).toHaveLength(1);
  });

  test("reports a local row without a search id while the answer is still out", async () => {
    signInVerified();
    const reports: unknown[] = [];
    // Never answers: nothing on screen describes this query yet.
    const requests = mockAssistTransport(() => new Promise<Response>(() => {}), reports);

    await tui.render(<CommandBarHarness query="MSFT" />, { width: 120, height: 20 });

    await tui.setup().renderOnce();
    await waitForRequest(requests);
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForReports(reports);
    expect(reports).toEqual([{
      query: "MSFT",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "ticker", rank: 0, fromAssist: false }),
      appVersion: VERSION,
    }]);
  });

  test("tags only the typed shortcut's own row as a shortcut", async () => {
    signInVerified();
    const reports: Array<{ choice?: Record<string, unknown> }> = [];
    const requests = mockAssistTransport(() => jsonResponse(generalAnswer), reports);
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness query="ERN" configurePluginRegistry={configureEarningsRegistry(created)} />,
      { width: 100, height: 20 },
    );
    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForReports(reports);
    expect(reports).toEqual([{
      query: "ERN",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "shortcut", label: "Earnings Calendar", input: "ERN", rank: 0 }),
      appVersion: VERSION,
    }]);
    await closeAndSettle();

    // "DES MSFT" lists tickers; the one picked is a ticker row, not the text.
    reports.length = 0;
    await tui.render(<CommandBarHarness query="DES MSFT" />, { width: 100, height: 20 });
    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForReports(reports);
    expect(reports[0]?.choice).toMatchObject({ kind: "ticker", label: "MSFT", rank: 0 });
    expect(reports[0]?.choice).not.toHaveProperty("input");
    // A prefix the parser claims is never sent to the AI.
    expect(requests).toEqual([]);
  });

  test("reports a dismissal once when Esc closes the bar on an edited query", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse({ ...generalAnswer, searchId: "search-2" }), reports);

    await tui.render(<CommandBarHarness query="new chat pan" live />, { width: 120, height: 20 });

    await tui.setup().renderOnce();
    await typeKeys(["e"]);
    await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameToContain("Search or run a command");
    await waitForReports(reports);
    await settleFrame(tui.setup());
    expect(reports).toEqual([{
      query: "new chat pane",
      searchId: "search-2",
      outcome: "dismissed",
      appVersion: VERSION,
    }]);
  });

  test("points a dismissal at the answer the bar kept, even one with no command", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse({ candidates: [], searchId: "search-empty" }), reports);

    await tui.render(<CommandBarHarness query="new chat pan" live />, { width: 120, height: 20 });

    await tui.setup().renderOnce();
    await typeKeys(["e"]);
    // Enter on "Thinking…" asks now; the answer has nothing to run.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrameToContain("No command found", ASSIST_WAIT_ATTEMPTS);
    // The first Esc takes the answer off screen, the second closes the bar.
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameWithout("No command found");
    await tui.emitKeypress({ name: "escape" });
    await waitForReports(reports);
    expect(reports).toEqual([{
      query: "new chat pane",
      searchId: "search-empty",
      outcome: "dismissed",
      appVersion: VERSION,
    }]);
  });

  test("skips the dismissal while the query is still the text the bar opened with", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    // A menu opens the bar on "HELP"; closing it again is not a search.
    await tui.render(<CommandBarHarness query="HELP" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameToContain("Search or run a command");
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([]);
  });

  test("never reads Esc after a row ran as a dismissal, even from an empty query or a bound key", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);
    // Pane creation that never finishes keeps the bar open after the row ran.
    const hangPaneCreation = (pluginRegistry: PluginRegistry) => {
      configureEarningsRegistry([])(pluginRegistry);
      (pluginRegistry as unknown as { createPaneFromTemplateAsync: () => Promise<void> })
        .createPaneFromTemplateAsync = () => new Promise<void>(() => {});
    };

    await tui.render(
      <CommandBarHarness query="" live configurePluginRegistry={hangPaneCreation} />,
      { width: 100, height: 20 },
    );
    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await typeKeys(["a", "b", "c"]);
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameToContain("Search or run a command");
    await closeAndSettle();
    expect(reports).toEqual([]);

    // A key bound to "ERN" opens the bar and runs it.
    await tui.render(
      <CommandBarHarness
        query="ERN"
        live
        configurePluginRegistry={hangPaneCreation}
        configureState={(state) => ({
          ...state,
          commandBarLaunchRequest: { kind: "run-query", query: "ERN", sequence: 1 },
        })}
      />,
      { width: 100, height: 20 },
    );
    await tui.setup().renderOnce();
    await typeKeys(["x"]);
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameToContain("Search or run a command");
    await closeAndSettle();
    expect(reports).toEqual([]);
  });

  test("reports nothing for an empty query", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameToContain("Search or run a command");
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([]);
  });

  test("holds a row that opens a route until it finishes, and sends nothing typed inside it", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="DES" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    // Tab opens ticker search; the ticker is typed there, not in the root query.
    await tui.emitKeypress({ name: "tab" });
    await typeKeys(["M", "S", "F", "T"]);
    await waitForFrameToContain("NASDAQ MSFT");
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([]);

    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForReports(reports);
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([{
      query: "DES",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "shortcut", input: "DES", rank: 0 }),
      appVersion: VERSION,
    }]);
    expect(JSON.stringify(reports)).not.toContain("MSFT");
  });

  // Closed with no Enter (a click outside, the bar's key, an unmount), the bar
  // still sends the choice it held for the route a row opened.
  test("sends the held choice as it stands when the bar closes on an open route", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="DES" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "tab" });
    await typeKeys(["M", "S", "F", "T"]);
    await waitForFrameToContain("NASDAQ MSFT");
    await closeAndSettle();
    expect(reports).toEqual([{
      query: "DES",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "shortcut", input: "DES", rank: 0 }),
      appVersion: VERSION,
    }]);
    expect(JSON.stringify(reports)).not.toContain("MSFT");
  });

  // A form opens in the form modal and the bar closes behind it, so the row
  // that opened it ran; what is typed in the form is never part of the search.
  test("reports a row that opened a form as chosen, and nothing typed in the form", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="QQ" live />, { width: 100, height: 24 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "tab" });
    await waitForFrameToContain("Quote Tickers");
    await typeKeys(["N", "V", "D", "A"]);
    await waitForFrameToContain("NVDA");
    await tui.emitKeypress({ name: "escape" });
    await closeAndSettle();
    expect(reports).toEqual([{
      query: "QQ",
      outcome: "chosen",
      choice: expect.objectContaining({ kind: "shortcut", label: "Quote Monitor", input: "QQ", rank: 0 }),
      appVersion: VERSION,
    }]);
    expect(JSON.stringify(reports)).not.toContain("NVDA");
  });

  test("backing out of the route a row opened takes that choice back", async () => {
    signInVerified();
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="DES" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "tab" });
    await typeKeys(["M", "S", "F", "T"]);
    await waitForFrameToContain("NASDAQ MSFT");
    await tui.emitKeypress({ name: "escape" });
    await waitForFrameWithout("NASDAQ MSFT");
    await typeKeys(["BACKSPACE"]);
    await tui.emitKeypress({ name: "escape" });
    await waitForReports(reports);
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([{ query: "DE", outcome: "dismissed", appVersion: VERSION }]);
  });

  test("reports a theme picked at the root, not the row that only opened the picker", async () => {
    signInVerified(false);
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="Change Theme" live />, { width: 100, height: 24 });

    await tui.setup().renderOnce();
    // The row writes "TH " into the bar; the search goes on from there.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await typeKeys(["d", "r", "a", "c"]);
    await waitForFrameToContain("Dracula");
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForReports(reports);
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([{
      query: "TH drac",
      outcome: "chosen",
      choice: {
        kind: "shortcut",
        label: "Dracula",
        input: "TH drac",
        rank: 0,
        category: "Themes",
        fromAssist: false,
      },
      appVersion: VERSION,
    }]);
  });

  test("sends no report when the bar turns Usage Counts off", async () => {
    // Unverified, so no AI row leads and Enter runs the switch itself.
    signInVerified(false);
    const reports: unknown[] = [];
    const actions: AppAction[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(
      <CommandBarHarness query="Usage Counts" live onAction={(action) => actions.push(action)} />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrameToContain("Search or run a command");
    await closeAndSettle();
    expect(actions).toContainEqual(expect.objectContaining({
      type: "SET_CONFIG",
      config: expect.objectContaining({ telemetry: expect.objectContaining({ usage: false }) }),
    }));
    expect(reports).toEqual([]);
  });

  test("turning Usage Counts off drops a choice still held from earlier in the visit", async () => {
    signInVerified(false);
    const reports: unknown[] = [];
    const actions: AppAction[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);
    // Pane creation never finishes, so ERN's choice stays held and the bar stays open.
    const holdPaneCreation = (pluginRegistry: PluginRegistry) => {
      configureEarningsRegistry([])(pluginRegistry);
      (pluginRegistry as unknown as { createPaneFromTemplateAsync: () => Promise<void> })
        .createPaneFromTemplateAsync = () => new Promise<void>(() => {});
    };

    await tui.render(
      <CommandBarHarness query="ERN" live onAction={(action) => actions.push(action)} configurePluginRegistry={holdPaneCreation} />,
      { width: 100, height: 20 },
    );
    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await typeKeys(["BACKSPACE", "BACKSPACE", "BACKSPACE", ..."Usage Counts".split("")]);
    await waitForFrameToContain("Usage Counts");
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await closeAndSettle();

    expect(actions).toContainEqual(expect.objectContaining({
      type: "SET_CONFIG",
      config: expect.objectContaining({ telemetry: expect.objectContaining({ usage: false }) }),
    }));
    expect(reports).toEqual([]);
  });

  test("a menu refilling the open bar starts a new visit", async () => {
    signInVerified(false);
    const reports: unknown[] = [];
    mockAssistTransport(() => jsonResponse(generalAnswer), reports);
    const storeRef: { current: AppContextStoreValue | null } = { current: null };

    await tui.render(
      <CommandBarHarness query="" live storeRef={storeRef} />,
      { width: 100, height: 20 },
    );
    await tui.setup().renderOnce();
    await typeKeys(["n", "v"]);
    await act(async () => {
      storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "Reset All Data" });
      await tui.setup().renderOnce();
    });
    await settleFrame(tui.setup());
    await tui.emitKeypress({ name: "escape" });
    await closeAndSettle();

    expect(reports).toEqual([]);
  });

  test("with usage telemetry off, asks without log and reports nothing", async () => {
    signInVerified();
    const reports: unknown[] = [];
    const asks: unknown[] = [];
    mockAssistTransport((body) => {
      asks.push(body);
      return jsonResponse(generalAnswer);
    }, reports);
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(
      <CommandBarHarness
        query="new chat pane"
        configureConfig={(config) => ({ ...config, telemetry: { usage: false } })}
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 120, height: 20 },
    );

    await tui.setup().renderOnce();
    await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(asks).toEqual([expect.objectContaining({ query: "new chat pane" })]);
    expect(asks[0]).toMatchObject({ log: false });

    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
    await closeAndSettle();
    expect(reports).toEqual([]);
  });

  test("keeps nothing of a query remote control typed until the user edits it", async () => {
    signInVerified();
    const reports: unknown[] = [];
    const asks: Array<Record<string, unknown>> = [];
    mockAssistTransport((body) => {
      asks.push(body as Record<string, unknown>);
      return jsonResponse({ ...generalAnswer, searchId: "search-3" });
    }, reports);
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    // Remote control opens the bar on this text.
    await runAutomated(async () => {
      await tui.render(
        <CommandBarHarness query="new chat pane" configurePluginRegistry={configureEarningsRegistry(created)} />,
        { width: 120, height: 20 },
      );
      await tui.setup().renderOnce();
    });
    await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(asks[0]).toMatchObject({ log: false });

    // Running its answer is still not the user's search.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
    await settleFrame(tui.setup(), 50);
    expect(reports).toEqual([]);

    // Once the user edits it, the question is theirs.
    await typeKeys(["s"]);
    await waitForRequest(asks, 2);
    expect(asks[1]).toMatchObject({ query: "new chat panes", log: true });
  });

  test("sends nothing signed out", async () => {
    const reports: unknown[] = [];
    const requests = mockAssistTransport(() => jsonResponse(generalAnswer), reports);

    await tui.render(<CommandBarHarness query="DES MSFT" live />, { width: 100, height: 20 });

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await settleFrame(tui.setup(), 50);
    expect(requests).toEqual([]);
    expect(reports).toEqual([]);
  });
});
