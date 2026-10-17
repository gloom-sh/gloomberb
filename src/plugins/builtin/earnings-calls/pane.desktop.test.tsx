/** @jsxImportSource react */
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport, type CloudEarningsCallPayload, type CloudEarningsTranscriptPayload } from "../../../api-client";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { UiHostProvider } from "../../../ui";
import { resetEarningsCallsPersistence } from "./data";
import { EarningsCallsPane } from "./pane";

const dom = createDomTestHarness({ withUi: false });
const runtime = createTestPluginRuntime();

const CALL: CloudEarningsCallPayload = {
  id: "ACME-call", ticker: "ACME", companyName: "ACME CORP", fiscalYear: 2026, fiscalQuarter: 2,
  callAt: "2026-08-01T20:00:00Z", status: "published", durationSeconds: 600,
  wordCount: 120, hasTranscript: true, sentiment: null,
};
const TRANSCRIPT: CloudEarningsTranscriptPayload = {
  ...CALL, timing: null, webcastUrl: null, fullText: "",
  turns: [
    { speaker: "Operator", text: "Welcome to the call.", paragraphs: ["Welcome to the call."], isQa: false, startSeconds: 5 },
    {
      speaker: "Jane Roe", role: "CFO", text: "Revenue grew this quarter. Margins held steady.",
      paragraphs: ["Revenue grew this quarter.", "Margins held steady."], paragraphStarts: [20, 95], isQa: false, startSeconds: 20,
    },
    { speaker: "Operator", text: "Our first question.", paragraphs: ["Our first question."], isQa: true, startSeconds: 300 },
  ],
  participants: [], summary: "Controlled summary.", guidance: null, riskFactors: null, notable: null,
  analystFocus: null, sentimentRationale: null, qaStartTurn: 2, asrModel: null, updatedAt: "2026-08-02",
};

function Harness() {
  const [paneState, setPaneState] = useState<AppState["paneState"]>({
    "calls:test": { pluginState: { research: { detailOpen: true, selectedId: CALL.id, readerTab: "transcript" } } },
  });
  const config = createTestPaneConfig("/tmp/gloom-calls-desktop-test/unused", {
    instanceId: "calls:test", paneId: "earnings-calls", binding: { kind: "none" },
  });
  const state = createInitialState(config);
  state.paneState = paneState;
  state.focusedPaneId = "calls:test";
  const dispatch = (action: AppAction) => setPaneState((current) => appReducer({ ...state, paneState: current }, action).paneState);
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <TestPaneFrame state={state} dispatch={dispatch} paneId="calls:test" pluginId="research" runtime={runtime} width={100} height={30} footerKeys>
          {(body) => <EarningsCallsPane focused {...body} />}
        </TestPaneFrame>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

/** The recording's answer: its address, nothing (404), or a refusal or failure by status. */
function serve(audio: "recording" | "none" | number, { expiresIn = 3_600_000 }: { expiresIn?: number } = {}) {
  const requests = { audio: 0 };
  apiClient.setSessionToken("controlled-test-session");
  apiClient.restoreCachedUser({
    id: "controlled-user", name: "Test", email: "test@example.invalid", emailVerified: true, plan: "pro", effectivePlan: "pro",
  } as never);
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/audio")) {
      requests.audio += 1;
      if (audio === "none") return Response.json({ message: "No recording for this call." }, { status: 404 });
      if (typeof audio === "number") return Response.json({ message: "Controlled refusal." }, { status: audio });
      return Response.json({
        kind: "recording", url: "https://media.example.invalid/calls/ACME-call.mp3?signature=controlled",
        expiresAt: new Date(Date.now() + expiresIn).toISOString(), durationSeconds: 600,
      });
    }
    if (path.includes("/transcripts/")) return Response.json(TRANSCRIPT);
    return Response.json({ calls: [CALL] });
  });
  return requests;
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await act(async () => { await Bun.sleep(5); });
}

afterEach(() => {
  setSystemTime();
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  resetEarningsCallsPersistence();
});

test("a clicked paragraph plays from its start, and the one heard is marked as playback moves", async () => {
  serve("recording");
  const container = await dom.render(<Harness />);
  await until(() => !!container.querySelector("[data-gloom-role='audio-player'] audio"));
  const audio = container.querySelector("audio") as HTMLAudioElement;
  expect(audio.getAttribute("src") ?? audio.src).toContain("ACME-call.mp3");
  const lines = () => [...container.querySelectorAll("[data-gloom-role='playback-line']")];
  const margins = lines().find((line) => line.textContent?.includes("Margins held steady"))!;

  await act(async () => { margins.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); });
  expect(audio.currentTime).toBe(95);
  await until(() => margins.getAttribute("data-current") === "true");
  expect(lines().filter((line) => line.getAttribute("data-current") === "true")).toEqual([margins]);

  // Playback moving on marks the paragraph it reaches, from the server's
  // paragraph starts; the hold music before the first one marks nothing.
  const heard = async (seconds: number) => {
    await act(async () => {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event("timeupdate"));
    });
  };
  await heard(30);
  expect(container.querySelector("[data-current='true']")?.textContent).toContain("Revenue grew this quarter");
  await heard(2);
  expect(container.querySelector("[data-current='true']")).toBeNull();

  // The arrows seek ten seconds from where playback is.
  await heard(40);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(audio.currentTime).toBe(50);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  expect(audio.currentTime).toBe(40);
});

test("a call without a recording reads as before: no player and no playable lines", async () => {
  serve("none");
  const container = await dom.render(<Harness />);
  await until(() => container.textContent?.includes("Margins held steady") === true);
  // Long enough for the recording's request to have been answered.
  await act(async () => { await Bun.sleep(30); });
  expect(container.querySelector("[data-gloom-role='audio-player']")).toBeNull();
  expect(container.querySelector("[data-gloom-role='playback-line']")).toBeNull();
  expect(container.textContent).not.toContain("audio unavailable");
});

for (const status of [401, 402, 403]) {
  test(`a ${status} from the recording's address is no player and no notice, like a call without one`, async () => {
    const requests = serve(status);
    const container = await dom.render(<Harness />);
    await until(() => container.textContent?.includes("Margins held steady") === true);
    await until(() => requests.audio > 0);
    await act(async () => { await Bun.sleep(30); });
    expect(container.querySelector("[data-gloom-role='audio-player']")).toBeNull();
    expect(container.textContent).not.toContain("audio unavailable");
  });
}

test("a failing server is told: no player and an audio unavailable notice", async () => {
  const requests = serve(503);
  const container = await dom.render(<Harness />);
  await until(() => container.textContent?.includes("Margins held steady") === true);
  await until(() => container.textContent?.includes("audio unavailable") === true);
  expect(requests.audio).toBe(1);
  expect(container.querySelector("[data-gloom-role='audio-player']")).toBeNull();
});

test("a recording that keeps failing is asked for at most twice more, 30 seconds apart, and then reported", async () => {
  // Every address comes back already run out, as from a server whose clock is
  // ahead, so each failure looks like an expiry: the case that looped.
  const requests = serve("recording", { expiresIn: -5_000 });
  const container = await dom.render(<Harness />);
  await until(() => !!container.querySelector("[data-gloom-role='audio-player'] audio"));
  const audio = container.querySelector("audio") as HTMLAudioElement;
  const fail = () => act(async () => {
    audio.dispatchEvent(new Event("error"));
    await Bun.sleep(30);
  });
  expect(requests.audio).toBe(1);

  await fail();
  await until(() => requests.audio === 2);
  expect(container.textContent).not.toContain("audio unavailable");

  // Inside 30 seconds of the last one: reported, not asked for again.
  await fail();
  expect(requests.audio).toBe(2);
  await until(() => container.textContent?.includes("audio unavailable") === true);

  setSystemTime(new Date(Date.now() + 31_000));
  await fail();
  await until(() => requests.audio === 3);

  // Two renewals is all a call gets, however long it has been.
  setSystemTime(new Date(Date.now() + 31_000));
  await fail();
  expect(requests.audio).toBe(3);
  await until(() => container.textContent?.includes("audio unavailable") === true);
});

test("the find marks every match and Enter steps through them, leaving the transcript whole", async () => {
  serve("none");
  const container = await dom.render(<Harness />);
  await until(() => container.textContent?.includes("Margins held steady") === true);
  const input = container.querySelector("input") as HTMLInputElement;
  // One letter would mark thousands of spans: it marks nothing and counts nothing.
  await act(async () => {
    input.focus();
    input.value = "q";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Bun.sleep(120);
  });
  expect(container.textContent).not.toContain("no matches");
  expect(container.textContent).not.toContain("match 1 of");
  await act(async () => {
    input.value = "qu";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Bun.sleep(120);
  });
  // "quarter" and "question", in two turns.
  await until(() => container.textContent?.includes("match 1 of 2") === true);
  // The terminal narrows to the matching turns; here the transcript stays whole.
  expect(container.textContent).toContain("Welcome to the call.");
  expect(container.textContent).toContain("Margins held steady.");

  const enter = (shiftKey = false) => act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }));
  });
  await enter();
  expect(container.textContent).toContain("match 2 of 2");
  await enter();
  expect(container.textContent).toContain("match 1 of 2");
  await enter(true);
  expect(container.textContent).toContain("match 2 of 2");
  // The field keeps the keyboard for the next step.
  expect(document.activeElement).toBe(input);
});
