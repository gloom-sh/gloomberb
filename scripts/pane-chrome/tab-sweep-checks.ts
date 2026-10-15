import { evaluate, frames, waitFor, type Cdp } from "./browser";
import { TAB_SWEEP_REVEALS, TAB_SWEEP_SHOWS_HIDDEN, TAB_SWEEP_STUCK, TAB_SWEEP_TABS } from "./tab-sweep-fixture";
import { pathName, visitAlternatives, type Alternative } from "./tab-visits";

/**
 * The layout sweep counts a tab as measured only once it is the selected one
 * (tab-visits.ts). On tab-sweep-fixture.tsx: every one of 25 tabs in a strip
 * too narrow to show them is opened and what shows is that tab's view; the
 * repeated label is told apart; a choice mounted but hidden until a tab shows
 * it is opened under that tab; the tab that ignores a press is reported as
 * not measured rather than recorded as its view; the disabled one and the
 * choice three presses deep are listed as skipped; nothing is dropped.
 */

interface TabSweepStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

const SCOPE = "[data-gloom-pane-id=tab-sweep]";

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

async function reload(cdp: Cdp): Promise<void> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.reload", {});
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) fail("the tab-sweep fixture did not render");
  await frames(cdp, 2);
}

/** What the fixture should say is showing after `path`. */
function expected(path: Alternative[]): string {
  let tab = "Tab 01", other = "other", inner = "inner-1", kept = "kept-1";
  for (const alternative of path) {
    if (alternative.id.startsWith("[Tab 01|Tab 02")) tab = alternative.label;
    else if (alternative.id.startsWith("[Tab 01|Other]")) other = alternative.label === "Other" ? "other" : "first";
    else if (alternative.id.startsWith("[Inner 1|Inner 2]")) inner = alternative.label === "Inner 2" ? "inner-2" : "inner-1";
    else if (alternative.id.startsWith("[Kept 1|Kept 2]")) kept = alternative.label === "Kept 2" ? "kept-2" : "kept-1";
  }
  return `tab=${tab} other=${other} inner=${tab === TAB_SWEEP_REVEALS ? inner : "-"} kept=${tab === TAB_SWEEP_SHOWS_HIDDEN ? kept : "-"}`;
}

export const tabSweepSteps: TabSweepStep[] = [{
  name: "layout sweep: every tab in an overflowing strip of 25 is opened and confirmed, a press that does nothing is reported, nothing is dropped",
  scenario: "tab-sweep",
  async run(cdp) {
    const wrong: string[] = [];
    const recorded: string[] = [];
    const visits = await visitAlternatives({
      cdp,
      scope: SCOPE,
      reset: () => reload(cdp),
      settle: () => frames(cdp, 3),
      record: async (path) => {
        const shows = await evaluate<string>(cdp, `document.querySelector("[data-sweep-shows]")?.textContent ?? ""`);
        recorded.push(pathName(path));
        if (shows !== expected(path)) wrong.push(`${pathName(path)}: shows "${shows}", expected "${expected(path)}"`);
        return true;
      },
    });
    if (wrong.length) fail("a recorded view is not the one its name says", wrong);
    const measured = visits.filter((visit) => visit.status === "measured").map((visit) => pathName(visit.path));
    const unmeasured = visits.filter((visit) => visit.status === "unmeasured");
    const skipped = visits.filter((visit) => visit.status === "skipped");
    // Every tab but the one showing and the stuck one, the repeated label in the choice, and the inner choice under Tab 05.
    const tabs = TAB_SWEEP_TABS.filter((label) => label !== "Tab 01" && label !== TAB_SWEEP_STUCK);
    // Kept 2 was mounted but hidden at first: it is opened under Tab 20, not left as skipped.
    const want = [...tabs, "Tab 01 [2.1]", `${TAB_SWEEP_REVEALS} > Inner 2`, `${TAB_SWEEP_SHOWS_HIDDEN} > Kept 2`];
    const missing = want.filter((name) => !measured.includes(name));
    if (missing.length || measured.length !== want.length) fail("the sweep did not open exactly every reachable view", { missing, measured });
    if (unmeasured.length !== 1 || pathName(unmeasured[0]!.path) !== TAB_SWEEP_STUCK || !/not selected/.test(unmeasured[0]!.reason ?? "")) {
      fail("the press that changed nothing is not reported as not measured", unmeasured);
    }
    const skippedNames = skipped.map((visit) => `${pathName(visit.path)}: ${visit.reason}`);
    if (skipped.length !== 2 || !skippedNames.some((name) => name.startsWith("Locked: disabled")) || !skippedNames.some((name) => name.startsWith(`${TAB_SWEEP_REVEALS} > Inner 2 > Deep 2: revealed 3 presses deep`))) {
      fail("the disabled tab and the choice three presses deep are not listed as skipped", skippedNames);
    }
    if (recorded.length !== measured.length) fail("a view was recorded that the sweep does not count", { recorded, measured });
  },
}];
