import { beforeEach } from "bun:test";
import { resetInstallExperimentsForTests } from "../api-client/install-experiments";
import { resetSeenPaneNoticesForTest } from "../components/pane-notice-seen";
import { resetListingIndexForTests } from "../tickers/search/listing-index";
import { resetOpeningTickerPanesForTests } from "../state/opening-ticker-panes";
import { resetCrashReporterForTests } from "../telemetry/crash-reports";
import { setCliAsciiLocaleOverride, setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride } from "../utils/cli-output";

/**
 * `bun test` runs every file in one process, so module state outlives the file
 * that set it. A crash report queued while no reporter is installed, such as a
 * plugin that fails to register in an app runtime test, would wait in the
 * queue and go out with the next reporter another file installs, and its key
 * would keep a later identical report from being queued at all. Every test
 * starts with no reporter, an empty queue and nothing seen.
 *
 * Commands also keep output overrides for the process: a parity test that
 * runs --plain would otherwise make a later serializer test keep empty
 * columns. Start each test with the default output modes and terminal width.
 *
 * Data warnings the user has opened are remembered the same way, and would
 * leave a later test's footer icon muted instead of warning yellow. So are the
 * listings search answered, which would name a later test's symbol before its
 * own search does, and so are panes still waiting on a ticker lookup, which
 * would show a later test's pane as loading. An install experiment's arm is
 * asked once a session, and would answer a later test from the first.
 */
beforeEach(() => {
  resetCrashReporterForTests();
  resetSeenPaneNoticesForTest();
  resetListingIndexForTests();
  resetOpeningTickerPanesForTests();
  resetInstallExperimentsForTests();
  setCliAsciiLocaleOverride(null);
  setCliColorEnabledOverride(null);
  setCliPlainOverride(null);
  setCliWidthOverride(null);
});
