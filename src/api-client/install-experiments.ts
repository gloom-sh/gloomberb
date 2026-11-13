/**
 * A/B experiments on an app install: the terminal and the desktop app alike,
 * by the random install id their usage counts carry.
 *
 * The registry and the bucketing live with the Gloom Cloud API, as they do for
 * the web terminal's experiments (web-experiments.ts). The app asks for its
 * arm at the moment an experiment's change would show, in every arm, and that
 * request is the exposure: the API answers with the variant and counts the
 * install in it under `install:<id>`, the id its usage counts already go
 * under, so what the install does on later days reads against its arm.
 * Turning an experiment off there takes effect here without a release.
 *
 * It is covered by the Usage setting and sends nothing with it off, under
 * Do Not Track or Global Privacy Control, or in an automated browser: those
 * installs get the control and are not counted. A request that fails or
 * takes too long gets the control too, so the change never holds anything up.
 */
import { apiClient, type InstallExperimentAnswer, type InstallExperimentReport } from "./index";
import { VERSION } from "../version";
import { logFailure } from "../utils/log-failure";
import { usageInstall, type UsageInstall } from "../telemetry/usage-counts";
import { browserDoNotTrack } from "../telemetry/crash-reports-dom";

/** "Which tickers do you follow?" on the first run: `tickers` shows the step, `control` is today's first run. */
const FIRST_RUN_TICKERS_EXPERIMENT = "first_run_tickers";
export type FirstRunTickersArm = "control" | "tickers";
const FIRST_RUN_TICKERS_ARMS: readonly FirstRunTickersArm[] = ["control", "tickers"];
/** How long a change waits for its arm before it goes on as the control. */
const EXPOSE_TIMEOUT_MS = 1_500;

type Ask = (report: InstallExperimentReport, timeoutMs?: number) => Promise<InstallExperimentAnswer>;

/** Each experiment is asked once per session: an answer, or the control when there was none. */
const answers = new Map<string, Promise<string | null>>();

/** Do Not Track, Global Privacy Control and automated browsers; the Usage setting is the install's (usageInstall). */
function installExperimentsAllowed(): boolean {
  try {
    if (browserDoNotTrack()) return false;
    return typeof navigator === "undefined" || navigator.webdriver !== true;
  } catch {
    // Intentional ignore: an unreadable privacy signal sends nothing.
    return false;
  }
}

function report(install: UsageInstall, experiment: string): Pick<InstallExperimentReport, "installId" | "surface" | "appVersion" | "os" | "experiment"> {
  return {
    installId: install.installId,
    surface: install.surface,
    appVersion: VERSION,
    ...(install.os ? { os: install.os } : {}),
    experiment,
  };
}

/**
 * The arm of an install experiment to show, asked for when its change would
 * show and counted then; null shows the control and counts nothing. One of
 * `arms`, or null for an answer outside them.
 */
function exposeInstallExperiment<Arm extends string>(
  experiment: string,
  arms: readonly Arm[],
  ask: Ask = (body, timeoutMs) => apiClient.reportInstallExperiment(body, timeoutMs),
): Promise<Arm | null> {
  const asked = answers.get(experiment);
  if (asked) return asked as Promise<Arm | null>;
  const answer = (async (): Promise<Arm | null> => {
    if (!installExperimentsAllowed()) return null;
    const install = await usageInstall();
    if (!install) return null;
    try {
      const reply = await ask({ ...report(install, experiment), event: "experiment_exposed" }, EXPOSE_TIMEOUT_MS);
      const variant = reply.accepted ? reply.variant : undefined;
      return arms.find((arm) => arm === variant) ?? null;
    } catch (error) {
      logFailure("install-experiments", "Install experiment exposure failed")(error);
      return null;
    }
  })();
  answers.set(experiment, answer);
  return answer;
}

/** first_run_tickers' arm for this install, asked once the step would show. */
export function exposeFirstRunTickers(ask?: Ask): Promise<FirstRunTickersArm | null> {
  return exposeInstallExperiment(FIRST_RUN_TICKERS_EXPERIMENT, FIRST_RUN_TICKERS_ARMS, ask);
}

/**
 * "Which tickers do you follow?" closed: how many names it put on the
 * watchlist (0-3) and whether Skip closed it, never which. Never throws.
 */
export function recordFirstRunTickersFinished(
  { picked, skipped }: { picked: number; skipped: boolean },
  ask: Ask = (body, timeoutMs) => apiClient.reportInstallExperiment(body, timeoutMs),
): void {
  void (async () => {
    if (!installExperimentsAllowed()) return;
    const install = await usageInstall();
    if (!install) return;
    await ask({
      ...report(install, FIRST_RUN_TICKERS_EXPERIMENT),
      event: "onboarding_tickers_finished",
      picked: skipped ? 0 : Math.max(0, Math.min(3, Math.round(picked))),
      skipped,
    });
  })().catch(logFailure("install-experiments", "Recording the first-run tickers step failed"));
}

/** Test seam: forgets the arms asked for in this session. */
export function resetInstallExperimentsForTests(): void {
  answers.clear();
}
