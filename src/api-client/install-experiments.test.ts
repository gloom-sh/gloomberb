import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InstallExperimentAnswer, InstallExperimentReport } from "./index";
import { assignFirstRunTickers, confirmFirstRunTickers, recordFirstRunTickersFinished, resetInstallExperimentsForTests } from "./install-experiments";
import { installUsageCounter, resetUsageCountsForTests } from "../telemetry/usage-counts";
import { allowTelemetryInTests } from "../test-support/telemetry-guard";

const INSTALL_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function install(enabled = true): void {
  // The desktop view's navigator: a DOM test earlier in the run leaves one that reports automation.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Gloom" } });
  installUsageCounter({
    surface: "desktop",
    os: "darwin 24.1 arm64",
    isEnabled: () => enabled,
    getInstallId: () => INSTALL_ID,
    send: async () => {},
  });
}

/** The API, answering assignments with `answer` and recording every report. */
function api(answer: InstallExperimentAnswer | Error) {
  const reports: InstallExperimentReport[] = [];
  const ask = async (report: InstallExperimentReport) => {
    reports.push(report);
    if (answer instanceof Error) throw answer;
    return report.event === "experiment_assign" ? answer : { accepted: true };
  };
  return { reports, ask };
}

// The arm is asked once a session, and the session is the test process.
beforeEach(() => resetInstallExperimentsForTests());

afterEach(() => {
  resetInstallExperimentsForTests();
  resetUsageCountsForTests();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
});

describe("first_run_tickers", () => {
  allowTelemetryInTests();

  test("asks for the arm under the install id once a session, and counts only the arm the first run confirms it went on with", async () => {
    install();
    const { reports, ask } = api({ accepted: true, variant: "tickers" });
    expect(await assignFirstRunTickers(ask)).toBe("tickers");
    expect(await assignFirstRunTickers(ask)).toBe("tickers");
    const fields = { installId: INSTALL_ID, surface: "desktop", appVersion: expect.any(String), os: "darwin 24.1 arm64", experiment: "first_run_tickers" };
    // The answer alone is not an exposure.
    expect(reports).toEqual([{ ...fields, event: "experiment_assign" }]);
    confirmFirstRunTickers("tickers", ask);
    confirmFirstRunTickers("tickers", ask);
    await Bun.sleep(0);
    expect(reports).toEqual([
      { ...fields, event: "experiment_assign" },
      { ...fields, event: "experiment_exposed", variant: "tickers" },
    ]);
  });

  test("anything but an answer in the experiment shows the control and is never counted, and usage counts off asks nothing", async () => {
    install();
    // An answer that comes after the deadline rejects, as a failure does.
    for (const answer of [{ accepted: false }, { accepted: true, variant: "other" }, new Error("Install experiment request timed out.")]) {
      const { reports, ask } = api(answer);
      // A fresh session each time: the answer is asked once a session.
      resetInstallExperimentsForTests();
      expect(await assignFirstRunTickers(ask)).toBeNull();
      // An arm the API did not give this session is never confirmed.
      confirmFirstRunTickers("control", ask);
      await Bun.sleep(0);
      expect(reports.map((report) => report.event)).toEqual(["experiment_assign"]);
    }

    install(false);
    resetInstallExperimentsForTests();
    const off = api({ accepted: true, variant: "tickers" });
    expect(await assignFirstRunTickers(off.ask)).toBeNull();
    recordFirstRunTickersFinished({ picked: 2, skipped: false }, off.ask);
    await Bun.sleep(0);
    expect(off.reports).toEqual([]);
  });

  test("the step's end is a count and whether it was skipped, never a ticker", async () => {
    install();
    const { reports, ask } = api({ accepted: true, variant: "tickers" });
    recordFirstRunTickersFinished({ picked: 2, skipped: false }, ask);
    recordFirstRunTickersFinished({ picked: 3, skipped: true }, ask);
    await Bun.sleep(0);
    const fields = { installId: INSTALL_ID, surface: "desktop", appVersion: expect.any(String), os: "darwin 24.1 arm64", experiment: "first_run_tickers" };
    expect(reports).toEqual([
      { ...fields, event: "onboarding_tickers_finished", picked: 2, skipped: false },
      // Skipped keeps nothing, whatever was ticked.
      { ...fields, event: "onboarding_tickers_finished", picked: 0, skipped: true },
    ]);
  });
});
