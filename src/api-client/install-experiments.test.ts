import { afterEach, describe, expect, test } from "bun:test";
import type { InstallExperimentAnswer, InstallExperimentReport } from "./index";
import { exposeFirstRunTickers, recordFirstRunTickersFinished, resetInstallExperimentsForTests } from "./install-experiments";
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

/** The API, answering exposures with `answer` and recording every report. */
function api(answer: InstallExperimentAnswer | Error) {
  const reports: InstallExperimentReport[] = [];
  const ask = async (report: InstallExperimentReport) => {
    reports.push(report);
    if (answer instanceof Error) throw answer;
    return report.event === "experiment_exposed" ? answer : { accepted: true };
  };
  return { reports, ask };
}

afterEach(() => {
  resetUsageCountsForTests();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
});

describe("first_run_tickers", () => {
  allowTelemetryInTests();

  test("asks for the arm under the install id once a session, and shows the arm the API gives", async () => {
    install();
    const { reports, ask } = api({ accepted: true, variant: "tickers" });
    expect(await exposeFirstRunTickers(ask)).toBe("tickers");
    expect(await exposeFirstRunTickers(ask)).toBe("tickers");
    expect(reports).toEqual([{
      installId: INSTALL_ID,
      surface: "desktop",
      appVersion: expect.any(String),
      os: "darwin 24.1 arm64",
      experiment: "first_run_tickers",
      event: "experiment_exposed",
    }]);
  });

  test("anything but an answer in the experiment shows the control, and usage counts off asks nothing", async () => {
    install();
    for (const answer of [{ accepted: false }, { accepted: true, variant: "other" }, new Error("offline")]) {
      const { ask } = api(answer);
      // A fresh session each time: the answer is asked once a session.
      resetInstallExperimentsForTests();
      expect(await exposeFirstRunTickers(ask)).toBeNull();
    }

    install(false);
    resetInstallExperimentsForTests();
    const off = api({ accepted: true, variant: "tickers" });
    expect(await exposeFirstRunTickers(off.ask)).toBeNull();
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
